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

const axiosMock = {
	get(url: string) {
		requestedUrl = url;
		return Promise.resolve({
			data: nextImageBytes,
			headers: { 'content-type': 'image/jpeg' },
		});
	},
};

const loggerMock = {
	info() {},
	warn(...args: unknown[]) {
		warnMessages.push(args);
	},
	error() {},
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
	if (request === 'axios') return axiosMock;
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
}

main()
	.then(() => {
		fs.rmSync(userDataPath, { recursive: true, force: true });
	})
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
		fs.rmSync(userDataPath, { recursive: true, force: true });
	});
