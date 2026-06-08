import { ipcMain } from 'electron';
import Bonjour from 'bonjour-service';

import { logger } from './log';

interface MdnsServiceLike {
	name: string;
	type: string;
	port?: number;
	host?: string;
	addresses?: string[];
	txt?: Record<string, unknown>;
}

interface DiscoveredNetworkPrinter {
	id: string;
	name: string;
	connectionType: 'network';
	address: string;
	port: number;
	vendor: 'epson' | 'star' | 'generic';
}

interface PrinterDiscoveryRequest {
	action?: 'start' | 'stop';
	timeoutMs?: number;
}

const SERVICE_TYPES = ['printer', 'pdl-datastream', 'ipp', 'ipps', 'star'];
const DEFAULT_SCAN_TIMEOUT_MS = 4000;

let activeScan: { stop: () => void } | null = null;

function sanitizeIdPart(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9:.:-]+/g, '-');
}

function isIpv4(address: string): boolean {
	return /^\d{1,3}(\.\d{1,3}){3}$/.test(address);
}

function pickAddress(service: MdnsServiceLike): string | null {
	const ipv4 = service.addresses?.find(
		(address) => isIpv4(address) && !address.startsWith('169.254.')
	);
	if (ipv4) return ipv4;
	return service.host ?? service.addresses?.[0] ?? null;
}

function detectVendor(service: MdnsServiceLike): 'epson' | 'star' | 'generic' {
	const haystack = [service.name, service.host, service.type, JSON.stringify(service.txt ?? {})]
		.filter(Boolean)
		.join(' ')
		.toLowerCase();
	if (haystack.includes('epson')) return 'epson';
	if (haystack.includes('star')) return 'star';
	return 'generic';
}

export function mapMdnsServiceToPrinter(service: MdnsServiceLike): DiscoveredNetworkPrinter | null {
	const address = pickAddress(service);
	if (!address) return null;
	const servicePort = Number(service.port);
	const port =
		Number.isInteger(servicePort) && servicePort >= 1 && servicePort <= 65535 ? servicePort : 9100;
	const id = `mdns-${sanitizeIdPart(address)}-${port}`;

	return {
		id,
		name: service.name || address,
		connectionType: 'network',
		address,
		port,
		vendor: detectVendor(service),
	};
}

function parseRequest(args: unknown): Required<PrinterDiscoveryRequest> {
	if (!args || typeof args !== 'object') {
		return { action: 'start', timeoutMs: DEFAULT_SCAN_TIMEOUT_MS };
	}
	const request = args as PrinterDiscoveryRequest;
	const action = request.action === 'stop' ? 'stop' : 'start';
	const timeoutMs =
		typeof request.timeoutMs === 'number' && request.timeoutMs >= 250 && request.timeoutMs <= 15000
			? request.timeoutMs
			: DEFAULT_SCAN_TIMEOUT_MS;
	return { action, timeoutMs };
}

function stopActiveScan(): void {
	activeScan?.stop();
	activeScan = null;
}

async function discoverPrinters(timeoutMs: number): Promise<DiscoveredNetworkPrinter[]> {
	stopActiveScan();

	const bonjour = new Bonjour();
	const browsers = SERVICE_TYPES.map((type) => bonjour.find({ type, protocol: 'tcp' }));
	const printers = new Map<string, DiscoveredNetworkPrinter>();

	const stop = () => {
		for (const browser of browsers) {
			browser.stop();
		}
		bonjour.destroy();
	};
	activeScan = { stop };

	for (const browser of browsers) {
		browser.on('up', (service: MdnsServiceLike) => {
			const printer = mapMdnsServiceToPrinter(service);
			if (printer) printers.set(printer.id, printer);
		});
	}

	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			stopActiveScan();
			resolve([...printers.values()]);
		}, timeoutMs);

		activeScan = {
			stop: () => {
				clearTimeout(timer);
				stop();
				resolve([...printers.values()]);
			},
		};
	});
}

ipcMain.handle('printer-discovery', async (_event, args: unknown) => {
	const request = parseRequest(args);
	if (request.action === 'stop') {
		stopActiveScan();
		return [];
	}

	try {
		return await discoverPrinters(request.timeoutMs);
	} catch (error) {
		stopActiveScan();
		logger.error('Printer discovery failed', error);
		throw error;
	}
});
