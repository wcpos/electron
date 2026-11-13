import assert from 'assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Module from 'module';

const readyListeners: (() => void)[] = [];
const privilegedSchemeCalls: { scheme: string; privileges: Record<string, boolean> }[][] = [];
const serveCalls: { scheme?: string; partition?: string }[] = [];
const moduleLoadOrder: string[] = [];
type ImageRequest = { url: string; headers: Headers; initiatorOrigin?: string };
let imageHandler: ((request: ImageRequest) => Promise<Response>) | undefined;
let requestedUrl: string | undefined;
let nextImageBytes = Buffer.from('image-bytes');
const warnMessages: unknown[][] = [];
const errorMessages: unknown[][] = [];
const fetchCounts = new Map<string, number>();
const statusByUrl = new Map<string, number>();
const contentTypeByUrl = new Map<string, string>();
const fetchErrorByUrl = new Map<string, unknown>();
const clearStorageDataCalls: unknown[] = [];
let protocolHandleCalls = 0;
// Required with the module mocks in place, in main().
let appOrigin: () => string;
const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wcpos-image-cache-test-'));

const electronMock = {
	app: {
		on(event: string, listener: () => void) {
			if (event === 'ready') {
				readyListeners.push(listener);
			}
		},
		getPath(name: string) {
			assert.equal(name, 'userData');
			return userDataPath;
		},
	},
	protocol: {
		handle(scheme: string, handler: (request: ImageRequest) => Promise<Response>) {
			assert.equal(scheme, 'wcpos-image');
			protocolHandleCalls += 1;
			imageHandler = handler;
		},
		registerSchemesAsPrivileged(
			schemes: { scheme: string; privileges: Record<string, boolean> }[]
		) {
			privilegedSchemeCalls.push(schemes);
		},
	},
	session: {
		defaultSession: {
			// Rejects, to prove a failed clear cannot stop the handler registering.
			clearStorageData(options: unknown) {
				clearStorageDataCalls.push(options);
				return Promise.reject(new Error('simulated clearStorageData failure'));
			},
		},
	},
};

const electronServeMock = (options: { scheme?: string; partition?: string }) => {
	moduleLoadOrder.push(options.scheme || 'app');
	serveCalls.push(options);
	return async () => {};
};

const imageBytes = Buffer.from('image-bytes');

// downloadImage now uses the global fetch (net.fetch after app ready).
const originalFetch = globalThis.fetch;
globalThis.fetch = ((url: string | URL | Request) => {
	requestedUrl = String(url);
	fetchCounts.set(requestedUrl, (fetchCounts.get(requestedUrl) ?? 0) + 1);
	if (fetchErrorByUrl.has(requestedUrl)) {
		return Promise.reject(fetchErrorByUrl.get(requestedUrl));
	}
	const status = statusByUrl.get(requestedUrl) ?? 200;
	if (status !== 200) {
		return Promise.resolve(new Response(null, { status }));
	}
	return Promise.resolve(
		new Response(Uint8Array.from(nextImageBytes), {
			status: 200,
			headers: { 'content-type': contentTypeByUrl.get(requestedUrl) ?? 'image/jpeg' },
		})
	);
}) as typeof globalThis.fetch;

const loggerMock = {
	debug() {},
	info() {},
	warn(...args: unknown[]) {
		warnMessages.push(args);
	},
	error(...args: unknown[]) {
		errorMessages.push(args);
	},
};

async function waitFor(condition: () => boolean, message: string) {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	throw new Error(message);
}

/**
 * Real Electron delivers protocol.handle requests WITHOUT the renderer's
 * Origin/Referer headers (verified empirically on Electron 41: they arrive
 * as null for both fetch() and <img> loads). Model that here so the tests
 * cannot pass with header-based gating that would reject every real request.
 * Electron does set initiatorOrigin, outside the page's control; the app's own
 * requests carry appOrigin().
 */
const requestFromRenderer = (encodedUrl: string, host = 'cache'): ImageRequest => ({
	url: `wcpos-image://${host}/${encodedUrl}`,
	headers: new Headers(),
	initiatorOrigin: appOrigin(),
});

/**
 * Every response, whatever its status, names the app origin (never `*`), so a
 * store page in the checkout iframe cannot read it, and cannot run as a document.
 */
