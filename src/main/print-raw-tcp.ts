import net from 'net';

import { ipcMain } from 'electron';

import { logger } from './log';

const CONNECT_TIMEOUT_MS = 10_000;

ipcMain.handle(
	'print-raw-tcp',
	async (_event, { host, port, data }: { host: string; port: number; data: number[] }) => {
		logger.info(`print-raw-tcp: connecting to ${host}:${port} (${data.length} bytes)`);

		return new Promise<void>((resolve, reject) => {
			const socket = new net.Socket();

			socket.setTimeout(CONNECT_TIMEOUT_MS);

			socket.on('timeout', () => {
				socket.destroy();
				reject(new Error(`Connection to ${host}:${port} timed out`));
			});

			socket.on('error', (err) => {
				logger.error(`print-raw-tcp: error`, { host, port, message: err.message });
				reject(err);
			});

			socket.connect(port, host, () => {
				const buffer = Buffer.from(data);
				socket.end(buffer, () => {
					logger.info(`print-raw-tcp: sent ${buffer.length} bytes to ${host}:${port}`);
					resolve();
				});
			});
		});
	}
);
