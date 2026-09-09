import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Nes, WasmCore } from '../dist/index.js';

const binary = await readFile(new URL('../dist-wasm/lib-jsnes.wasm', import.meta.url));
function rom(code) {
  const bytes = new Uint8Array(16 + 0x4000); bytes.set([78, 69, 83, 26, 1, 0]);
  bytes.set(code, 16); bytes.set([0, 0x80], 16 + 0x3ffc); return bytes;
}

test('OAMDATA masks attribute bits 2-4 only at the attribute byte in both cores', async () => {
  const code = [0xa9, 2, 0x8d, 3, 0x20, 0xa9, 0xff, 0x8d, 4, 0x20,
    0xa9, 3, 0x8d, 3, 0x20, 0xa9, 0xff, 0x8d, 4, 0x20,
    0xa9, 2, 0x8d, 3, 0x20, 0xad, 4, 0x20, 0x85, 0,
    0xa9, 3, 0x8d, 3, 0x20, 0xad, 4, 0x20, 0x85, 1,
    0x4c, 0x1e, 0x80];
  const image = rom(code), js = new Nes(image), wasm = await WasmCore.from(binary);
  js.reset(); wasm.loadRom(image); wasm.reset();
  js.step(100); wasm.step(100);
  assert.equal(js.read(0), 0xe3); assert.equal(js.read(1), 0xff);
  assert.equal(wasm.exports.ramRead(0), 0xe3); assert.equal(wasm.exports.ramRead(1), 0xff);
  assert.equal(wasm.exports.unknownOpcodeCount(), 0);
});

test('OAMDATA mask survives snapshots and OAM DMA wrapping', () => {
  const bytes = rom([]), nes = new Nes(bytes); nes.reset();
  nes.ppu.oam.fill(0xff); nes.write(0x2003, 0x02);
  const state = nes.saveState(); assert.equal(nes.read(0x2004), 0xe3);
  nes.write(0x2003, 0); nes.loadState(state); assert.equal(nes.read(0x2004), 0xe3);
  nes.write(0, 2); nes.write(0x4014, 0); nes.step(513); nes.write(0x2003, 2); assert.equal(nes.read(0x2004), 0x02);
});