function assertLockedHeaders(response: Response, kind: string) {
	assert.equal(
		response.headers.get('Access-Control-Allow-Origin'),
		'wcpos://-',
		`${kind}: only the app document may read the response`
	);
	assert.equal(
		response.headers.get('Content-Security-Policy'),
		"sandbox; default-src 'none'",
		`${kind}: the response must not run as a document`
	);
	assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff', `${kind}: nosniff`);
}

/**
 * Runs `run` with fs.promises.rename failing the next `times` calls (Infinity:
 * every call) with a Node-style system error carrying `code`, optionally only
 * renames onto a `.json` target. Returns the number of rename attempts.
 */
async function withRenameFailure(
	code: string,
	times: number,
	onlyJson: boolean,
	run: () => Promise<void>
): Promise<number> {
	const originalRename = fs.promises.rename;
	let attempts = 0;
	let failuresLeft = times;
	fs.promises.rename = async function patchedRename(from, to) {
		attempts += 1;
		if (failuresLeft > 0 && (!onlyJson || String(to).endsWith('.json'))) {
			failuresLeft -= 1;
			// Like Node's own: the message names both paths.
			throw Object.assign(
				new Error(`${code}: simulated, rename '${String(from)}' -> '${String(to)}'`),
				{ code, syscall: 'rename', path: String(from), dest: String(to) }
			);
		}
		return originalRename.call(fs.promises, from, to);
	} as typeof fs.promises.rename;
	try {
		await run();
	} finally {
		fs.promises.rename = originalRename;
	}
	return attempts;
}

type ModuleWithMutableLoad = typeof Module & {
	_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};

const mutableModule = Module as ModuleWithMutableLoad;
const originalLoad = mutableModule._load;
mutableModule._load = function patchedLoad(
	request: string,
	parent: NodeModule | null,
	isMain: boolean
) {
	if (request === 'electron') return electronMock;
	if (request === 'electron-serve') return electronServeMock;
	if (request === './log') return { logger: loggerMock };
	if (request === './window') {
		moduleLoadOrder.push('window');
		return {};
	}
	return originalLoad.call(this, request, parent, isMain);
};

