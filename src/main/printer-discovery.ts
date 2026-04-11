import { ipcMain } from 'electron';

import { logger } from './log';

interface DiscoveredPrinter {
	id: string;
	name: string;
	connectionType: 'network';
	address: string;
	port?: number;
	vendor?: 'epson' | 'star' | 'generic';
}

let activeBrowsers: Array<{ stop: () => void }> = [];

/**
 * Infer vendor from mDNS service metadata.
 */
function inferVendor(
	name: string,
	txt: Record<string, string | undefined>
): 'epson' | 'star' | 'generic' {
	const lower = name.toLowerCase();
	const product = (txt.product || txt.ty || '').toLowerCase();

	if (lower.includes('epson') || product.includes('epson')) return 'epson';
	if (lower.includes('star') || product.includes('star')) return 'star';
	return 'generic';
}

ipcMain.handle(
	'printer-discovery',
	async (_event, args: unknown): Promise<DiscoveredPrinter[]> => {
		if (!args || typeof args !== 'object') {
			throw new Error('Invalid arguments: expected an object with action');
		}
		const { action } = args as { action: unknown };

		if (action === 'stop') {
			for (const browser of activeBrowsers) {
				try {
					browser.stop();
				} catch {
					// ignore
				}
			}
			activeBrowsers = [];
			logger.info('Printer discovery stopped');
			return [];
		}

		if (action !== 'start') {
			throw new Error('Invalid action: expected "start" or "stop"');
		}

		// Stop any existing browsers first
		for (const browser of activeBrowsers) {
			try {
				browser.stop();
			} catch {
				// ignore
			}
		}
		activeBrowsers = [];

		// Dynamic import so the module is only loaded when needed
		const { default: Bonjour } = await import('bonjour-service');
		const bonjour = new Bonjour();
		const found = new Map<string, DiscoveredPrinter>();

		const serviceTypes = ['pdl-datastream', 'ipp'];

		return new Promise((resolve) => {
			let remaining = serviceTypes.length;

			for (const type of serviceTypes) {
				const browser = bonjour.find({ type }, (service) => {
					const address =
						service.addresses?.find((a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a)) ||
						service.host;

					if (!address) return;

					const port = service.port || 9100;
					const id = `${address}:${port}`;

					if (found.has(id)) return;

					const txt: Record<string, string | undefined> = {};
					if (service.txt && typeof service.txt === 'object') {
						for (const [k, v] of Object.entries(service.txt)) {
							txt[k] = typeof v === 'string' ? v : undefined;
						}
					}

					const vendor = inferVendor(service.name || '', txt);

					const printer: DiscoveredPrinter = {
						id,
						name: service.name || `Printer at ${address}`,
						connectionType: 'network',
						address,
						port,
						vendor,
					};

					found.set(id, printer);
					logger.info(`Discovered printer: ${printer.name} (${vendor}) at ${address}:${port}`);
				});

				activeBrowsers.push(browser);
			}

			// Give mDNS 5 seconds to discover printers, then return results
			setTimeout(() => {
				for (const browser of activeBrowsers) {
					try {
						browser.stop();
					} catch {
						// ignore
					}
				}
				activeBrowsers = [];
				bonjour.destroy();
				resolve(Array.from(found.values()));
			}, 5000);
		});
	}
);
