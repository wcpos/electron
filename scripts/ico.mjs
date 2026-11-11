// Read, check and repair Windows .ico files with Node built-ins only.
// Squirrel's install window loads icons/icon.ico through WPF BitmapFrame.Create,
// and Windows' ICO decoder (WIC) rejects PNG entries that are not 32-bit RGBA
// (0x88982F60 "The image is unrecognized"), which kills Update.exe mid-install.
import { crc32, deflateSync, inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEADER_SIZE = 6;
const DIR_ENTRY_SIZE = 16;
const CHANNELS = { 2: 3, 6: 4 }; // PNG colour type -> bytes per pixel at bit depth 8

export function readIco(buf) {
  if (buf.length < HEADER_SIZE) throw new Error(`ico header: file is ${buf.length} bytes, need at least ${HEADER_SIZE}`);
  const reserved = buf.readUInt16LE(0);
  const type = buf.readUInt16LE(2);
  const count = buf.readUInt16LE(4);
  if (reserved !== 0 || type !== 1) throw new Error(`ico header: reserved=${reserved} type=${type}, expected reserved=0 type=1`);
  if (count === 0) throw new Error("ico header: count is 0, the file has no images");
  const dirEnd = HEADER_SIZE + count * DIR_ENTRY_SIZE;
  if (dirEnd > buf.length) throw new Error(`ico directory: ${count} entries need ${dirEnd} bytes, file is ${buf.length}`);
  const entries = [];
  for (let index = 0; index < count; index++) {
    const at = HEADER_SIZE + index * DIR_ENTRY_SIZE;
    const width = buf[at] || 256;
    const height = buf[at + 1] || 256;
    const bitCount = buf.readUInt16LE(at + 6);
    const size = buf.readUInt32LE(at + 8);
    const offset = buf.readUInt32LE(at + 12);
    if (offset + size > buf.length) {
      throw new Error(`entry ${index} (${width}x${height}): offset ${offset} + size ${size} runs past the end of the file (${buf.length} bytes)`);
    }
    const data = buf.subarray(offset, offset + size);
    const format = data.length >= 8 && data.subarray(0, 8).equals(PNG_SIGNATURE) ? "png" : "dib";
    entries.push({ index, width, height, bitCount, format, data });
  }
  return { entries };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("png: bad signature");
  let ihdr = null;
  const idat = [];
  let at = 8;
  for (;;) {
    if (at + 12 > buf.length) throw new Error("png: truncated before IEND");
    const length = buf.readUInt32BE(at);
    const end = at + 12 + length;
    if (end > buf.length) throw new Error(`png: chunk at ${at} runs past the end of the data`);
    const type = buf.toString("latin1", at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + length);
    if (crc32(buf.subarray(at + 4, at + 8 + length)) !== buf.readUInt32BE(at + 8 + length)) {
      throw new Error(`png: CRC mismatch in ${type} chunk`);
    }
    if (type === "IHDR") ihdr = body;
    else if (type === "IDAT") idat.push(body);
    at = end;
    if (type === "IEND") break;
  }
  if (!ihdr || ihdr.length !== 13) throw new Error("png: missing or malformed IHDR");
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const interlace = ihdr[12];
  if (bitDepth !== 8) throw new Error(`png: unsupported bit depth ${bitDepth} (only 8)`);
  if (!(colorType in CHANNELS)) throw new Error(`png: unsupported colour type ${colorType} (only 2 or 6)`);
  if (interlace !== 0) throw new Error(`png: unsupported interlace method ${interlace} (only 0)`);
  const bpp = CHANNELS[colorType];
  const stride = width * bpp;
  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch (error) {
    throw new Error(`png: IDAT does not inflate: ${error.message}`);
  }
  if (raw.length !== height * (stride + 1)) {
    throw new Error(`png: inflated data is ${raw.length} bytes, expected ${height * (stride + 1)}`);
  }
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? pixels[row + x - bpp] : 0;
      const b = y > 0 ? pixels[row - stride + x] : 0;
      const c = x >= bpp && y > 0 ? pixels[row - stride + x - bpp] : 0;
      let predictor;
      if (filter === 0) predictor = 0;
      else if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) predictor = paeth(a, b, c);
      else throw new Error(`png: unknown filter type ${filter} on row ${y}`);
      pixels[row + x] = (raw[src + x] + predictor) & 0xff;
    }
  }
  return { width, height, bitDepth, colorType, pixels };
}

function chunk(type, data) {
  const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(8 + typeAndData.length);
  out.writeUInt32BE(data.length, 0);
  typeAndData.copy(out, 4);
  out.writeUInt32BE(crc32(typeAndData), 4 + typeAndData.length);
  return out;
}

export function encodePngRgba(width, height, rgba) {
  const stride = width * 4;
  if (rgba.length !== height * stride) throw new Error(`png: rgba is ${rgba.length} bytes, expected ${height * stride}`);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const raw = Buffer.alloc(height * (stride + 1)); // filter byte 0 (None) on every row
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

export function icoProblems(buf) {
  let entries;
  try {
    ({ entries } = readIco(buf));
  } catch (error) {
    return [error.message];
  }
  const problems = [];
  for (const { index, width, height, format, data } of entries) {
    const name = `entry ${index} (${width}x${height})`;
    if (format === "png") {
      let png;
      try {
        png = decodePng(data);
      } catch (error) {
        problems.push(`${name}: ${error.message}`);
        continue;
      }
      if (png.colorType !== 6) problems.push(`${name}: PNG colour type ${png.colorType} has no alpha (Windows needs 6, RGBA)`);
      if (png.width !== width || png.height !== height) {
        problems.push(`${name}: PNG is ${png.width}x${png.height}, directory says ${width}x${height}`);
      }
    } else {
      if (data.length < 40) {
        problems.push(`${name}: DIB is ${data.length} bytes, shorter than a BITMAPINFOHEADER`);
        continue;
      }
      const biSize = data.readUInt32LE(0);
      const biHeight = data.readInt32LE(8);
      const biBitCount = data.readUInt16LE(14);
      if (biSize !== 40) problems.push(`${name}: DIB biSize ${biSize}, expected 40`);
      if (biBitCount !== 32) problems.push(`${name}: DIB biBitCount ${biBitCount}, expected 32`);
      if (biHeight !== 2 * height) problems.push(`${name}: DIB biHeight ${biHeight}, expected ${2 * height}`);
    }
  }
  return problems;
}

export function icoWithRgbaPngs(buf) {
  const { entries } = readIco(buf);
  const images = entries.map(({ format, data }) => {
    if (format !== "png") return data;
    let png;
    try {
      png = decodePng(data);
    } catch {
      return data; // left as is; icoProblems reports why it does not decode
    }
    if (png.colorType !== 2) return data;
    const rgba = Buffer.alloc(png.width * png.height * 4, 0xff); // alpha 255
    for (let p = 0; p < png.width * png.height; p++) png.pixels.copy(rgba, p * 4, p * 3, p * 3 + 3);
    return encodePngRgba(png.width, png.height, rgba);
  });
  const dirEnd = HEADER_SIZE + entries.length * DIR_ENTRY_SIZE;
  const head = Buffer.from(buf.subarray(0, dirEnd)); // header and directory, fields kept
  let offset = dirEnd;
  images.forEach((image, index) => {
    const at = HEADER_SIZE + index * DIR_ENTRY_SIZE;
    head.writeUInt32LE(image.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += image.length;
  });
  return Buffer.concat([head, ...images]);
}
