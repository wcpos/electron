import * as http from 'http';
import * as https from 'https';

import { handleIpc } from './ipc';
import { logger } from './log';

const MAX_XML_BYTES = 512 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 30000;

handleIpc('print-epos-http', async (_event, args) => {
	if (!args || typeof args !== 'object') {
		throw new Error('Invalid arguments: expected an object');
	}

	const { host, port, path, xml, timeoutMs } = args;
	if (typeof host !== 'string' || !/^[^\s/\\]+$/.test(host)) {
		throw new Error('Invalid host: must be non-empty and contain no slashes or whitespace');
	}
	if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error('Invalid port: must be an integer between 1 and 65535');
	}
	if (typeof path !== 'string' || !path.startsWith('/cgi-bin/epos/')) {
		throw new Error('Invalid path: must start with /cgi-bin/epos/');
	}
	const xmlBytes = typeof xml === 'string' ? Buffer.byteLength(xml, 'utf8') : 0;
	if (typeof xml !== 'string' || xmlBytes >= MAX_XML_BYTES) {
		throw new Error('Invalid xml: must be a string under 512KB');
	}
	if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) {
		throw new Error('Invalid timeoutMs: must be a finite number');
	}

	const requestTimeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, timeoutMs));
	const useHttps = port === 443 || port === 8043;
	const transport = useHttps ? https : http;
	const startedAt = Date.now();
	logger.info('[print-epos-http] request', { host, port, path, xmlBytes });

	return new Promise<{ status: number; body: string }>((resolve, reject) => {
		let deadline: ReturnType<typeof setTimeout> | undefined;
		let completed = false;
		const clearDeadline = () => deadline && clearTimeout(deadline);
		const warn = (outcome: string, error: unknown) =>
			logger.warn(`[print-epos-http] ${outcome}`, {
				elapsedMs: Date.now() - startedAt,
				message: error instanceof Error ? error.message : String(error),
			});
		const request = transport.request(
			{
				hostname: host,
				port,
				path,
				method: 'POST',
				headers: {
					'Content-Type': 'text/xml; charset=utf-8',
					// Embedded printer HTTP servers can reject chunked POSTs — always send a length.
					'Content-Length': Buffer.byteLength(xml, 'utf8'),
				},
				// Epson ePOS HTTPS printers use self-signed certificates; keep this request-scoped.
				...(useHttps ? { rejectUnauthorized: false } : {}),
			},
			(response) => {
				const chunks: Buffer[] = [];
				let bodyBytes = 0;

				response.on('data', (chunk: Buffer | string) => {
					if (bodyBytes >= MAX_BODY_BYTES) return;
					const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
					const capped = bytes.subarray(0, MAX_BODY_BYTES - bodyBytes);
					chunks.push(capped);
					bodyBytes += capped.length;
				});
				response.on('error', (error) => {
					if (completed) return;
					completed = true;
					clearDeadline();
					warn('socket error', error);
					reject(error);
				});
				response.on('end', () => {
					if (completed) return;
					completed = true;
					clearDeadline();
					const status = response.statusCode ?? 0;
					const body = Buffer.concat(chunks, bodyBytes).toString('utf8');
					const success = body.match(/\bsuccess=["']([^"']*)["']/)?.[1];
					const code = body.match(/\bcode=["']([^"']*)["']/)?.[1];
					const responseStatus = body.match(/\bstatus=["']([^"']*)["']/)?.[1];
					logger.info('[print-epos-http] outcome', {
						httpStatus: status,
						success,
						code,
						status: responseStatus,
						elapsedMs: Date.now() - startedAt,
					});
					resolve({ status, body });
				});
			}
		);

		request.on('error', (error) => {
			if (completed) return;
			completed = true;
			clearDeadline();
			warn('socket error', error);
			reject(error);
		});
		deadline = setTimeout(() => {
			if (completed) return;
			completed = true;
			request.destroy();
			const error = new Error(`EPOS HTTP request to ${host}:${port} timed out`);
			warn('timeout', error);
			reject(error);
		}, requestTimeoutMs);
		request.end(xml);
	});
});
