import Bonjour from 'bonjour-service';

import type { DiscoveredNetworkPrinter, IpcInvokeChannels } from '@wcpos/printer/ipc-channels';

import { handleIpc } from './ipc';
import { logger } from './log';

interface MdnsServiceLike {
	name: string;
	type: string;
	port?: number;
	host?: string;
	addresses?: string[];
	txt?: Record<string, unknown>;
}

export type { DiscoveredNetworkPrinter } from '@wcpos/printer/ipc-channels';

type PrinterDiscoveryRequest = IpcInvokeChannels['printer-discovery']['req'];

const SERVICE_TYPES = ['printer', 'pdl-datastream', 'ipp', 'ipps', 'star'];
// Printing always goes over raw TCP (ESC/POS bytes on a plain socket), so a discovery
// result may only carry a raw-socket port. Only these service types advertise one;
// ipp/ipps (631) and lpd ("printer", 515) advertise protocol ports that accept the TCP
// connection and silently discard raw bytes — those results map to jetdirect 9100.
const RAW_SOCKET_SERVICE_TYPES = new Set(['pdl-datastream', 'star']);
const RAW_PRINT_PORT = 9100;
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
	const serviceType = (service.type ?? '').toLowerCase();
	const servicePort = Number(service.port);
	const advertisedPortUsable =
		RAW_SOCKET_SERVICE_TYPES.has(serviceType) &&
		Number.isInteger(servicePort) &&
		servicePort >= 1 &&
		servicePort <= 65535;
	const port = advertisedPortUsable ? servicePort : RAW_PRINT_PORT;
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
	const startedAt = Date.now();
	let upEvents = 0;
	logger.info('[printer-discovery] scan started', { timeoutMs, serviceTypes: SERVICE_TYPES });

	const bonjour = new Bonjour();
	const browsers = SERVICE_TYPES.map((type) => bonjour.find({ type, protocol: 'tcp' }));
	const printers = new Map<string, DiscoveredNetworkPrinter>();
	const logMdnsError = (error: Error) =>
		logger.warn('[printer-discovery] mDNS error', { message: error.message });
	const bonjourEmitter = bonjour as Bonjour & {
		on?: (event: string, listener: (error: Error) => void) => void;
	};
	bonjourEmitter.on?.('error', logMdnsError);

	const stop = () => {
		for (const browser of browsers) {
			browser.stop();
		}
		bonjour.destroy();
	};
	activeScan = { stop };

	for (const browser of browsers) {
		browser.on('error', logMdnsError);
		browser.on('up', (service: MdnsServiceLike) => {
			upEvents += 1;
			logger.debug('[printer-discovery] service up', {
				type: service.type,
				name: service.name,
				host: service.host,
				port: service.port,
				ipv4: service.addresses?.find(isIpv4),
				txtTy: service.txt?.ty,
			});
			const printer = mapMdnsServiceToPrinter(service);
			if (printer) printers.set(printer.id, printer);
			else
				logger.debug('[printer-discovery] service dropped', {
					type: service.type,
					name: service.name,
				});
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
				const result = [...printers.values()];
				logger.info('[printer-discovery] scan ended', {
					elapsedMs: Date.now() - startedAt,
					upEvents,
					printersMapped: result.length,
				});
				resolve(result);
			},
		};
	});
}

handleIpc('printer-discovery', async (_event, args) => {
	const request = parseRequest(args);
	if (request.action === 'stop') {
		stopActiveScan();
		return [];
	}

	try {
		return await discoverPrinters(request.timeoutMs);
	} catch (error) {
		stopActiveScan();
		logger.error('[printer-discovery] failed', error);
		throw error;
	}
});
