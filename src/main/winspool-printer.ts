import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { logger } from './log';

import type { WebContents } from 'electron';

/**
 * Windows raw printing via the print spooler.
 *
 * libusb cannot perform I/O on a Windows device unless it is bound to a WinUSB-class
 * driver, and Windows plug-and-play binds usbprint.sys (or a vendor driver) to every
 * USB printer — so the libusb path in usb-printer.ts is a dead end on win32. Instead
 * we write ESC/POS bytes to the installed printer queue with the spooler RAW datatype
 * (OpenPrinterW / StartDocPrinterW pDatatype="RAW" / WritePrinter), which passes them
 * to the device unmodified. This is the same approach QZ Tray uses.
 */

export const WINSPOOL_PREFIX = 'winspool:';

export interface SpoolerPrinterInfo {
	id: string; // `winspool:<queue name>` — stored as the profile address
	name: string;
}

// Spooler queues that exist on every Windows install but can never be a receipt printer.
const VIRTUAL_PRINTER_NAMES = new Set([
	'Microsoft Print to PDF',
	'Microsoft XPS Document Writer',
	'OneNote (Desktop)',
	'OneNote for Windows 10',
	'Fax',
]);

export function filterSpoolerPrinters(
	printers: { name: string; displayName?: string }[]
): SpoolerPrinterInfo[] {
	return printers
		.filter((p) => !VIRTUAL_PRINTER_NAMES.has(p.name))
		.map((p) => ({
			// OpenPrinterW needs the queue name, not the display name — the id must carry `name`.
			id: `${WINSPOOL_PREFIX}${p.name}`,
			name: p.displayName || p.name,
		}));
}

export async function listSpoolerPrinters(sender: WebContents): Promise<SpoolerPrinterInfo[]> {
	const printers = await sender.getPrintersAsync();
	return filterSpoolerPrinters(printers);
}

// Classic RawPrinterHelper (winspool.drv P/Invoke), compiled in-process by Windows
// PowerShell 5.1 which ships with every Windows 10/11. Printer name and payload path
// arrive via environment variables so no user-controlled string is interpolated into
// the script. Wide (W) entry points are used throughout so non-ASCII queue names work.
export const RAW_PRINT_PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
	Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class WcposRawPrinter
{
	[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
	public class DOC_INFO_1
	{
		[MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
		[MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
		[MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
	}

	[DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
	static extern bool OpenPrinter(string printerName, out IntPtr hPrinter, IntPtr printerDefaults);

	[DllImport("winspool.drv", SetLastError = true)]
	static extern bool ClosePrinter(IntPtr hPrinter);

	[DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
	static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In] DOC_INFO_1 docInfo);

	[DllImport("winspool.drv", SetLastError = true)]
	static extern bool EndDocPrinter(IntPtr hPrinter);

	[DllImport("winspool.drv", SetLastError = true)]
	static extern bool StartPagePrinter(IntPtr hPrinter);

	[DllImport("winspool.drv", SetLastError = true)]
	static extern bool EndPagePrinter(IntPtr hPrinter);

	[DllImport("winspool.drv", SetLastError = true)]
	static extern bool WritePrinter(IntPtr hPrinter, byte[] bytes, int count, out int written);

	static void Check(bool ok, string what)
	{
		if (!ok)
			throw new Exception(what + " failed (win32 error " + Marshal.GetLastWin32Error() + ")");
	}

	public static void Send(string printerName, byte[] bytes)
	{
		IntPtr hPrinter;
		Check(OpenPrinter(printerName, out hPrinter, IntPtr.Zero), "OpenPrinter(\\"" + printerName + "\\")");
		try
		{
			DOC_INFO_1 docInfo = new DOC_INFO_1();
			docInfo.pDocName = "WooCommerce POS receipt";
			docInfo.pOutputFile = null;
			docInfo.pDataType = "RAW";
			Check(StartDocPrinter(hPrinter, 1, docInfo), "StartDocPrinter");
			try
			{
				Check(StartPagePrinter(hPrinter), "StartPagePrinter");
				try
				{
					int written;
					Check(WritePrinter(hPrinter, bytes, bytes.Length, out written), "WritePrinter");
					if (written != bytes.Length)
						throw new Exception("WritePrinter wrote " + written + " of " + bytes.Length + " bytes");
				}
				finally { EndPagePrinter(hPrinter); }
			}
			finally { EndDocPrinter(hPrinter); }
		}
		finally { ClosePrinter(hPrinter); }
	}
}
'@
	$bytes = [System.IO.File]::ReadAllBytes($env:WCPOS_RAW_PRINT_FILE)
	[WcposRawPrinter]::Send($env:WCPOS_RAW_PRINT_PRINTER, $bytes)
	exit 0
} catch {
	[Console]::Error.WriteLine($_.Exception.Message)
	exit 1
}
`;

// -EncodedCommand expects base64 over UTF-16LE.
export function encodePsCommand(script: string): string {
	return Buffer.from(script, 'utf16le').toString('base64');
}

const PRINT_TIMEOUT_MS = 20_000; // renderer gives up at 30s — fail first with a real error

export async function printRawToSpooler(printerName: string, data: Buffer): Promise<void> {
	const tmpFile = path.join(os.tmpdir(), `wcpos-raw-print-${randomBytes(8).toString('hex')}.bin`);
	await writeFile(tmpFile, data);
	try {
		await runRawPrintScript(printerName, tmpFile);
		logger.info(`winspool sent ${data.length} bytes to "${printerName}"`);
	} finally {
		await unlink(tmpFile).catch(() => {});
	}
}

function runRawPrintScript(printerName: string, file: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const child = spawn(
			'powershell.exe',
			[
				'-NoProfile',
				'-NonInteractive',
				'-ExecutionPolicy',
				'Bypass',
				'-EncodedCommand',
				encodePsCommand(RAW_PRINT_PS_SCRIPT),
			],
			{
				env: {
					...process.env,
					WCPOS_RAW_PRINT_PRINTER: printerName,
					WCPOS_RAW_PRINT_FILE: file,
				},
				windowsHide: true,
				stdio: ['ignore', 'ignore', 'pipe'],
			}
		);

		let settled = false;
		let stderr = '';

		const finish = (err?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (err) {
				logger.error(`winspool print to "${printerName}" failed: ${err.message}`);
				reject(err);
			} else {
				resolve();
			}
		};

		const timeout = setTimeout(() => {
			child.kill();
			finish(new Error(`Spooler print to "${printerName}" timed out after ${PRINT_TIMEOUT_MS}ms`));
		}, PRINT_TIMEOUT_MS);

		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on('error', (err) => finish(err));
		child.on('close', (code) => {
			if (code === 0) finish();
			else
				finish(
					new Error(
						`Spooler print to "${printerName}" failed (exit ${code}): ${
							stderr.trim().slice(0, 500) || 'no error output'
						}`
					)
				);
		});
	});
}
