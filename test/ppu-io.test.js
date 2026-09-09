import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Nes, WasmCore } from '../dist/index.js';

const binary = await readFile(new URL('../dist-wasm/lib-jsnes.wasm', import.meta.url));
function image(code = []) {
  const bytes = new Uint8Array(16 + 0x4000);
  bytes.set([78, 69, 83, 26, 1, 0]); bytes.set(code, 16);
  bytes.set([0, 0x80], 16 + 0x3ffc);
  return bytes;
}

test('CPU writes to every mirrored PPU register refresh the I/O latch in both cores', async () => {
  const wasm = await WasmCore.from(binary);
  for (let reg = 0; reg < 8; reg++) {
    const code = [];
    for (let value = 0; value < 256; value++) code.push(
      0xa9, value, 0x8d, 0xf8 + reg, 0x3f,
      0xad, 0, 0x20, 0x85, 0, 0xad, 2, 0x20, 0x85, 1,
      0xad, 1, 0x20, 0x85, 2);
    const bytes = image(code), js = new Nes(bytes);
    js.reset(); wasm.loadRom(bytes); wasm.reset();
    for (let value = 0; value < 256; value++) {
      js.step(27); wasm.step(27);
      const expected = [value, value & 31, value & 31];
      assert.deepEqual([0, 1, 2].map(a => js.read(a)), expected, `${reg}:${value}`);
      assert.deepEqual([0, 1, 2].map(a => wasm.exports.ramRead(a)), expected, `${reg}:${value}`);
    }
  }
});

test('PPUDATA and OAM reads refresh the latch, with palette high bits and read-buffer behavior', async () => {
  const code = [], expected = [];
  const write = (a, v) => code.push(0xa9, v, 0x8d, a & 255, a >>> 8);
  const address = a => { write(0x2006, a >>> 8); write(0x2006, a & 255); };
  const read = (a, value) => { code.push(0xad, a & 255, a >>> 8, 0x85, expected.length); expected.push(value); };
  address(0x2f00); write(0x2007, 0x96);
  address(0x3f00); write(0x2007, 0x2a);
  for (const gray of [0, 1]) for (const high of [0, 64, 128, 192]) {
    write(0x2001, gray); address(0x3f00); write(0x2002, high | 15);
    const value = high | (gray ? 0x20 : 0x2a);
    read(0x2007, value); read(0x2000, value); read(0x2002, value & 31);
  }
  address(0x2000); read(0x2007, 0x96); read(0x2005, 0x96);
  read(0x2007, 0); read(0x2006, 0);
  write(0x2003, 0); write(0x2004, 0xa5); write(0x2003, 0);
  read(0x2004, 0xa5); read(0x2001, 0xa5); read(0x2002, 5);
  const stop = 0x8000 + code.length; code.push(0x4c, stop & 255, stop >>> 8);
  const bytes = image(code), js = new Nes(bytes), wasm = await WasmCore.from(binary);
  js.reset(); wasm.loadRom(bytes); wasm.reset(); js.step(3000); wasm.step(3000);
  assert.deepEqual(expected.map((_, i) => js.read(i)), expected);
  assert.deepEqual(expected.map((_, i) => wasm.exports.ramRead(i)), expected);
});

test('PPUSTATUS retains the previous high bits on the bus after acknowledging VBlank; snapshots preserve it', () => {
  const nes = new Nes(image()); nes.reset(); nes.write(0x2000, 0x80);
  nes.ppu.step(241 * 341 + 1);
  nes.write(0x2002, 0x1b); // Ignored register write still drives the I/O bus.
  assert.equal(nes.read(0x2002), 0x9b);
  assert.equal(nes.ppu.consumeNmi(), false);
  assert.equal(nes.read(0x2000), 0x9b);
  const state = nes.saveState(); nes.write(0x2001, 0); nes.loadState(state);
  assert.equal(nes.read(0x2006), 0x9b);
  assert.equal(nes.read(0x2002), 0x1b);
  assert.equal(nes.read(0x2003), 0x1b);
  const before = nes.saveState();
  assert.throws(() => nes.loadState(state.subarray(0, state.length - 1)), /Invalid state size/);
  assert.deepEqual(nes.saveState(), before);
  nes.reset(); assert.equal(nes.read(0x2000), 0);
});
