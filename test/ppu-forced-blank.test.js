import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Nes, WasmCore, NES_PALETTE } from '../dist/index.js';

function rom(code = []) {
  const bytes = new Uint8Array(16 + 16384); bytes.set([78, 69, 83, 26, 1, 0]);
  bytes.set(code, 16); bytes.set([0, 0x80], 16 + 16384 - 4); return bytes;
}
function address(nes, at) { nes.read(0x2002); nes.write(0x2006, at >>> 8); nes.write(0x2006, at & 255); }
const rgb = code => (0xff000000 | NES_PALETTE[code]) >>> 0;

test('forced blank selects the addressed palette entry and its mirrors for all palette addresses', () => {
  const nes = new Nes(rom()); nes.reset();
  for (let i = 0; i < 32; i++) nes.ppu.palette[i] = (i + 16) & 63;
  for (const mask of [0, 1, 6, 8, 16, 24]) for (let at = 0x3f00; at <= 0x3fff; at++) {
    address(nes, at); nes.write(0x2001, mask);
    nes.ppu.scanline = 0; nes.ppu.dot = 0; nes.ppu.step(256);
    const index = mask & 24 ? 0 : (at & 3) === 0 ? at & 15 : at & 31;
    const code = nes.ppu.palette[index] & (mask & 1 ? 0x30 : 0x3f);
    assert.equal(nes.frame[200], rgb(code), `address ${at.toString(16)}, mask ${mask}`);
  }
  for (const at of [0, 0x2000, 0x3eff]) {
    address(nes, at); nes.write(0x2001, 0); nes.ppu.scanline = 0; nes.ppu.dot = 0; nes.ppu.step(256);
    assert.equal(nes.frame[0], rgb(nes.ppu.palette[0]));
  }
});

test('forced-blank color changes affect future scanlines, including after snapshot restoration', () => {
  const nes = new Nes(rom()); nes.reset(); nes.ppu.palette[0] = 0x0f;
  nes.ppu.palette[1] = 0x16; nes.ppu.palette[2] = 0x2a;
  address(nes, 0x3f01); nes.ppu.step(341 * 120);
  assert.equal(nes.frame[0], rgb(0x16));
  nes.read(0x2007); // Auto-increment v to palette entry 2.
  const saved = nes.saveState();
  nes.ppu.step(341 * 120); const expected = nes.frame.slice();
  assert.equal(nes.frame[119 * 256], rgb(0x16));
  assert.equal(nes.frame[120 * 256], rgb(0x2a));
  nes.reset(); nes.loadState(saved); nes.ppu.step(341 * 120);
  assert.deepEqual(nes.frame, expected);
});

test('CPU-driven palette-address blanking renders matching known pixels in WASM', async () => {
  const binary = await readFile(new URL('../dist-wasm/lib-jsnes.wasm', import.meta.url));
  const wasm = await WasmCore.from(binary);
  for (const at of [0x3f01, 0x3f11, 0x3f14, 0x3ff1, 0x2000]) for (const mask of [0, 1, 8, 16]) {
    const code = [], write = (a, v) => code.push(0xa9, v, 0x8d, a & 255, a >>> 8);
    write(0x2006, 0x3f); write(0x2006, 0);
    const palette = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      write(0x2007, (i + 16) & 63);
      palette[(i & 3) === 0 ? i & 15 : i] = (i + 16) & 63;
    }
    write(0x2006, at >>> 8); write(0x2006, at & 255); write(0x2001, mask);
    const stop = 0x8000 + code.length; code.push(0x4c, stop & 255, stop >>> 8);
    const bytes = rom(code), js = new Nes(bytes); js.reset(); wasm.loadRom(bytes); wasm.reset();
    js.runFrame(); wasm.runFrame();
    const selected = !(mask & 24) && at >= 0x3f00 ? ((at & 3) === 0 ? at & 15 : at & 31) : 0;
    const expected = rgb(palette[selected] & (mask & 1 ? 0x30 : 0x3f));
    assert.equal(js.frame[239 * 256 + 200], expected);
    assert.equal(wasm.frame()[239 * 256 + 200], expected);
    assert.deepEqual(wasm.frame(), js.frame);
  }
});
