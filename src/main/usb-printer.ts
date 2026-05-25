import { ipcMain } from 'electron';
import { type Device, type Endpoint, getDeviceList, type OutEndpoint, usb } from 'usb';

import { logger } from './log';

const USB_PRINTER_CLASS = 0x07;

interface UsbPrinterInfo {
	id: string; // `usb:<vid>:<pid>:<bus>:<address>` — stored as the profile address
	name: string;
	vendorId: number;
	productId: number;
}

function deviceKey(d: Device): string {
	const { idVendor, idProduct } = d.deviceDescriptor;
	return `usb:${idVendor}:${idProduct}:${d.busNumber}:${d.deviceAddress}`;
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

ipcMain.handle('usb-discovery', async (): Promise<UsbPrinterInfo[]> => {
	return getDeviceList()
		.filter(isPrinter)
		.map((d) => ({
			id: deviceKey(d),
			name: `USB printer (${deviceKey(d)})`,
			vendorId: d.deviceDescriptor.idVendor,
			productId: d.deviceDescriptor.idProduct,
		}));
});

ipcMain.handle(
	'print-raw-usb',
	async (_event, args: { device: string; data: number[] }): Promise<void> => {
		const match = /^usb:(\d+):(\d+):(\d+):(\d+)$/.exec(args.device);
		if (!match) throw new Error(`Invalid USB device key: ${args.device}`);
		const [vid, pid, busNumber, deviceAddress] = match.slice(1).map(Number);

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
			if (iface.isKernelDriverActive()) iface.detachKernelDriver();
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
