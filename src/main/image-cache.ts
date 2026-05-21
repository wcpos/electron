import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import axios from 'axios';
import { app, protocol } from 'electron';

import { logger } from './log';
import { isDevelopment } from './util';

interface CacheMeta {
	url: string;
	contentType: string;
	cachedAt: number;
}

const STALE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function getCacheDir(): string {
	const base = isDevelopment
		? path.resolve('databases', 'image-cache')
		: path.resolve(app.getPath('userData'), 'wcpos_dbs', 'image-cache');
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
 * Deduplicate in-flight downloads so multiple <img> tags requesting the
 * same uncached image don't trigger parallel downloads.
 */
const inFlight = new Map<string, Promise<{ buffer: Buffer; contentType: string }>>();

async function downloadImage(url: string): Promise<{ buffer: Buffer; contentType: string }> {
	const existing = inFlight.get(url);
	if (existing) return existing;

	const promise = axios
		.get(url, { responseType: 'arraybuffer', timeout: 30000 })
		.then((response) => {
			const contentType = (response.headers['content-type'] as string) || 'image/jpeg';
			return { buffer: Buffer.from(response.data), contentType };
		})
		.finally(() => {
			inFlight.delete(url);
		});

	inFlight.set(url, promise);
	return promise;
}

function refreshInBackground(url: string, imagePath: string, metaPath: string): void {
	downloadImage(url)
		.then(({ buffer, contentType }) => {
			writeCacheEntry(imagePath, metaPath, buffer, contentType, url);
		})
		.catch((err) => {
			logger.warn('Background image refresh failed:', url, err.message);
		});
}

app.on('ready', () => {
	getCacheDir();

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

			// Serve from cache if exists
			if (fs.existsSync(imagePath) && fs.existsSync(metaPath)) {
				const meta: CacheMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
				const body = fs.readFileSync(imagePath);

				// Stale-while-revalidate: serve cached but refresh in background
				if (Date.now() - meta.cachedAt > STALE_AGE_MS) {
					refreshInBackground(originalUrl, imagePath, metaPath);
				}

				return new Response(body, {
					status: 200,
					headers: {
						'Content-Type': meta.contentType,
						'Cache-Control': 'max-age=31536000',
					},
				});
			}

			// Download and cache
			const { buffer, contentType } = await downloadImage(originalUrl);

			writeCacheEntry(imagePath, metaPath, buffer, contentType, originalUrl);

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
