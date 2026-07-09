import * as net from 'net';

import { handleIpc } from './ipc';
import { type Delivery, sendRawPrint } from './raw-print';

const TCP_PRINT_TIMEOUT_MS = 10_000;

function createTcpDelivery(host: string, port: number): Delivery {
	const socket = new net.Socket();
	let ended = false;
	const label = `${host}:${port}`;

	return {
		label,
		operation: 'print-raw-tcp',
		timeoutMs: TCP_PRINT_TIMEOUT_MS,
		timeoutMessage: `TCP connection to ${label} timed out`,
		successMessage: (bytes) => `print-raw-tcp sent ${bytes} bytes to ${label}`,
		cleanup() {
			socket.destroy();
		},
		send(bytes, ctx): Promise<void> {
			return new Promise<void>((resolve, reject) => {
				socket.once('error', reject);
				socket.once('close', () => {
					if (!ended) reject(new Error(`Connection to ${label} closed unexpectedly`));
				});

				socket.connect(port, host, () => {
					if (ctx.settled()) {
						resolve();
						return;
					}

					socket.write(bytes, (err) => {
						if (err) {
							reject(err);
							return;
						}
						ended = true;
						socket.end(() => resolve());
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
	return sendRawPrint({ data }, createTcpDelivery(host, port));
});
