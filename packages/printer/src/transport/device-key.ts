export const SERIAL_PREFIX = 'serial:';
export const USB_PREFIX = 'usb:';
export const WINSPOOL_PREFIX = 'winspool:';
export const CLOUD_PREFIX = 'cloud:';
export const SYSTEM_TARGET = 'system';

export type ParsedTarget =
	| { kind: 'serial'; path: string; raw: string }
	| { kind: 'usb'; vid: number; pid: number; bus: number; address: number; raw: string }
	| { kind: 'winspool'; queue: string; raw: string }
	| { kind: 'cloud'; cloudPrinterId: string; raw: string }
	| { kind: 'system'; raw: string }
	| { kind: 'uuid'; uuid: string; raw: string }
	| { kind: 'unknown'; raw: string };

export type TargetConnectionType = 'bluetooth' | 'usb' | 'system' | 'cloud';

const USB_KEY_PATTERN = /^usb:(\d+):(\d+):(\d+):(\d+)$/;

export const TARGET_KIND_CONNECTION_TYPE = {
	serial: 'bluetooth',
	usb: 'usb',
	winspool: 'system',
	cloud: 'cloud',
	system: 'system',
} as const satisfies Partial<Record<ParsedTarget['kind'], TargetConnectionType>>;

export function parseTarget(value: string): ParsedTarget {
	if (value === SYSTEM_TARGET) return { kind: 'system', raw: value };

	if (value.startsWith(SERIAL_PREFIX)) {
		const path = value.slice(SERIAL_PREFIX.length);
		return path ? { kind: 'serial', path, raw: value } : { kind: 'unknown', raw: value };
	}

	const usbMatch = USB_KEY_PATTERN.exec(value);
	if (usbMatch) {
		const [, vid, pid, bus, address] = usbMatch;
		return {
			kind: 'usb',
			vid: Number(vid),
			pid: Number(pid),
			bus: Number(bus),
			address: Number(address),
			raw: value,
		};
	}
	if (value.startsWith(USB_PREFIX)) return { kind: 'unknown', raw: value };

	if (value.startsWith(WINSPOOL_PREFIX)) {
		const queue = value.slice(WINSPOOL_PREFIX.length);
		return queue ? { kind: 'winspool', queue, raw: value } : { kind: 'unknown', raw: value };
	}

	if (value.startsWith(CLOUD_PREFIX)) {
		const cloudPrinterId = value.slice(CLOUD_PREFIX.length);
		return cloudPrinterId
			? { kind: 'cloud', cloudPrinterId, raw: value }
			: { kind: 'unknown', raw: value };
	}

	return { kind: 'uuid', uuid: value, raw: value };
}

export function buildSerialKey(path: string): string {
	return `${SERIAL_PREFIX}${path}`;
}

export function buildUsbKey(p: { vid: number; pid: number; bus: number; address: number }): string {
	return `${USB_PREFIX}${p.vid}:${p.pid}:${p.bus}:${p.address}`;
}

export function buildWinspoolKey(queue: string): string {
	return `${WINSPOOL_PREFIX}${queue}`;
}

export function buildCloudTarget(cloudPrinterId: string): string {
	return `${CLOUD_PREFIX}${cloudPrinterId}`;
}

export function connectionTypeForParsedTarget(
	target: ParsedTarget
): TargetConnectionType | undefined {
	if (
		target.kind === 'serial' ||
		target.kind === 'usb' ||
		target.kind === 'winspool' ||
		target.kind === 'cloud' ||
		target.kind === 'system'
	) {
		return TARGET_KIND_CONNECTION_TYPE[target.kind];
	}
	return undefined;
}

export function connectionTypeForTarget(value: string): TargetConnectionType | undefined {
	return connectionTypeForParsedTarget(parseTarget(value));
}
