import {
	type Device,
	type Endpoint,
	getDeviceList,
	type InEndpoint,
	type OutEndpoint,
	usb,
} from 'usb';

import type { UsbPrinterInfo } from '@wcpos/printer/ipc-channels';
import {
	buildUsbKey,
	connectionTypeForTarget,
	parseTarget,
} from '@wcpos/printer/transport/device-key';

import { handleIpc } from './ipc';
import { logger } from './log';
import { type Delivery, rawPrintBufferFromData, sendRawBytes } from './raw-print';
import { parseUsbModelReply } from './usb-model-reply';
import { listSpoolerPrinters, printRawToSpooler } from './winspool-printer';

const USB_PRINTER_CLASS = 0x07;
const USB_PRINT_TIMEOUT_MS = 20_000;
// A model query is one short bulk read; a printer that will not answer should not stall setup.
const USB_MODEL_QUERY_TIMEOUT_MS = 1_000;
const USB_MODEL_REPLY_BYTES = 64;
// GS I 67: ESC/POS "transmit printer model name" (Epson TM-series; clones may ignore it).
const GS_I_MODEL_NAME = Buffer.from([0x1d, 0x49, 0x43]);
type UsbInterface = NonNullable<Device['interfaces']>[number];

export type { UsbPrinterInfo } from '@wcpos/printer/ipc-channels';

function deviceKey(d: Device): string {
	const { idVendor, idProduct } = d.deviceDescriptor;
	return buildUsbKey({
		vid: idVendor,
		pid: idProduct,
		bus: d.busNumber,
		address: d.deviceAddress,
	});
}

function discoveredPrinter(id: string, name: string): UsbPrinterInfo {
	const connectionType = connectionTypeForTarget(id);
	if (connectionType !== 'usb' && connectionType !== 'system') {
		throw new Error(`Unsupported USB discovery device key: ${id}`);
	}
	return {
		id,
		name,
		connectionType,
		address: id,
		vendor: 'generic',
	};
}

function isPrinter(d: Device): boolean {
	try {
		return (
			d.configDescriptor?.interfaces.some((alts) =>
				alts.some((iface) => iface.bInterfaceClass === USB_PRINTER_CLASS)
			) ?? false
		);
	} catch {
		return false;
	}
}

function createUsbDelivery(deviceKey: string, device: Device): Delivery {
	let deviceOpened = false;
	let iface: UsbInterface | undefined;
	let ifaceClaimed = false;

	const cleanup = async (): Promise<void> => {
		if (iface && ifaceClaimed) {
			await new Promise<void>((resolve) => {
				try {
					iface?.release(true, () => resolve());
				} catch {
					resolve();
				}
			});
			ifaceClaimed = false;
		}
		if (deviceOpened) {
			device.close();
			deviceOpened = false;
		}
	};

	return {
		label: deviceKey,
		operation: 'print-raw-usb',
		timeoutMs: USB_PRINT_TIMEOUT_MS,
		timeoutMessage: `USB print to ${deviceKey} timed out after ${USB_PRINT_TIMEOUT_MS}ms`,
		successMessage: (bytes) => `print-raw-usb sent ${bytes} bytes to ${deviceKey}`,
		cleanup,
		async send(bytes, ctx): Promise<void> {
			device.open();
			deviceOpened = true;

			if (ctx.settled()) return;

			// Select the printer-class interface — NOT blindly interfaces[0]. Composite devices and
			// printers with multiple interfaces can put the printer class elsewhere; claiming the wrong
			// one yields no OUT endpoint or a failed claim.
			iface = device.interfaces?.find((i) => i.descriptor.bInterfaceClass === USB_PRINTER_CLASS);
			if (!iface) throw new Error('USB printer has no printer-class (0x07) interface');

			// Kernel-driver detach exists for Linux, where usblp claims printer-class
			// interfaces; both calls throw LIBUSB_ERROR_NOT_SUPPORTED on other platforms.
			if (process.platform === 'linux' && iface.isKernelDriverActive()) {
				iface.detachKernelDriver();
			}
			iface.claim();
			ifaceClaimed = true;

			if (ctx.settled()) return;

			const out = iface.endpoints.find(
				(e: Endpoint) => e.direction === 'out' && e.transferType === usb.LIBUSB_TRANSFER_TYPE_BULK
			) as OutEndpoint | undefined;
			if (!out) throw new Error('USB printer interface has no bulk OUT endpoint');

			await new Promise<void>((resolve, reject) => {
				out.transfer(bytes, (err) => (err ? reject(err) : resolve()));
			});
		},
	};
}

/**
 * The USB product string ("TM-m30III", "USB Printer P") is what the model table matches on;
 * without it every USB printer was "USB printer (usb:…)" and defaulted to 42 columns (#33/#37).
 */
async function readProductName(d: Device): Promise<string | null> {
	const index = d.deviceDescriptor.iProduct;
	if (!index) return null;
	try {
		d.open();
		try {
			return await new Promise<string | null>((resolve) => {
				d.getStringDescriptor(index, (err, value) => resolve(err || !value ? null : value.trim()));
			});
		} finally {
			d.close();
		}
	} catch (err) {
		logger.debug(`[usb] product string unavailable for ${deviceKey(d)}: ${String(err)}`);
		return null;
	}
}

