import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { app, protocol, session } from 'electron';
import serve from 'electron-serve';

import './window';
import { appOrigin } from './app-origin';
import { getImageCachePath } from './image-cache-path';
import { logger } from './log';

/**
 * A picture entry is the image file plus this meta file. A "no picture" entry
 * is the meta file alone with `status: 404` and no contentType: the origin
 * answered 404, which is a cacheable answer, not an error. The app asks
 * Gravatar for `d=404` so a person with no Gravatar falls back to their
 * initials; any other missing upload is the same answer.
 */
interface CacheMeta {
	url: string;
	contentType?: string;
	cachedAt: number;
	status?: typeof NOT_FOUND_STATUS;
}

// Only a 404 is cached as "no picture". 5xx, timeouts and network failures
// stay failures: they say nothing about whether the picture exists.
const NOT_FOUND_STATUS = 404;

type DownloadResult = { kind: 'image'; buffer: Buffer; contentType: string } | { kind: 'missing' };

/**
 * The wcpos-image:// scheme must be fetchable from the renderer: the thermal
 * receipt pipeline fetches cached logos and converts them to data URLs so
 * canvas.getImageData() can rasterize them without tainting the canvas (see
 * packages/printer thermal-print.ts). Without supportFetchAPI the renderer's
 * fetch() throws, the <img> fallback taints the canvas, and logos are silently
 * dropped from printed receipts.
 *
 * The checkout and receipt iframes load store pages in this same default
 * session. What stops a script there reading any URL through this handler is
 * the handler's own origin gate: anything not issued by the app origin gets an
 * empty 403. Access-Control-Allow-Origin cannot do it, because Electron does
 * not enforce CORS on protocol.handle schemes, and webRequest.onBeforeRequest
 * cannot either, because it never fires for a dedicated worker's fetch(). The
 * ACAO value (appOrigin(), never `*`) is defence in depth only, should a later
 * Electron enforce it. The sandbox CSP, nosniff and the image-only
 * Content-Type stop a response running as a document or script.
 *
 * electron-serve batches synchronous serve() calls into Electron's single
 * registerSchemesAsPrivileged call. Registering this scheme through the same
 * API avoids a second direct registration. The explicit window import queues
 * the packaged app-shell scheme first. Its static handler lives in an in-memory
 * partition that no window uses; the real handler below stays in the default
 * session.
 */
serve({ scheme: 'wcpos-image', partition: 'wcpos-image-registration' });

const STALE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function getCacheDir(): string {
	const base = getImageCachePath();
	if (!fs.existsSync(base)) {
		fs.mkdirSync(base, { recursive: true });
	}
	return base;
}

function urlToHash(url: string): string {
	return crypto.createHash('sha256').update(url).digest('hex');
}

function getTempPath(targetPath: string): string {
	return path.join(
		path.dirname(targetPath),
		`.${path.basename(targetPath)}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`
	);
}

function removeIfExists(filePath: string): void {
	try {
		fs.unlinkSync(filePath);
	} catch (err: any) {
		if (err?.code !== 'ENOENT') {
			logger.warn('Failed to remove temporary image cache file:', filePath, err.message);
		}
	}
}

// Windows: antivirus, the search indexer or a parallel request renaming onto the
// same target hold the file briefly. Retry those codes only; total wait ~770 ms.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_RETRY_DELAYS_MS = [20, 50, 100, 200, 400];

async function renameWithRetry(from: string, to: string): Promise<void> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			// Looked up per call: the test patches fs.promises.rename.
			await fs.promises.rename(from, to);
			return;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException)?.code;
			const delay = RENAME_RETRY_DELAYS_MS[attempt];
			if (delay === undefined || !code || !RENAME_RETRY_CODES.has(code)) {
				throw err;
			}
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}
}

const URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi;

function describeOneError(err: unknown): string {
	const { code, syscall } = (err ?? {}) as { code?: unknown; syscall?: unknown };
	if (typeof code === 'string') {
		// A Node system error's message carries both paths: never log it.
		return `${code}${syscall ? ' ' + syscall : ''}`;
	}
	const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
	return text.replace(URL_PATTERN, '<url>');
}

/** The cause of a failure, for the log: no URLs, no filesystem paths. */
function describeError(err: unknown): string {
	const cause = (err as { cause?: unknown } | undefined)?.cause;
	const base = describeOneError(err);
	return cause === undefined ? base : `${base} (cause: ${describeOneError(cause)})`;
}

