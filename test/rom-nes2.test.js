import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRom } from '../dist/index.js';

function image(prgByte, chrByte, sizeMsb, prgSize, chrSize, trainer = false) {
  const start = 16 + (trainer ? 512 : 0), bytes = new Uint8Array(start + prgSize + chrSize);
  bytes.set([78, 69, 83, 26, prgByte, chrByte, trainer ? 4 : 0, 8, 0, sizeMsb]);
  bytes.fill(0x77, 16, start); bytes.fill(0x31, start, start + prgSize); bytes.fill(0x62, start + prgSize);
  return bytes;
}

test('NES 2.0 exponent selectors come from byte 9 and sizes are expressed in bytes', () => {
  for (const [prg, chr, msb, prgSize, chrSize] of [
    [0x38, 1, 0x0f, 16384, 8192],
    [1, 0x34, 0xf0, 16384, 8192],
    [0x34, 0x30, 0xff, 8192, 4096],
    [0x3b, 0, 0x0f, 114688, 0],
    [1, 0x35, 0xf0, 16384, 24576],
  ]) {
    const bytes = image(prg, chr, msb, prgSize, chrSize, true);
    const parsed = parseRom(bytes);
    assert.equal(parsed.prgRom.length, prgSize); assert.equal(parsed.chrRom.length, chrSize);
    assert.equal(parsed.prgRom[0], 0x31); assert.equal(parsed.prgRom.at(-1), 0x31);
    if (chrSize) assert.equal(parsed.chrRom[0], 0x62);
    assert.equal(parsed.chrRam, chrSize === 0);
    assert.equal(parsed.trainer.length, 512);
    assert.throws(() => parseRom(bytes.subarray(0, bytes.length - 1)), /Truncated/);
  }
});

test('linear NES 2.0 sizes retain their low byte and high nibble', () => {
  for (const [prg, chr, msb, prgSize, chrSize] of [
    [0x3f, 0, 0, 63 * 16384, 0],
    [1, 0x3f, 0, 16384, 63 * 8192],
    [1, 1, 0x11, 257 * 16384, 257 * 8192],
  ]) {
    const bytes = image(prg, chr, msb, prgSize, chrSize);
    const parsed = parseRom(bytes);
    assert.equal(parsed.prgRom.length, prgSize); assert.equal(parsed.chrRom.length, chrSize);
  }
});

test('NES 2.0 mapper high bits do not include the submapper nibble', () => {
  const bytes = image(1, 0, 0, 16384, 0);
  bytes[6] = 0xb0; bytes[7] = 0xa8; bytes[8] = 0xf3;
  assert.equal(parseRom(bytes).mapper, 0x3ab);
  bytes[7] = 0xa0; bytes[9] = 0xff; // iNES ignores NES 2.0 extension bytes.
  assert.equal(parseRom(bytes).mapper, 0xab);
  assert.equal(parseRom(bytes).prgRom.length, 16384);
});
