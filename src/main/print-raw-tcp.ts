import * as net from 'net';

import { handleIpc } from './ipc';
import { logger } from './log';
import { type Delivery, sendRawPrint } from './raw-print';

const TCP_PRINT_TIMEOUT_MS = 10_000;

export function createTcpDelivery(host: string, port: number): Delivery {
	// Created in send(), not here: sendRawPrint() validates the payload before
	// withTimeout() runs, so a factory-time socket would escape cleanup() on
	// invalid data.
	let socket: net.Socket | undefined;
	const label = `${host}:${port}`;

	return {
		label,
		operation: 'print-raw-tcp',
		timeoutMs: TCP_PRINT_TIMEOUT_MS,
		timeoutMessage: `TCP connection to ${label} timed out`,
		successMessage: (bytes) => `print-raw-tcp sent ${bytes} bytes to ${label}`,
		cleanup() {
			socket?.destroy();
		},
		send(bytes, ctx): Promise<void> {
			return new Promise<void>((resolve, reject) => {
				let ended = false;
				const sock = new net.Socket();
				socket = sock;
				// Persistent (not `once`): cleanup() destroys the socket after the promise
				// settles, and a late 'error' with no listener would crash the main
				// process. reject() is a no-op once settled, so one listener does both jobs.
				sock.on('error', reject);
				sock.once('close', () => {
					if (!ended) reject(new Error(`Connection to ${label} closed unexpectedly`));
				});

				sock.connect(port, host, () => {
					if (ctx.settled()) {
						resolve();
						return;
					}

					sock.write(bytes, (err) => {
						if (err) {
							reject(err);
							return;
						}
						ended = true;
						sock.end(() => resolve());
					});
				});
			});
		},
	};
}

handleIpc('print-raw-tcp', async (_event, args) => {
	if (!args || typeof args !== 'object') {
		throw new Error('Invalid arguments: expected an object');
	}
	const { host, port, data } = args;

	if (!host || typeof host !== 'string') {
		throw new Error('Invalid host: must be a non-empty string');
	}
	if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error('Invalid port: must be an integer between 1 and 65535');
	}
	const startedAt = Date.now();
	try {
		await sendRawPrint({ data }, createTcpDelivery(host, port));
		logger.info('[print-raw-tcp] outcome', { outcome: 'ok', elapsedMs: Date.now() - startedAt });
	} catch (error) {
		logger.info('[print-raw-tcp] outcome', {
			outcome: error instanceof Error ? error.name : 'Error',
			elapsedMs: Date.now() - startedAt,
		});
		throw error;
	}
});
