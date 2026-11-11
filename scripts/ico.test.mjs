import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { decodePng, encodePngRgba, icoProblems, icoWithRgbaPngs, readIco } from "./ico.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Varied, non-uniform channel values so a wrong predictor or channel shift shows up.
function pixelBytes(width, height, channels, seed = 0) {
  const out = Buffer.alloc(width * height * channels);
  for (let i = 0; i < out.length; i++) out[i] = (i * 37 + ((i * i) % 251) + seed * 59) & 0xff;
  return out;
}

function pngChunk(type, data) {
  const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// Build a PNG (bit depth 8) with the given filter type applied to every row.
function makePng(width, height, colorType, pixels, filterType = 0) {
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = filterType;
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x;
      const a = x >= bpp ? pixels[at - bpp] : 0;
      const b = y > 0 ? pixels[at - stride] : 0;
      const c = x >= bpp && y > 0 ? pixels[at - stride - bpp] : 0;
      const predictor = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filterType];
      raw[y * (stride + 1) + 1 + x] = (pixels[at] - predictor) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([SIGNATURE, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

// entries: [{ width, height, data, bitCount? }]; images laid out after the directory.
function makeIco(entries) {
  const head = Buffer.alloc(6 + entries.length * 16);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  let offset = head.length;
  entries.forEach(({ width, height, data, bitCount = 32 }, i) => {
    const at = 6 + i * 16;
    head[at] = width === 256 ? 0 : width;
    head[at + 1] = height === 256 ? 0 : height;
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE(bitCount, at + 6);
    head.writeUInt32LE(data.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...entries.map((e) => e.data)]);
}

function rgbIco(sizes) {
  return makeIco(sizes.map((size, i) => ({ width: size, height: size, data: makePng(size, size, 2, pixelBytes(size, size, 3, i)) })));
}

test("the shipped icons/icon.ico has no problems", () => {
  const buf = readFileSync(join(root, "icons/icon.ico"));
  assert.deepEqual(icoProblems(buf), []);
  const { entries } = readIco(buf);
  assert.equal(entries.length, 7);
  assert.ok(entries.every((e) => e.format === "png"));
});

test("an RGB PNG entry is reported as having no alpha", () => {
  const problems = icoProblems(rgbIco([16]));
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes("entry 0 (16x16)"), problems[0]);
  assert.ok(problems[0].includes("no alpha"), problems[0]);
});

test("a PNG whose size disagrees with the directory is reported", () => {
  const ico = makeIco([{ width: 32, height: 32, data: makePng(16, 16, 6, pixelBytes(16, 16, 4)) }]);
  const problems = icoProblems(ico);
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes("entry 0 (32x32)"), problems[0]);
});

test("an entry past the end of the file is reported", () => {
  const ico = makeIco([{ width: 16, height: 16, data: encodePngRgba(16, 16, pixelBytes(16, 16, 4)) }]);
  assert.deepEqual(icoProblems(ico), []);
  const cut = ico.subarray(0, ico.length - 10);
  let problems;
  assert.doesNotThrow(() => (problems = icoProblems(cut)));
  assert.ok(problems.length >= 1);
});

test("a PNG with a bad CRC is reported", () => {
  const png = encodePngRgba(16, 16, pixelBytes(16, 16, 4));
  const idat = png.indexOf("IDAT", 8, "latin1");
  png[idat + 4 + 2] ^= 0xff; // a byte inside the IDAT data
  const problems = icoProblems(makeIco([{ width: 16, height: 16, data: png }]));
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes("entry 0 (16x16)"), problems[0]);
  assert.ok(problems[0].includes("CRC"), problems[0]);
});

test("decodePng undoes filter types 0 to 4", () => {
  const pixels = pixelBytes(5, 3, 3, 7);
  for (const filterType of [0, 1, 2, 3, 4]) {
    const png = decodePng(makePng(5, 3, 2, pixels, filterType));
    assert.equal(png.width, 5);
    assert.equal(png.height, 3);
    assert.equal(png.colorType, 2);
    assert.deepEqual(png.pixels, pixels, `filter type ${filterType}`);
  }
});

test("icoWithRgbaPngs keeps every RGB value and sets alpha 255", () => {
  const input = rgbIco([16, 32]);
  const output = icoWithRgbaPngs(input);
  const before = readIco(input).entries;
  const after = readIco(output).entries;
  assert.equal(after.length, 2);
  for (let i = 0; i < 2; i++) {
    const rgb = decodePng(before[i].data);
    const rgba = decodePng(after[i].data);
    assert.equal(rgba.colorType, 6);
    assert.equal(rgba.width, rgb.width);
    assert.equal(rgba.height, rgb.height);
    for (let p = 0; p < rgb.width * rgb.height; p++) {
      assert.deepEqual(rgba.pixels.subarray(p * 4, p * 4 + 3), rgb.pixels.subarray(p * 3, p * 3 + 3));
      assert.equal(rgba.pixels[p * 4 + 3], 255);
    }
  }
  assert.deepEqual(icoProblems(output), []);
});

test("icoWithRgbaPngs copies a DIB entry byte for byte", () => {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(16, 4);
  header.writeInt32LE(32, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const dib = Buffer.concat([header, pixelBytes(16, 16, 4, 3), Buffer.alloc(16 * 4, 0)]); // XOR pixels + AND mask
  const input = makeIco([
    { width: 16, height: 16, data: dib },
    { width: 32, height: 32, data: makePng(32, 32, 2, pixelBytes(32, 32, 3)) },
  ]);
  const after = readIco(icoWithRgbaPngs(input)).entries;
  assert.equal(after[0].format, "dib");
  assert.deepEqual(after[0].data, dib);
  assert.equal(decodePng(after[1].data).colorType, 6);
});

test("the ico-rgba CLI fixes an RGB icon and exits 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "ico-rgba-"));
  const input = join(dir, "in.ico");
  const output = join(dir, "out.ico");
  writeFileSync(input, rgbIco([16, 48]));
  const run = spawnSync(process.execPath, [join(root, "scripts/ico-rgba.mjs"), input, output], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stdout.startsWith("ok "), run.stdout);
  assert.deepEqual(icoProblems(readFileSync(output)), []);
});
