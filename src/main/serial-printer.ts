import { ipcMain } from 'electron';
import { SerialPort } from 'serialport';

import { logger } from './log';

export const SERIAL_PREFIX = 'serial:';

export interface SerialPrinterInfo {
	id: string; // `serial:<path>` — stored as the profile address
	name: string;
}

// macOS ships virtual ports that can never be a printer; /dev/tty.* are the
// blocking call-in devices — we only offer the call-out /dev/cu.* counterparts.
const NOISE_PATTERNS = [/Bluetooth-Incoming-Port/i, /debug-console/i, /wlan-debug/i];

export function filterSerialPorts(ports: { path: string }[]): SerialPrinterInfo[] {
	return ports
		.filter((p) => {
			if (process.platform === 'darwin' && !p.path.startsWith('/dev/cu.')) return false;
			return !NOISE_PATTERNS.some((re) => re.test(p.path));
		})
		.map((p) => {
			// Strip common prefixes for a human-readable name. If stripping leaves
			// an empty string or a plain number (e.g. rfcomm0 → '0'), fall back to
			// the last path component so names like 'rfcomm0' remain legible.
			const basename = p.path.split('/').pop() ?? p.path;
			const stripped = basename.replace(/^(cu\.|tty\.|rfcomm)/, '');
			const name =
				stripped === '' || /^\d+$/.test(stripped) ? basename : stripped.replace(/[-_]/g, ' ');
			return {
				id: `${SERIAL_PREFIX}${p.path}`,
				name,
			};
		});
}

const PRINT_TIMEOUT_MS = 20_000; // renderer gives up at 30s — fail first with a real error

ipcMain.handle('serial-discovery', async (): Promise<SerialPrinterInfo[]> => {
	// Windows: OS-paired Bluetooth Classic printers are enumerated and printed via the
	// spooler (winspool path). Offering serial ports here would list COM ports that are
	// already covered, leading to duplicate entries or permission conflicts.
	if (process.platform === 'win32') {
		return [];
	}
	try {
		const ports = await SerialPort.list();
		return filterSerialPorts(ports);
	} catch (err) {
		logger.error(`serial-discovery failed: ${err instanceof Error ? err.message : String(err)}`);
		throw err;
	}
});

ipcMain.handle(
	'print-raw-serial',
	async (_event, args: { device: string; data: number[] }): Promise<void> => {
		if (!args || typeof args.device !== 'string') {
			throw new Error('Invalid arguments: expected { device: string, data: number[] }');
		}
		if (
			!Array.isArray(args.data) ||
			!args.data.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)
		) {
			throw new Error('Invalid data: must be an array of byte values (0-255)');
		}
		if (!args.device.startsWith(SERIAL_PREFIX)) {
			throw new Error(`Invalid serial device key: ${args.device}`);
		}

		const portPath = args.device.slice(SERIAL_PREFIX.length);
		// SPP (Bluetooth Classic) virtual serial ports ignore baud rate — 9600 is the
		// conventional default and what most receipt printer SDKs use.
		const port = new SerialPort({ path: portPath, baudRate: 9600, autoOpen: false });

		let settled = false;
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

		const cleanup = (): Promise<void> =>
			new Promise((res) => {
				if (!port.isOpen) {
					res();
					return;
				}
				port.close(() => res());
			});

		const printPromise = new Promise<void>((resolve, reject) => {
			const finish = (err?: Error) => {
				if (settled) return;
				settled = true;
				if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
				if (err) {
					logger.error(`print-raw-serial to ${portPath} failed: ${err.message}`);
					reject(err);
				} else {
					resolve();
				}
			};

			timeoutHandle = setTimeout(() => {
				void cleanup().finally(() =>
					finish(new Error(`Serial print to "${portPath}" timed out after ${PRINT_TIMEOUT_MS}ms`))
				);
			}, PRINT_TIMEOUT_MS);

			port.open((openErr) => {
				if (openErr) {
					void cleanup().finally(() => finish(openErr));
					return;
				}

				port.write(Buffer.from(args.data), (writeErr) => {
					if (writeErr) {
						void cleanup().finally(() => finish(writeErr));
						return;
					}

					port.drain((drainErr) => {
						if (drainErr) {
							void cleanup().finally(() => finish(drainErr));
							return;
						}

						void cleanup().finally(() => {
							logger.info(`print-raw-serial sent ${args.data.length} bytes to ${portPath}`);
							finish();
						});
					});
				});
			});
		});

		return printPromise;
	}
);
