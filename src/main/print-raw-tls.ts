import * as tls from 'tls';

import { handleIpc } from './ipc';
import { type Delivery, sendRawPrint } from './raw-print';

// Same as TCP: covers the TLS handshake plus the write on a LAN.
const TLS_PRINT_TIMEOUT_MS = 10_000;

export function createTlsDelivery(host: string, port: number): Delivery {
	// Created in send(), not here: sendRawPrint() validates the payload before
	// withTimeout() runs, so a factory-time socket would escape cleanup() on
	// invalid data.
	let socket: tls.TLSSocket | undefined;
	const label = `${host}:${port}`;

	return {
		label,
		operation: 'print-raw-tls',
		timeoutMs: TLS_PRINT_TIMEOUT_MS,
		timeoutMessage: `TLS connection to ${label} timed out`,
		successMessage: (bytes) => `print-raw-tls sent ${bytes} bytes to ${label}`,
		cleanup() {
			socket?.destroy();
		},
		send(bytes, ctx): Promise<void> {
			return new Promise<void>((resolve, reject) => {
				let ended = false;
				const sock = tls.connect(
					{
						host,
						port,
						servername: host,
						// Epson printers use self-signed certificates; disable verification only for this request.
						rejectUnauthorized: false,
					},
					() => {
						if (ctx.settled()) {
							resolve();
							return;
						}

						if (bytes.length === 0) {
							ended = true;
							sock.end(() => resolve());
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
					}
				);
				socket = sock;
				// Persistent (not `once`): cleanup() destroys the socket after the promise
				// settles, and a late 'error' with no listener would crash the main
				// process. reject() is a no-op once settled, so one listener does both jobs.
				sock.on('error', reject);
				sock.once('close', () => {
					if (!ended) reject(new Error(`Connection to ${label} closed unexpectedly`));
				});
			});
		},
	};
}

// Channel type and preload allowlist live in @wcpos/printer/ipc-channels
// (wcpos/monorepo#1809 adds 'print-raw-tls' there); the request shape matches print-raw-tcp.
handleIpc('print-raw-tls', async (_event, args) => {
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
	return sendRawPrint({ data }, createTlsDelivery(host, port));
});
