import * as net from 'net';

import { ipcMain } from 'electron';

import { logger } from './log';

ipcMain.handle('print-raw-tcp', async (_event, args: unknown) => {
	if (!args || typeof args !== 'object') {
		throw new Error('Invalid arguments: expected an object');
	}
	const { host, port, data } = args as {
		host: unknown;
		port: unknown;
		data: unknown;
	};

	if (!host || typeof host !== 'string') {
		throw new Error('Invalid host: must be a non-empty string');
	}
	if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error('Invalid port: must be an integer between 1 and 65535');
	}
	if (!Array.isArray(data) || !data.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
		throw new Error('Invalid data: must be an array of byte values (0-255)');
	}

	const buffer = Buffer.from(data as number[]);

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

		socket.on('error', (err) => {
			logger.error(`TCP error: ${err.message}`);
			finish(err);
		});

		socket.on('close', () => {
			finish(new Error(`Connection to ${host}:${port} closed unexpectedly`));
		});

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
	});
});