async function main() {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		require('./image-cache');
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		({ appOrigin } = require('./app-origin'));
	} finally {
		mutableModule._load = originalLoad;
	}

	assert.equal(
		privilegedSchemeCalls.length,
		0,
		'image cache must not make a second direct scheme privilege registration'
	);
	assert.deepEqual(
		serveCalls,
		[{ scheme: 'wcpos-image', partition: 'wcpos-image-registration' }],
		'wcpos-image should join electron-serve batching in an isolated registration-only session'
	);
	assert.deepEqual(
		moduleLoadOrder,
		['window', 'wcpos-image'],
		'the packaged app-shell registration must be queued before the image scheme'
	);

	assert.equal(readyListeners.length, 1, 'image cache should register a ready listener');
	readyListeners[0]!();
	assert.ok(imageHandler, 'image cache should register the wcpos-image handler');
	assert.equal(protocolHandleCalls, 1, 'a clearStorageData rejection must not stop registration');
	assert.deepEqual(
		clearStorageDataCalls,
		[{ origin: 'wcpos-image://cache', storages: ['serviceworkers'] }],
		'ready should clear any service worker on the handler origin'
	);
	await waitFor(
		() => warnMessages.some((args) => String(args[0]).includes('service workers')),
		'expected a clearStorageData rejection to be logged as a warning'
	);

	const cacheDir = path.join(userDataPath, 'wcpos_dbs', 'image-cache');
	assert.ok(fs.existsSync(cacheDir), 'ready handler should create the cache directory');
	fs.rmSync(cacheDir, { recursive: true, force: true });

	const originalUrl = 'https://demo.wcpos.com/wp-content/uploads/example.jpg';
	const encoded = Buffer.from(originalUrl, 'utf-8').toString('base64url');
	nextImageBytes = imageBytes;
	const response = await imageHandler!(requestFromRenderer(encoded));

	assert.notEqual(
		response.status,
		403,
		'handler must not reject headerless requests — Electron never forwards Origin, so real <img>/fetch requests all look like this'
	);
	assert.equal(response.status, 200, 'handler should recreate a deleted cache directory');
	assert.deepEqual(
		Buffer.from(await response.arrayBuffer()),
		imageBytes,
		'handler should respond with the downloaded image bytes'
	);
	assert.equal(requestedUrl, originalUrl, 'handler should download the decoded URL');
	assertLockedHeaders(response, 'fresh download');
	assert.equal(response.headers.get('Content-Type'), 'image/jpeg');
	assert.equal(response.headers.get('Cache-Control'), 'max-age=31536000');
	assert.ok(fs.existsSync(cacheDir), 'handler should leave the cache directory on disk');

	const hash = crypto.createHash('sha256').update(originalUrl).digest('hex');
	const imagePath = path.join(cacheDir, hash);
	const metaPath = path.join(cacheDir, `${hash}.json`);
	assert.deepEqual(
		fs.readFileSync(imagePath),
		imageBytes,
		'handler should save image bytes exactly'
	);
	const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
	assert.deepEqual(
		metadata,
		{ url: originalUrl, contentType: 'image/jpeg', cachedAt: metadata.cachedAt },
		'handler should save metadata with the source URL and content type'
	);
	assert.equal(typeof metadata.cachedAt, 'number', 'handler should save the cache timestamp');

	const staleUrl = 'https://demo.wcpos.com/wp-content/uploads/stale.jpg';
	const staleHash = crypto.createHash('sha256').update(staleUrl).digest('hex');
	const staleImagePath = path.join(cacheDir, staleHash);
	const staleMetaPath = path.join(cacheDir, `${staleHash}.json`);
	const staleBytes = Buffer.from('stale-image-bytes');
	const refreshedBytes = Buffer.from('refreshed-image-bytes');
	fs.writeFileSync(staleImagePath, staleBytes);
	fs.writeFileSync(
		staleMetaPath,
		JSON.stringify({
			url: staleUrl,
			contentType: 'image/jpeg',
			cachedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
		})
	);

	nextImageBytes = refreshedBytes;
	const originalWriteFileSync = fs.writeFileSync;
	fs.writeFileSync = function patchedWriteFileSync(file, data, options) {
		if (
			String(file).includes(staleHash) &&
			!String(file).endsWith('.json') &&
			Buffer.isBuffer(data) &&
			data.equals(refreshedBytes)
		) {
			originalWriteFileSync.call(fs, file, data, options as any);
			throw new Error('simulated failed refresh write');
		}

		return originalWriteFileSync.call(fs, file, data, options as any);
	} as typeof fs.writeFileSync;

	try {
		const staleEncoded = Buffer.from(staleUrl, 'utf-8').toString('base64url');
		const staleResponse = await imageHandler!(requestFromRenderer(staleEncoded));
		assert.equal(staleResponse.status, 200, 'stale cache response should still be served');
		assertLockedHeaders(staleResponse, 'stale cached');
		assert.deepEqual(
			Buffer.from(await staleResponse.arrayBuffer()),
			staleBytes,
			'stale cache response should use the existing cached bytes'
		);
		await waitFor(
			() =>
				warnMessages.some((args) => String(args[0]).includes('Background image refresh failed')),
			'expected failed background refresh to be logged'
		);
	} finally {
		fs.writeFileSync = originalWriteFileSync;
	}

	assert.deepEqual(
		fs.readFileSync(staleImagePath),
		staleBytes,
		'failed stale refresh should not corrupt the existing cached image'
	);

	const failedMetaUrl = 'https://demo.wcpos.com/wp-content/uploads/meta-fail.jpg';
	const failedMetaHash = crypto.createHash('sha256').update(failedMetaUrl).digest('hex');
	const failedMetaImagePath = path.join(cacheDir, failedMetaHash);
	const failedMetaPath = path.join(cacheDir, `${failedMetaHash}.json`);
	const failedMetaBytes = Buffer.from('failed-meta-image-bytes');
	nextImageBytes = failedMetaBytes;

	const originalRename = fs.promises.rename;
	fs.promises.rename = async function patchedRename(oldPath, newPath) {
		if (String(oldPath).includes(failedMetaHash) && String(newPath).endsWith('.json')) {
			throw new Error('simulated failed metadata promotion');
		}

		return originalRename.call(fs.promises, oldPath, newPath);
	} as typeof fs.promises.rename;

	try {
		const failedMetaEncoded = Buffer.from(failedMetaUrl, 'utf-8').toString('base64url');
		const failedMetaResponse = await imageHandler!(requestFromRenderer(failedMetaEncoded));
		assert.equal(
			failedMetaResponse.status,
			200,
			'failed metadata promotion should still serve the download'
		);
		assert.deepEqual(Buffer.from(await failedMetaResponse.arrayBuffer()), failedMetaBytes);
	} finally {
		fs.promises.rename = originalRename;
	}

	assert.equal(
		fs.existsSync(failedMetaImagePath),
		false,
		'failed metadata promotion should remove the promoted image file'
	);
	assert.equal(
		fs.existsSync(failedMetaPath),
		false,
		'failed metadata promotion should not leave metadata behind'
	);

	const entryPaths = (url: string) => {
		const urlHash = crypto.createHash('sha256').update(url).digest('hex');
		return {
			image: path.join(cacheDir, urlHash),
			meta: path.join(cacheDir, `${urlHash}.json`),
			encoded: Buffer.from(url, 'utf-8').toString('base64url'),
		};
	};

	// A 404 is an answer ("no picture"), cached on disk and served without a refetch.
	const missingUrl = 'https://secure.gravatar.com/avatar/abc?s=96&d=404';
	const missing = entryPaths(missingUrl);
	statusByUrl.set(missingUrl, 404);
	errorMessages.length = 0;
	const firstMissing = await imageHandler!(requestFromRenderer(missing.encoded));
	assert.equal(firstMissing.status, 404, 'an origin 404 should be served as a 404');
	assertLockedHeaders(firstMissing, 'negative');
	assert.equal(fs.existsSync(missing.image), false, 'a 404 should not write an image file');
	const missingMeta = JSON.parse(fs.readFileSync(missing.meta, 'utf-8'));
	assert.deepEqual(
		missingMeta,
		{ url: missingUrl, status: 404, cachedAt: missingMeta.cachedAt },
		'a 404 should write a negative-cache meta entry'
	);
	assert.equal(typeof missingMeta.cachedAt, 'number');

	const secondMissing = await imageHandler!(requestFromRenderer(missing.encoded));
	assert.equal(secondMissing.status, 404, 'the negative entry should be served as a 404');
	assertLockedHeaders(secondMissing, 'cached negative');
	assert.equal(fetchCounts.get(missingUrl), 1, 'a fresh negative entry must not refetch');
	assert.equal(
		errorMessages.length,
		0,
		'a 404 is an answer, not an error: nothing logged as error'
	);

	// A stale negative entry is refreshed in the background (the person may have added a picture).
	const addedUrl = 'https://secure.gravatar.com/avatar/def?s=96&d=404';
	const added = entryPaths(addedUrl);
	const addedBytes = Buffer.from('new-gravatar-bytes');
	fs.writeFileSync(
		added.meta,
		JSON.stringify({ url: addedUrl, status: 404, cachedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 })
	);
	nextImageBytes = addedBytes;
	const staleMissing = await imageHandler!(requestFromRenderer(added.encoded));
	assert.equal(staleMissing.status, 404, 'a stale negative entry is still served while refreshing');
	await waitFor(
		() =>
			fs.existsSync(added.image) && !!JSON.parse(fs.readFileSync(added.meta, 'utf-8')).contentType,
		'expected the stale negative entry to be replaced by the picture'
	);
	assert.equal(fetchCounts.get(addedUrl), 1, 'a stale negative entry should refetch once');
	const afterRefresh = await imageHandler!(requestFromRenderer(added.encoded));
	assert.equal(afterRefresh.status, 200, 'the refreshed picture should be served');
	assertLockedHeaders(afterRefresh, 'cached');
	assert.equal(afterRefresh.headers.get('Cache-Control'), 'max-age=31536000');
	assert.deepEqual(Buffer.from(await afterRefresh.arrayBuffer()), addedBytes);

	// A picture that the origin now answers 404 for becomes a negative entry on refresh.
	const removedUrl = 'https://demo.wcpos.com/wp-content/uploads/removed.jpg';
	const removed = entryPaths(removedUrl);
	fs.writeFileSync(removed.image, Buffer.from('old-picture'));
	fs.writeFileSync(
		removed.meta,
		JSON.stringify({
			url: removedUrl,
			contentType: 'image/jpeg',
			cachedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
		})
	);
	statusByUrl.set(removedUrl, 404);
	const staleRemoved = await imageHandler!(requestFromRenderer(removed.encoded));
	assert.equal(staleRemoved.status, 200, 'the stale picture is served while refreshing');
	await waitFor(
		() => !fs.existsSync(removed.image),
		'expected a refresh that 404s to remove the old picture'
	);
	assert.equal(JSON.parse(fs.readFileSync(removed.meta, 'utf-8')).status, 404);

	// A corrupt meta file is a cache miss: fetch again and rewrite the entry.
	const corruptUrl = 'https://secure.gravatar.com/avatar/corrupt?s=96&d=404';
	const corrupt = entryPaths(corruptUrl);
	fs.writeFileSync(corrupt.meta, '{"url":');
	statusByUrl.set(corruptUrl, 404);
	errorMessages.length = 0;
	const corruptResponse = await imageHandler!(requestFromRenderer(corrupt.encoded));
	assert.equal(corruptResponse.status, 404, 'the origin 404 should be served');
	assert.equal(fetchCounts.get(corruptUrl), 1, 'a corrupt meta file should lead to a fetch');
	assert.equal(
		JSON.parse(fs.readFileSync(corrupt.meta, 'utf-8')).status,
		404,
		'the corrupt meta file should be rewritten as a valid entry'
	);
	assert.equal(errorMessages.length, 0, 'a corrupt meta file is a cache miss, not an error');

	// A 5xx is a failure, not an answer: nothing cached, the next request fetches again.
	const brokenUrl = 'https://demo.wcpos.com/wp-content/uploads/broken.jpg';
	const broken = entryPaths(brokenUrl);
	statusByUrl.set(brokenUrl, 500);
	const firstBroken = await imageHandler!(requestFromRenderer(broken.encoded));
	assert.equal(firstBroken.status, 404, 'a 500 still fails the request');
	assertLockedHeaders(firstBroken, 'catch-all 404');
	assert.equal(fs.existsSync(broken.meta), false, 'a 500 must not write a cache entry');
	assert.equal(fs.existsSync(broken.image), false, 'a 500 must not write an image');
	await imageHandler!(requestFromRenderer(broken.encoded));
	assert.equal(fetchCounts.get(brokenUrl), 2, 'a 500 is not cached, so the next request refetches');
	assert.ok(
		errorMessages.some((args) => String(args[0]).includes('Image cache error')),
		'a 500 is still logged as an error'
	);

	// 400s: a payload that is not a URL, a scheme other than http(s), and a host
	// other than `cache`. None of them fetches.
	const fetchesBefore = [...fetchCounts.values()].reduce((a, b) => a + b, 0);
	const badUrl = await imageHandler!(
		requestFromRenderer(Buffer.from('not a url', 'utf-8').toString('base64url'))
	);
	assert.equal(badUrl.status, 400, 'a payload that is not a URL is a 400');
	assertLockedHeaders(badUrl, '400 bad URL');
	const badScheme = await imageHandler!(
		requestFromRenderer(Buffer.from('ftp://demo.wcpos.com/a.jpg', 'utf-8').toString('base64url'))
	);
	assert.equal(badScheme.status, 400, 'a non-http(s) URL is a 400');
	assertLockedHeaders(badScheme, '400 bad scheme');
	const wrongHostUrl = 'https://demo.wcpos.com/wp-content/uploads/wrong-host.jpg';
	const wrongHost = await imageHandler!(
		requestFromRenderer(entryPaths(wrongHostUrl).encoded, 'other')
	);
	assert.equal(wrongHost.status, 400, 'a host other than `cache` is a 400');
	assertLockedHeaders(wrongHost, '400 wrong host');
	assert.equal(fetchCounts.get(wrongHostUrl), undefined, 'a wrong host must not fetch');
	assert.equal(
		[...fetchCounts.values()].reduce((a, b) => a + b, 0),
		fetchesBefore,
		'no 400 fetches anything'
	);

	// Only the app origin is served. A store page (in the checkout iframe, or a
	// worker it starts), an opaque sandboxed child ('null') and a request with no
	// initiator all get an empty 403, before any cache read or download.
	const gatedUrl = 'https://demo.wcpos.com/wp-content/uploads/gated.jpg';
	const gated = entryPaths(gatedUrl);
	const gateWarns = () =>
		warnMessages.filter((args) =>
			String(args[0]).startsWith('Image request refused by origin gate')
		);
	assert.equal(gateWarns().length, 0, 'no refusal yet, so no gate warning yet');
	const refusedOrigins: [string, string | undefined][] = [
		['store origin', 'http://127.0.0.1:8080'],
		['opaque origin', 'null'],
		['absent origin', undefined],
	];
	for (const [kind, initiatorOrigin] of refusedOrigins) {
		for (const host of ['cache', 'other']) {
			const refused = await imageHandler!({
				url: `wcpos-image://${host}/${gated.encoded}`,
				headers: new Headers(),
				...(initiatorOrigin === undefined ? {} : { initiatorOrigin }),
			});
			assert.equal(refused.status, 403, `${kind}, host ${host}: refused whatever the URL`);
			assert.equal((await refused.arrayBuffer()).byteLength, 0, `${kind}: empty body`);
			assertLockedHeaders(refused, `403 ${kind}`);
		}
	}
	assert.deepEqual(
		gateWarns(),
		[
			[
				'Image request refused by origin gate (logged once per run):',
				'http://<host redacted>',
				'expected',
				'wcpos://-',
			],
		],
		'the first refusal of the run (the store origin) is logged once, host redacted'
	);
	assert.equal(fetchCounts.get(gatedUrl), undefined, 'a refused request must not download');
	assert.equal(fs.existsSync(gated.image), false, 'a refused request must not cache an image');
	assert.equal(fs.existsSync(gated.meta), false, 'a refused request must not cache meta');
	nextImageBytes = imageBytes;
	const served = await imageHandler!(requestFromRenderer(gated.encoded));
	assert.equal(served.status, 200, 'the app origin is still served');
	assert.deepEqual(Buffer.from(await served.arrayBuffer()), imageBytes);
	assert.equal(fetchCounts.get(gatedUrl), 1, 'the same URL downloads for the app origin');

	// Content-Type: only image/* passes through; anything else is served as
	// octet-stream so it cannot be rendered as a document.
	const htmlUrl = 'https://demo.wcpos.com/wp-content/uploads/page.html';
	contentTypeByUrl.set(htmlUrl, 'text/html');
	const freshHtml = await imageHandler!(requestFromRenderer(entryPaths(htmlUrl).encoded));
	assert.equal(freshHtml.status, 200, 'a non-image is still served, not refused');
	assert.equal(freshHtml.headers.get('Content-Type'), 'application/octet-stream');
	assertLockedHeaders(freshHtml, 'fresh text/html');

	// An entry already on disk from before this check, written with text/html.
	const oldHtmlUrl = 'https://demo.wcpos.com/wp-content/uploads/old-page.html';
	const oldHtml = entryPaths(oldHtmlUrl);
	fs.writeFileSync(oldHtml.image, Buffer.from('<script>alert(1)</script>'));
	fs.writeFileSync(
		oldHtml.meta,
		JSON.stringify({ url: oldHtmlUrl, contentType: 'text/html', cachedAt: Date.now() })
	);
	const cachedHtml = await imageHandler!(requestFromRenderer(oldHtml.encoded));
	assert.equal(cachedHtml.status, 200);
	assert.equal(cachedHtml.headers.get('Content-Type'), 'application/octet-stream');
	assert.equal(fetchCounts.get(oldHtmlUrl), undefined, 'a fresh cache hit does not refetch');
	assertLockedHeaders(cachedHtml, 'cached text/html');

	for (const contentType of ['IMAGE/PNG', 'image/svg+xml']) {
		const imageUrl = `https://demo.wcpos.com/wp-content/uploads/${encodeURIComponent(contentType)}`;
		contentTypeByUrl.set(imageUrl, contentType);
		const fresh = await imageHandler!(requestFromRenderer(entryPaths(imageUrl).encoded));
		assert.equal(fresh.headers.get('Content-Type'), contentType, `${contentType} passes through`);
		const cached = await imageHandler!(requestFromRenderer(entryPaths(imageUrl).encoded));
		assert.equal(cached.headers.get('Content-Type'), contentType, `cached ${contentType} too`);
		assert.equal(fetchCounts.get(imageUrl), 1);
	}

	// A good download is served even when the cache write fails (Windows
	// EPERM/EBUSY/EACCES on rename). Each case uses its own URL.
	const uploadUrl = (name: string) => `https://demo.wcpos.com/wp-content/uploads/${name}.jpg`;
	const tmpFiles = () => fs.readdirSync(cacheDir).filter((name) => name.endsWith('.tmp'));
	const writeFailedWarns = (from: number) =>
		warnMessages
			.slice(from)
			.filter((args) => String(args[0]).startsWith('Image cache write failed'));
	const logsFrom = { warn: warnMessages.length, error: errorMessages.length };

	// T1: transient EPERM is retried and the entry is cached.
	const transient = entryPaths(uploadUrl('transient-eperm'));
	const transientBytes = Buffer.from('transient-bytes');
	nextImageBytes = transientBytes;
	let transientResponse: Response | undefined;
	const transientAttempts = await withRenameFailure('EPERM', 2, false, async () => {
		transientResponse = await imageHandler!(requestFromRenderer(transient.encoded));
	});
	assert.equal(transientResponse!.status, 200, 'T1: a transient EPERM still serves');
	assert.deepEqual(Buffer.from(await transientResponse!.arrayBuffer()), transientBytes);
	assert.ok(fs.existsSync(transient.image), 'T1: the image is cached after the retry');
	assert.ok(fs.existsSync(transient.meta), 'T1: the meta is cached after the retry');
	assert.ok(transientAttempts >= 4, `T1: 2 failures + 2 successes, got ${transientAttempts}`);
	assert.deepEqual(tmpFiles(), [], 'T1: no temp file left');

	// T2: a rename that keeps failing gives up after 6 attempts and serves the download.
	const busyUrl = uploadUrl('persistent-ebusy');
	const busy = entryPaths(busyUrl);
	const busyBytes = Buffer.from('busy-bytes');
	contentTypeByUrl.set(busyUrl, 'image/png');
	nextImageBytes = busyBytes;
	let busyResponse: Response | undefined;
	const busyWarnsFrom = warnMessages.length;
	const busyAttempts = await withRenameFailure('EBUSY', Infinity, false, async () => {
		busyResponse = await imageHandler!(requestFromRenderer(busy.encoded));
	});
	assert.equal(busyResponse!.status, 200, 'T2: a failed cache write still serves the download');
	assert.deepEqual(Buffer.from(await busyResponse!.arrayBuffer()), busyBytes);
	assert.equal(busyResponse!.headers.get('Content-Type'), 'image/png');
	assertLockedHeaders(busyResponse!, 'T2 uncached download');
	assert.equal(busyAttempts, 6, 'T2: the image rename is tried 6 times, then given up');
	const busyWarns = writeFailedWarns(busyWarnsFrom);
	assert.equal(busyWarns.length, 1, 'T2: one write-failed warning');
	assert.ok(busyWarns[0]!.includes('EBUSY rename'), 'T2: the warning names the cause');
	assert.equal(fs.existsSync(busy.image), false, 'T2: no image left');
	assert.equal(fs.existsSync(busy.meta), false, 'T2: no meta left');
	assert.deepEqual(tmpFiles(), [], 'T2: no temp file left');
	const busyAgain = await imageHandler!(requestFromRenderer(busy.encoded));
	assert.equal(busyAgain.status, 200);
	assert.equal(fetchCounts.get(busyUrl), 2, 'T2: the failed write was a cache miss next time');
	assert.ok(fs.existsSync(busy.image) && fs.existsSync(busy.meta), 'T2: cached on the retry');

	// T3: a rename error outside the retry codes is not retried.
	const crossDevice = entryPaths(uploadUrl('non-retryable-exdev'));
	nextImageBytes = imageBytes;
	let crossDeviceResponse: Response | undefined;
	const crossDeviceAttempts = await withRenameFailure('EXDEV', Infinity, false, async () => {
		crossDeviceResponse = await imageHandler!(requestFromRenderer(crossDevice.encoded));
	});
	assert.equal(crossDeviceResponse!.status, 200, 'T3: served');
	assert.equal(crossDeviceAttempts, 1, 'T3: EXDEV is not retried');

	// T4: only the meta rename fails: the promoted image is removed again.
	const metaOnly = entryPaths(uploadUrl('meta-only-eacces'));
	let metaOnlyResponse: Response | undefined;
	await withRenameFailure('EACCES', Infinity, true, async () => {
		metaOnlyResponse = await imageHandler!(requestFromRenderer(metaOnly.encoded));
	});
	assert.equal(metaOnlyResponse!.status, 200, 'T4: served');
	assert.equal(fs.existsSync(metaOnly.image), false, 'T4: the promoted image was removed');
	assert.equal(fs.existsSync(metaOnly.meta), false, 'T4: no meta left');
	assert.deepEqual(tmpFiles(), [], 'T4: no temp file left');

	// T5: the 404 marker cannot be written: still a 404, and the cause is logged.
	const markerUrl = uploadUrl('marker-eperm');
	const marker = entryPaths(markerUrl);
	statusByUrl.set(markerUrl, 404);
	const markerWarnsFrom = warnMessages.length;
	let markerResponse: Response | undefined;
	await withRenameFailure('EPERM', Infinity, false, async () => {
		markerResponse = await imageHandler!(requestFromRenderer(marker.encoded));
	});
	assert.equal(markerResponse!.status, 404, 'T5: the origin 404 is still served');
	assert.equal(writeFailedWarns(markerWarnsFrom).length, 1, 'T5: the failed write is logged');
	assert.equal(fs.existsSync(marker.meta), false, 'T5: no marker left');

	// T6: an HTTP 500 is logged with its stage and cause.
	const serverErrorUrl = uploadUrl('download-500');
	statusByUrl.set(serverErrorUrl, 500);
	const serverErrorFrom = errorMessages.length;
	const serverError = await imageHandler!(requestFromRenderer(entryPaths(serverErrorUrl).encoded));
	assert.equal(serverError.status, 404, 'T6: a 500 is a 404 to the app');
	const serverErrors = errorMessages
		.slice(serverErrorFrom)
		.filter((args) => String(args[0]).startsWith('Image cache error:'));
	assert.equal(serverErrors.length, 1, 'T6: one error');
	assert.ok(serverErrors[0]!.includes('download'), 'T6: the stage is named');
	assert.ok(serverErrors[0]!.includes('Error: Image download failed: HTTP 500'), 'T6: the cause');

	// T7: a network failure names the system error behind it, not its message.
	const offlineUrl = uploadUrl('network-failure');
	// As undici's: new TypeError('fetch failed', { cause }). The tsconfig's ES6 lib
	// has no ErrorOptions, so the cause is attached by hand.
	fetchErrorByUrl.set(
		offlineUrl,
		Object.assign(new TypeError('fetch failed'), {
			cause: Object.assign(new Error('getaddrinfo ENOTFOUND demo.wcpos.com'), {
				code: 'ENOTFOUND',
				syscall: 'getaddrinfo',
			}),
		})
	);
	const offlineFrom = errorMessages.length;
	const offline = await imageHandler!(requestFromRenderer(entryPaths(offlineUrl).encoded));
	assert.equal(offline.status, 404, 'T7: a network failure is a 404 to the app');
	const offlineErrors = errorMessages.slice(offlineFrom);
	assert.equal(offlineErrors.length, 1, 'T7: one error');
	assert.ok(
		offlineErrors[0]!.includes('TypeError: fetch failed (cause: ENOTFOUND getaddrinfo)'),
		'T7: the cause is named without the host'
	);

	// T8: refusals after the first one are not logged.
	const gatedAgain = entryPaths(uploadUrl('gated-again'));
	for (const initiatorOrigin of [
		'https://store.example.com',
		'https://store.example.com',
		undefined,
	]) {
		const refused = await imageHandler!({
			url: `wcpos-image://cache/${gatedAgain.encoded}`,
			headers: new Headers(),
			...(initiatorOrigin === undefined ? {} : { initiatorOrigin }),
		});
		assert.equal(refused.status, 403, 'T8: refused');
	}
	assert.equal(gateWarns().length, 1, 'T8: the gate logs only the first refusal of the run');

	// T9: none of the new log lines carries a host, a path or a temp file name.
	const newLogLines = [
		...warnMessages.slice(logsFrom.warn),
		...errorMessages.slice(logsFrom.error),
		...gateWarns(),
	].filter((args) =>
		['Image cache write failed', 'Image cache error:', 'Image request refused'].some((prefix) =>
			String(args[0]).startsWith(prefix)
		)
	);
	assert.ok(newLogLines.length >= 5, 'T9: the cases above logged their failures');
	for (const args of newLogLines) {
		for (const arg of args) {
			const text = String(arg);
			for (const forbidden of ['demo.wcpos.com', 'store.example.com', userDataPath]) {
				assert.ok(!text.includes(forbidden), `T9: log argument leaks ${forbidden}: ${text}`);
			}
			assert.ok(!/\.tmp\b/.test(text), `T9: log argument names a temp file: ${text}`);
		}
	}
}

main()
	.then(() => {
		globalThis.fetch = originalFetch;
		fs.rmSync(userDataPath, { recursive: true, force: true });
	})
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
		globalThis.fetch = originalFetch;
		fs.rmSync(userDataPath, { recursive: true, force: true });
	});
