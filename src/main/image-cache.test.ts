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
type ImageRequest = { url: string; headers: Headers };
let imageHandler: ((request: ImageRequest) => Promise<Response>) | undefined;
let requestedUrl: string | undefined;
let nextImageBytes = Buffer.from('image-bytes');
const warnMessages: unknown[][] = [];
const errorMessages: unknown[][] = [];
const fetchCounts = new Map<string, number>();
const statusByUrl = new Map<string, number>();
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
			imageHandler = handler;
		},
		registerSchemesAsPrivileged(
			schemes: { scheme: string; privileges: Record<string, boolean> }[]
		) {
			privilegedSchemeCalls.push(schemes);
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
	const status = statusByUrl.get(requestedUrl) ?? 200;
	if (status !== 200) {
		return Promise.resolve(new Response(null, { status }));
	}
	return Promise.resolve(
		new Response(Uint8Array.from(nextImageBytes), {
			status: 200,
			headers: { 'content-type': 'image/jpeg' },
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
 */
const requestFromRenderer = (encodedUrl: string): ImageRequest => ({
	url: `wcpos-image://cache/${encodedUrl}`,
	headers: new Headers(),
});

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
	assert.equal(
		response.headers.get('Access-Control-Allow-Origin'),
		'*',
		'download response must allow cross-origin renderer fetch() (the print pipeline relies on it)'
	);
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
		assert.equal(
			staleResponse.headers.get('Access-Control-Allow-Origin'),
			'*',
			'cached response must allow cross-origin renderer fetch()'
		);
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

	const originalRenameSync = fs.renameSync;
	fs.renameSync = function patchedRenameSync(oldPath, newPath) {
		if (String(oldPath).includes(failedMetaHash) && String(newPath).endsWith('.json')) {
			throw new Error('simulated failed metadata promotion');
		}

		return originalRenameSync.call(fs, oldPath, newPath);
	} as typeof fs.renameSync;

	try {
		const failedMetaEncoded = Buffer.from(failedMetaUrl, 'utf-8').toString('base64url');
		const failedMetaResponse = await imageHandler!(requestFromRenderer(failedMetaEncoded));
		assert.equal(
			failedMetaResponse.status,
			404,
			'failed metadata promotion should fail the request'
		);
	} finally {
		fs.renameSync = originalRenameSync;
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
	assert.equal(
		firstMissing.headers.get('Access-Control-Allow-Origin'),
		'*',
		'a 404 must stay readable by renderer fetch()'
	);
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
	assert.equal(fs.existsSync(broken.meta), false, 'a 500 must not write a cache entry');
	assert.equal(fs.existsSync(broken.image), false, 'a 500 must not write an image');
	await imageHandler!(requestFromRenderer(broken.encoded));
	assert.equal(fetchCounts.get(brokenUrl), 2, 'a 500 is not cached, so the next request refetches');
	assert.ok(
		errorMessages.some((args) => String(args[0]).includes('Image cache error')),
		'a 500 is still logged as an error'
	);
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
