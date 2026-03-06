import { ipcMain } from 'electron';
import * as net from 'net';

import { logger } from './log';

ipcMain.handle('print-raw-tcp', async (_event, args: { host: string; port: number; data: number[] }) => {
	const { host, port, data } = args;
	const buffer = Buffer.from(data);

	logger.info(`Sending ${buffer.length} bytes to ${host}:${port}`);

	return new Promise<void>((resolve, reject) => {
		const socket = new net.Socket();
		const timeout = setTimeout(() => {
			socket.destroy();
			reject(new Error(`TCP connection to ${host}:${port} timed out`));
		}, 10000);

		socket.connect(port, host, () => {
			socket.write(buffer, (err) => {
				clearTimeout(timeout);
				if (err) {
					socket.destroy();
					reject(err);
				} else {
					socket.end(() => {
						logger.info(`Print data sent successfully to ${host}:${port}`);
						resolve();
					});
				}
			});
		});

		socket.on('error', (err) => {
			clearTimeout(timeout);
			logger.error(`TCP error: ${err.message}`);
			reject(err);
		});
	});
});
