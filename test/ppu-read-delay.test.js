import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Nes, WasmCore } from '../dist/index.js';

function rom(code = []) {
  const bytes = new Uint8Array(16 + 16384); bytes.set([78, 69, 83, 26, 1, 0]);
  bytes.set(code, 16); bytes.set([0, 0x80], 16 + 0x3ffc); return bytes;
}

test('PPUDATA recovery suppresses address/buffer updates without extending the deadline', () => {
  for (const address of [0x2000, 0x3f00]) for (let gap = 0; gap <= 6; gap++) {
    const nes = new Nes(rom()), ppu = nes.ppu; nes.reset();
    ppu.vram.set([0x11, 0x22, 0x33], 0x2000); ppu.palette.set([0x21, 0x32]);
    ppu.writeRegister(6, address >>> 8); ppu.writeRegister(6, 0);
    const first = ppu.readRegister(7); ppu.step(gap);
    const before = ppu.saveState();
    const next = ppu.readRegister(0x3fff);
    assert.equal(next, gap < 6 ? first : address === 0x2000 ? 0x11 : 0x32);
    if (gap < 6) {
      assert.deepEqual(ppu.saveState(), before, 'ignored read changes neither latch, buffer nor timing');
      ppu.step(6 - gap);
      assert.equal(ppu.readRegister(7), address === 0x2000 ? 0x11 : 0x32);
    }
  }
});

test('read recovery replays across scanline/frame boundaries and rejects invalid snapshots atomically', () => {
  for (const dots of [340, 262 * 341 - 2]) {
    const nes = new Nes(rom()), ppu = nes.ppu; nes.reset(); ppu.step(dots);
    ppu.writeRegister(6, 0x20); ppu.writeRegister(6, 0); ppu.readRegister(7);
    const state = nes.saveState(); ppu.step(6);
    const expected = nes.saveState(); nes.loadState(state);
    for (let i = 0; i < 6; i++) ppu.step(1);
    assert.deepEqual(nes.saveState(), expected);
    const invalid = ppu.saveState(); invalid[invalid.length - 12] = 7;
    assert.throws(() => ppu.loadState(invalid), /Invalid PPU state/);
    assert.deepEqual(nes.saveState(), expected);
    assert.throws(() => nes.loadState(state.subarray(0, state.length - 1)), /Invalid state size/);
    ppu.reset(); assert.equal(ppu.saveState().at(-12), 0);
  }
});

test('indexed dummy and real PPUDATA reads share the recovery window in JS and WASM', async () => {
  const code = [], write = (a, v) => code.push(0xa9, v, 0x8d, a & 255, a >>> 8);
  write(0x2006, 0x20); write(0x2006, 0);
  for (const v of [0x11, 0x22, 0x33, 0x44]) write(0x2007, v);
  write(0x2006, 0x20); write(0x2006, 0);
  code.push(0xad, 7, 0x20, 0xa2, 0x10, 0xbd, 0xf7, 0x20, 0x85, 0,
    0xad, 7, 0x20, 0x85, 1, 0x02);
  const bytes = rom(code), js = new Nes(bytes), wasm = await WasmCore.from(await readFile('dist-wasm/lib-jsnes.wasm'));
  js.reset(); wasm.loadRom(bytes); wasm.reset(); js.step(200); wasm.step(200);
  assert.deepEqual([js.read(0), js.read(1)], [0x11, 0x22]);
  assert.deepEqual([0, 1].map(i => wasm.exports.ramRead(i)), [0x11, 0x22]);
  assert.equal(wasm.cycleCount, js.cycleCount); assert.equal(wasm.programCounter, js.cpu.pc);
});
