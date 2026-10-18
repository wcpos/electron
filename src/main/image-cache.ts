import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { app, protocol } from 'electron';
import serve from 'electron-serve';

import './window';
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

function writeCacheEntry(
	imagePath: string,
	metaPath: string,
	buffer: Buffer,
	contentType: string,
	url: string
): void {
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
		fs.renameSync(imageTempPath, imagePath);
		imagePromoted = true;
		fs.renameSync(metaTempPath, metaPath);
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
function writeMissingEntry(imagePath: string, metaPath: string, url: string): void {
	fs.mkdirSync(path.dirname(metaPath), { recursive: true });

	const metaTempPath = getTempPath(metaPath);
	try {
		fs.writeFileSync(
			metaTempPath,
			JSON.stringify({ url, status: NOT_FOUND_STATUS, cachedAt: Date.now() } satisfies CacheMeta)
		);
		fs.renameSync(metaTempPath, metaPath);
	} catch (err) {
		removeIfExists(metaTempPath);
		throw err;
	}
	removeIfExists(imagePath);
}

function writeDownloadResult(
	imagePath: string,
	metaPath: string,
	result: DownloadResult,
	url: string
): void {
	if (result.kind === 'missing') {
		writeMissingEntry(imagePath, metaPath, url);
		logger.debug('Image not found, cached as no picture:', url);
		return;
	}
	writeCacheEntry(imagePath, metaPath, result.buffer, result.contentType, url);
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

function notFoundResponse(): Response {
	return new Response(null, {
		status: NOT_FOUND_STATUS,
		headers: { 'Access-Control-Allow-Origin': '*' },
	});
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
		.then((result) => {
			writeDownloadResult(imagePath, metaPath, result, url);
		})
		.catch((err) => {
			logger.warn('Background image refresh failed:', url, err.message);
		});
}

app.on('ready', () => {
	getCacheDir();

	// Do NOT gate on request headers here: Electron does not forward the
	// renderer's Origin/Referer headers to protocol.handle handlers (they
	// arrive as null), so header-based origin checks reject every real
	// request. Plain <img> loads are no-cors and would never send Origin
	// even if headers were forwarded. See wcpos/electron#298 follow-up.
	protocol.handle('wcpos-image', async (request) => {
		try {
			const parsed = new URL(request.url);
			const encodedUrl = parsed.pathname.replace(/^\//, '');
			const originalUrl = Buffer.from(encodedUrl, 'base64url').toString('utf-8');

			// Basic validation: only fetch HTTP/HTTPS URLs
			let validatedUrl: URL;
			try {
				validatedUrl = new URL(originalUrl);
			} catch {
				return new Response(null, { status: 400 });
			}
			if (validatedUrl.protocol !== 'http:' && validatedUrl.protocol !== 'https:') {
				return new Response(null, { status: 400 });
			}

			const cacheDir = getCacheDir();
			const hash = urlToHash(originalUrl);
			const imagePath = path.join(cacheDir, hash);
			const metaPath = path.join(cacheDir, `${hash}.json`);

			// Serve from cache if exists. Stale-while-revalidate applies to both
			// entry kinds: serve what is cached, refresh in the background, so a
			// person who adds a picture later gets it.
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
					headers: {
						'Content-Type': meta.contentType,
						'Cache-Control': 'max-age=31536000',
						'Access-Control-Allow-Origin': '*',
					},
				});
			}

			// Download and cache
			const result = await downloadImage(originalUrl);

			writeDownloadResult(imagePath, metaPath, result, originalUrl);
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
					headers: {
						'Content-Type': contentType,
						'Cache-Control': 'max-age=31536000',
						'Access-Control-Allow-Origin': '*',
					},
				}
			);
		} catch (err: any) {
			logger.error('Image cache error:', err.message);
			return new Response(null, { status: 404 });
		}
	});

	logger.info('Image cache protocol handler registered');
});
