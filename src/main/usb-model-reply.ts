/**
 * `GS I 67` (0x1d 0x49 0x43) asks an ESC/POS printer for its model name. Epson answers
 * `_TM-m30III` NUL-terminated; clones answer nothing, garbage, or the same shape. Keep only
 * printable ASCII and drop the leading underscore so the model table can match the string.
 */
export function parseUsbModelReply(reply: Uint8Array | Buffer | number[]): string | null {
	const text = Array.from(reply)
		.filter((byte) => byte >= 0x20 && byte <= 0x7e)
		.map((byte) => String.fromCharCode(byte))
		.join('')
		.replace(/^_+/, '')
		.trim();
	return text.length >= 2 ? text : null;
}