async function writeCacheEntry(
	imagePath: string,
	metaPath: string,
	buffer: Buffer,
	contentType: string,
	url: string
): Promise<void> {
	fs.mkdirSync(path.dirname(imagePath), { recursive: true });

	const imageTempPath = getTempPath(imagePath);
	const metaTempPath = getTempPath(metaPath);
	let imagePromoted = false;

	try {
		fs.writeFileSync(imageTempPath, buffer);
		fs.writeFileSync(
			metaTempPath,
			JSON.stringify({ url, contentType, cachedAt: Date.now() } satisfies CacheMeta)
		);
		await renameWithRetry(imageTempPath, imagePath);
		imagePromoted = true;
		await renameWithRetry(metaTempPath, metaPath);
	} catch (err) {
		removeIfExists(imageTempPath);
		removeIfExists(metaTempPath);
		if (imagePromoted) {
			removeIfExists(imagePath);
		}
		throw err;
	}
}

/**
 * Record "no picture" for a URL. The meta file is promoted first so a reader
 * that races the removal of an older picture already sees the 404 marker.
 */
async function writeMissingEntry(imagePath: string, metaPath: string, url: string): Promise<void> {
	fs.mkdirSync(path.dirname(metaPath), { recursive: true });

	const metaTempPath = getTempPath(metaPath);
	try {
		fs.writeFileSync(
			metaTempPath,
			JSON.stringify({ url, status: NOT_FOUND_STATUS, cachedAt: Date.now() } satisfies CacheMeta)
		);
		await renameWithRetry(metaTempPath, metaPath);
	} catch (err) {
		removeIfExists(metaTempPath);
		throw err;
	}
	removeIfExists(imagePath);
}

async function writeDownloadResult(
	imagePath: string,
	metaPath: string,
	result: DownloadResult,
	url: string
): Promise<void> {
	if (result.kind === 'missing') {
		await writeMissingEntry(imagePath, metaPath, url);
		logger.debug('Image not found, cached as no picture:', url);
		return;
	}
	await writeCacheEntry(imagePath, metaPath, result.buffer, result.contentType, url);
}

/**
 * A missing, truncated or unparseable meta file is a cache miss, not an error:
 * the caller downloads again and a good download rewrites the entry. A
 * negative entry has no image file to fall back on, so throwing here would
 * fail every request for that URL until the file was removed by hand.
 */
function readMeta(metaPath: string): CacheMeta | undefined {
	try {
		return JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as CacheMeta;
	} catch {
		return undefined;
	}
}

/** Headers for every response from the handler. */
function responseHeaders(extra: Record<string, string> = {}): Record<string, string> {
	return {
		...extra,
		'Access-Control-Allow-Origin': appOrigin(),
		'Content-Security-Policy': "sandbox; default-src 'none'",
		'X-Content-Type-Options': 'nosniff',
	};
}

/**
 * Applied when serving, not when writing, so entries cached before this check
 * are covered. Not a refusal: buckets that label images binary/octet-stream
 * must keep rendering.
 */
function servedContentType(contentType: string): string {
	return contentType.toLowerCase().startsWith('image/') ? contentType : 'application/octet-stream';
}

let gateRefusalLogged = false;

/** Store hosts are redacted; 'null', wcpos://, file:// and the like are not store hosts. */
function describeOrigin(o: string | undefined): string {
	if (o === undefined) return '(none)';
	try {
		const { protocol } = new URL(o);
		if (protocol === 'http:' || protocol === 'https:') return `${protocol}//<host redacted>`;
	} catch {
		// 'null' does not parse; it is logged as it is.
	}
	return o.slice(0, 100);
}

function emptyResponse(status: number): Response {
	return new Response(null, { status, headers: responseHeaders() });
}

function notFoundResponse(): Response {
	return emptyResponse(NOT_FOUND_STATUS);
}

/**
 * Set by Electron from the requesting context, workers included; the page
 * cannot set it. Absent when the browser started the request itself.
 */
function requestingOrigin(request: Request): string | undefined {
	return (request as Request & { initiatorOrigin?: string }).initiatorOrigin;
}

/**
 * Deduplicate in-flight downloads so multiple <img> tags requesting the
 * same uncached image don't trigger parallel downloads.
 */
const inFlight = new Map<string, Promise<DownloadResult>>();

async function downloadImage(url: string): Promise<DownloadResult> {
	const existing = inFlight.get(url);
	if (existing) return existing;

	// Global fetch is net.fetch after app ready (see index.ts): image downloads
	// honor the system proxy and OS trust store like the rest of the app.
	const promise = (async () => {
		const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
		if (response.status === NOT_FOUND_STATUS) {
			return { kind: 'missing' } as const;
		}
		if (!response.ok) {
			throw new Error(`Image download failed: HTTP ${response.status}`);
		}
		const contentType = response.headers.get('content-type') || 'image/jpeg';
		return {
			kind: 'image',
			buffer: Buffer.from(await response.arrayBuffer()),
			contentType,
		} as const;
	})().finally(() => {
		inFlight.delete(url);
	});

	inFlight.set(url, promise);
	return promise;
}

