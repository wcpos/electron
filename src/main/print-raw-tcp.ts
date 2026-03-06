import * as net from 'net';

import { ipcMain } from 'electron';

import { logger } from './log';

ipcMain.handle(
	'print-raw-tcp',
	async (_event, args: { host: string; port: number; data: number[] }) => {
		const { host, port, data } = args;

		if (!host || typeof host !== 'string') {
			throw new Error('Invalid host: must be a non-empty string');
		}
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			throw new Error('Invalid port: must be an integer between 1 and 65535');
		}
		if (!Array.isArray(data)) {
			throw new Error('Invalid data: must be an array of numbers');
		}

		const buffer = Buffer.from(data);

		logger.info(`Sending ${buffer.length} bytes to ${host}:${port}`);

		return new Promise<void>((resolve, reject) => {
			const socket = new net.Socket();
			let settled = false;

			const finish = (err?: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				socket.destroy();
				if (err) {
					reject(err);
				} else {
					resolve();
				}
			};

			const timeout = setTimeout(() => {
				finish(new Error(`TCP connection to ${host}:${port} timed out`));
			}, 10000);

			socket.connect(port, host, () => {
				socket.write(buffer, (err) => {
					if (err) {
						finish(err);
					} else {
						socket.end(() => {
							logger.info(`Print data sent successfully to ${host}:${port}`);
							finish();
						});
					}
				});
			});

			socket.on('error', (err) => {
				logger.error(`TCP error: ${err.message}`);
				finish(err);
			});
		});
	}
);
