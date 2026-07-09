import { ipcMain } from 'electron';
import { type Device, type Endpoint, getDeviceList, type OutEndpoint, usb } from 'usb';

import {
	buildUsbKey,
	connectionTypeForTarget,
	parseTarget,
} from '@wcpos/printer/transport/device-key';

import { logger } from './log';
import { listSpoolerPrinters, printRawToSpooler } from './winspool-printer';

const USB_PRINTER_CLASS = 0x07;

interface UsbPrinterInfo {
	id: string; // `usb:<vid>:<pid>:<bus>:<address>` or `winspool:<queue>` profile address
	name: string;
	connectionType: 'usb' | 'system';
	address: string;
	vendor: 'generic';
}

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

ipcMain.handle('usb-discovery', async (event): Promise<UsbPrinterInfo[]> => {
	// Windows: libusb can enumerate USB printers but cannot claim them — plug-and-play
	// binds usbprint.sys (or a vendor driver) to every USB printer, and libusb I/O
	// requires a WinUSB-class driver. Listing libusb devices here would offer printers
	// that can never print, so list the installed spooler queues instead; print-raw-usb
	// routes their `winspool:` keys through the spooler RAW datatype.
	if (process.platform === 'win32') {
		const printers = await listSpoolerPrinters(event.sender);
		return printers.map((p) => discoveredPrinter(p.id, p.name));
	}
	return getDeviceList()
		.filter(isPrinter)
		.map((d) => {
			const id = deviceKey(d);
			return discoveredPrinter(id, `USB printer (${id})`);
		});
});

ipcMain.handle(
	'print-raw-usb',
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

		const target = parseTarget(args.device);
		if (target.kind === 'winspool') {
			if (process.platform !== 'win32') {
				throw new Error('Spooler device keys are only valid on Windows');
			}
			const printerName = target.queue;
			await printRawToSpooler(printerName, Buffer.from(args.data));
			logger.info(`print-raw-usb spooled ${args.data.length} bytes to "${printerName}"`);
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

		device.open();
		// Select the printer-class interface — NOT blindly interfaces[0]. Composite devices and
		// printers with multiple interfaces can put the printer class elsewhere; claiming the wrong
		// one yields no OUT endpoint or a failed claim.
		const iface = device.interfaces?.find(
			(i) => i.descriptor.bInterfaceClass === USB_PRINTER_CLASS
		);
		if (!iface) {
			device.close();
			throw new Error('USB printer has no printer-class (0x07) interface');
		}

		try {
			// Kernel-driver detach exists for Linux, where usblp claims printer-class
			// interfaces; both calls throw LIBUSB_ERROR_NOT_SUPPORTED on other platforms.
			if (process.platform === 'linux' && iface.isKernelDriverActive()) {
				iface.detachKernelDriver();
			}
			iface.claim();

			const out = iface.endpoints.find(
				(e: Endpoint) => e.direction === 'out' && e.transferType === usb.LIBUSB_TRANSFER_TYPE_BULK
			) as OutEndpoint | undefined;
			if (!out) throw new Error('USB printer interface has no bulk OUT endpoint');

			await new Promise<void>((resolve, reject) => {
				out.transfer(Buffer.from(args.data), (err) => (err ? reject(err) : resolve()));
			});
			logger.info(`print-raw-usb sent ${args.data.length} bytes to ${args.device}`);
		} finally {
			// Always release + close, even if claim/transfer threw.
			await new Promise<void>((resolve) => iface.release(true, () => resolve()));
			device.close();
		}
	}
);