function refreshInBackground(url: string, imagePath: string, metaPath: string): void {
	downloadImage(url)
		.then((result) => writeDownloadResult(imagePath, metaPath, result, url))
		.catch((err) => {
			logger.warn('Background image refresh failed:', url, describeError(err));
		});
}

app.on('ready', () => {
	getCacheDir();

	// The scheme allows service workers, and one installed on this origin before
	// the headers above existed would outlive them. Clear it on every start.
	session.defaultSession
		.clearStorageData({ origin: 'wcpos-image://cache', storages: ['serviceworkers'] })
		.catch((err) => {
			logger.warn('Failed to clear wcpos-image service workers:', err?.message);
		});

	// Do NOT gate on request headers here: Electron does not forward the
	// renderer's Origin/Referer headers to protocol.handle handlers (they
	// arrive as null), so header-based origin checks reject every real
	// request. Plain <img> loads are no-cors and would never send Origin
	// even if headers were forwarded. See wcpos/electron#298 follow-up.
	// initiatorOrigin is not a header: Electron sets it, the page cannot.
	protocol.handle('wcpos-image', async (request) => {
		// First, before parsing or the cache, so every refusal looks the same and
		// a store page cannot probe the cache or make the app fetch. Only the first
		// refusal per run is logged: a store page could flood the log.
		const origin = requestingOrigin(request);
		if (origin !== appOrigin()) {
			if (!gateRefusalLogged) {
				gateRefusalLogged = true;
				logger.warn(
					'Image request refused by origin gate (logged once per run):',
					describeOrigin(origin),
					'expected',
					appOrigin()
				);
			}
			return emptyResponse(403);
		}
		// Declared outside the try so the catch can name the stage that failed.
		let stage = 'request';
		try {
			const parsed = new URL(request.url);
			if (parsed.hostname !== 'cache') {
				return emptyResponse(400);
			}
			const encodedUrl = parsed.pathname.replace(/^\//, '');
			const originalUrl = Buffer.from(encodedUrl, 'base64url').toString('utf-8');

			// Basic validation: only fetch HTTP/HTTPS URLs
			let validatedUrl: URL;
			try {
				validatedUrl = new URL(originalUrl);
			} catch {
				return emptyResponse(400);
			}
			if (validatedUrl.protocol !== 'http:' && validatedUrl.protocol !== 'https:') {
				return emptyResponse(400);
			}

			const cacheDir = getCacheDir();
			const hash = urlToHash(originalUrl);
			const imagePath = path.join(cacheDir, hash);
			const metaPath = path.join(cacheDir, `${hash}.json`);

			// Serve from cache if exists. Stale-while-revalidate applies to both
			// entry kinds: serve what is cached, refresh in the background, so a
			// person who adds a picture later gets it.
			stage = 'cache-read';
			const meta = readMeta(metaPath);
			const isStale = meta !== undefined && Date.now() - meta.cachedAt > STALE_AGE_MS;

			if (meta?.status === NOT_FOUND_STATUS) {
				if (isStale) {
					refreshInBackground(originalUrl, imagePath, metaPath);
				}
				return notFoundResponse();
			}

			if (meta?.contentType && fs.existsSync(imagePath)) {
				const body = fs.readFileSync(imagePath);

				if (isStale) {
					refreshInBackground(originalUrl, imagePath, metaPath);
				}

				return new Response(body, {
					status: 200,
					headers: responseHeaders({
						'Content-Type': servedContentType(meta.contentType),
						'Cache-Control': 'max-age=31536000',
					}),
				});
			}

			// Download and cache. A failed cache write is only a cache miss next
			// time: serve the good download anyway.
			stage = 'download';
			const result = await downloadImage(originalUrl);

			try {
				await writeDownloadResult(imagePath, metaPath, result, originalUrl);
			} catch (err) {
				logger.warn('Image cache write failed, serving the download uncached:', describeError(err));
			}
			if (result.kind === 'missing') {
				return notFoundResponse();
			}
			const { buffer, contentType } = result;

			return new Response(
				buffer.buffer.slice(
					buffer.byteOffset,
					buffer.byteOffset + buffer.byteLength
				) as ArrayBuffer,
				{
					status: 200,
					headers: responseHeaders({
						'Content-Type': servedContentType(contentType),
						'Cache-Control': 'max-age=31536000',
					}),
				}
			);
		} catch (err) {
			logger.error('Image cache error:', stage, describeError(err));
			return emptyResponse(404);
		}
	});

	logger.info('Image cache protocol handler registered');
});