function findUsbDevice(key: string): Device | undefined {
	const target = parseTarget(key);
	if (target.kind !== 'usb') return undefined;
	return getDeviceList().find(
		(d) =>
			d.deviceDescriptor.idVendor === target.vid &&
			d.deviceDescriptor.idProduct === target.pid &&
			d.busNumber === target.bus &&
			d.deviceAddress === target.address
	);
}

handleIpc('usb-query-model', async (_event, args: { device: string }): Promise<string | null> => {
	const startedAt = Date.now();
	const device = findUsbDevice(args.device);
	if (!device) {
		logger.info(`[usb] model query: ${args.device} not present`);
		return null;
	}
	let iface: UsbInterface | undefined;
	let claimed = false;
	try {
		device.open();
		iface = device.interfaces?.find((i) => i.descriptor.bInterfaceClass === USB_PRINTER_CLASS);
		if (!iface) throw new Error('no printer-class interface');
		if (process.platform === 'linux' && iface.isKernelDriverActive()) iface.detachKernelDriver();
		iface.claim();
		claimed = true;
		const out = iface.endpoints.find(
			(e: Endpoint) => e.direction === 'out' && e.transferType === usb.LIBUSB_TRANSFER_TYPE_BULK
		) as OutEndpoint | undefined;
		const inEndpoint = iface.endpoints.find(
			(e: Endpoint) => e.direction === 'in' && e.transferType === usb.LIBUSB_TRANSFER_TYPE_BULK
		) as InEndpoint | undefined;
		if (!out || !inEndpoint) throw new Error('no bulk IN/OUT endpoint pair');
		inEndpoint.timeout = USB_MODEL_QUERY_TIMEOUT_MS;
		await new Promise<void>((resolve, reject) => {
			out.transfer(GS_I_MODEL_NAME, (err) => (err ? reject(err) : resolve()));
		});
		const reply = await new Promise<Buffer>((resolve, reject) => {
			inEndpoint.transfer(USB_MODEL_REPLY_BYTES, (err, data) =>
				err ? reject(err) : resolve(data ?? Buffer.alloc(0))
			);
		});
		const model = parseUsbModelReply(reply);
		logger.info(
			`[usb] model query ${args.device}: ${model ?? '(no answer)'} in ${Date.now() - startedAt}ms`
		);
		return model;
	} catch (err) {
		logger.info(`[usb] model query ${args.device} failed: ${String(err)}`);
		return null;
	} finally {
		if (iface && claimed) {
			await new Promise<void>((resolve) => {
				try {
					iface?.release(true, () => resolve());
				} catch {
					resolve();
				}
			});
		}
		try {
			device.close();
		} catch {
			// already closed
		}
	}
});

handleIpc('usb-discovery', async (event): Promise<UsbPrinterInfo[]> => {
	// Windows: libusb can enumerate USB printers but cannot claim them — plug-and-play
	// binds usbprint.sys (or a vendor driver) to every USB printer, and libusb I/O
	// requires a WinUSB-class driver. Listing libusb devices here would offer printers
	// that can never print, so list the installed spooler queues instead; print-raw-usb
	// routes their `winspool:` keys through the spooler RAW datatype.
	if (process.platform === 'win32') {
		const printers = await listSpoolerPrinters(event.sender);
		return printers.map((p) => discoveredPrinter(p.id, p.name));
	}
	const printers = getDeviceList().filter(isPrinter);
	return Promise.all(
		printers.map(async (d) => {
			const id = deviceKey(d);
			return discoveredPrinter(id, (await readProductName(d)) ?? `USB printer (${id})`);
		})
	);
});

handleIpc(
	'print-raw-usb',
	async (_event, args: { device: string; data: number[] }): Promise<void> => {
		if (!args || typeof args.device !== 'string') {
			throw new Error('Invalid arguments: expected { device: string, data: number[] }');
		}
		const bytes = rawPrintBufferFromData(args.data);

		const target = parseTarget(args.device);
		if (target.kind === 'winspool') {
			if (process.platform !== 'win32') {
				throw new Error('Spooler device keys are only valid on Windows');
			}
			const printerName = target.queue;
			await printRawToSpooler(printerName, bytes);
			logger.info(`print-raw-usb spooled ${bytes.length} bytes to "${printerName}"`);
			return;
		}

		if (target.kind !== 'usb') throw new Error(`Invalid USB device key: ${args.device}`);

		if (process.platform === 'win32') {
			// A `usb:` key saved by an older version can never work here (usbprint.sys owns
			// the device); a fresh scan yields a working `winspool:` key.
			throw new Error(
				'Direct USB printing is not supported on Windows. Open the printer settings, re-scan for USB printers, and select your installed Windows printer.'
			);
		}

		const { vid, pid, bus: busNumber, address: deviceAddress } = target;

		const device = getDeviceList().find(
			(d) =>
				d.deviceDescriptor.idVendor === vid &&
				d.deviceDescriptor.idProduct === pid &&
				d.busNumber === busNumber &&
				d.deviceAddress === deviceAddress
		);
		if (!device) throw new Error(`USB printer ${args.device} not found`);

		await sendRawBytes(bytes, createUsbDelivery(args.device, device));
	}
);
