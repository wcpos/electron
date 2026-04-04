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
			fs.writeFileSync(imagePath, buffer);
			fs.writeFileSync(
				metaPath,
				JSON.stringify({ url, contentType, cachedAt: Date.now() } satisfies CacheMeta)
			);
		})
		.catch((err) => {
			logger.warn('Background image refresh failed:', url, err.message);
		});
}

app.on('ready', () => {
	const cacheDir = getCacheDir();

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

			fs.writeFileSync(imagePath, buffer);
			fs.writeFileSync(
				metaPath,
				JSON.stringify({
					url: originalUrl,
					contentType,
					cachedAt: Date.now(),
				} satisfies CacheMeta)
			);

			return new Response(buffer, {
				status: 200,
				headers: {
					'Content-Type': contentType,
					'Cache-Control': 'max-age=31536000',
				},
			});
		} catch (err: any) {
			logger.error('Image cache error:', err.message);
			return new Response(null, { status: 404 });
		}
	});

	logger.info('Image cache protocol handler registered');
});
