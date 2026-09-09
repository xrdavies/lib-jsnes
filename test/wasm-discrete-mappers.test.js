import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Nes, WasmCore, NES_PALETTE } from '../dist/index.js';

const binary = await readFile(new URL('../dist-wasm/lib-jsnes.wasm', import.meta.url));
function image(mapper, code, banks = 8, chr = 0, flags = 0) {
  const bytes = new Uint8Array(16 + banks * 0x4000 + chr * 0x2000);
  bytes.set([78, 69, 83, 26, banks, chr, ((mapper & 15) << 4) | flags, mapper & 0xf0]);
  const end = 0x8100 + code.length;
  for (let i = 0; i < banks; i++) {
    const at = 16 + i * 0x4000;
    bytes.fill(i, at, at + 0x4000);
    // Bank switches retain executable instructions at the same CPU address.
    bytes.set([...code, 0x4c, end & 255, end >>> 8], at + 0x100);
    bytes.set([0, 0x81], at + 0x3ffc);
  }
  for (let i = 0; i < chr; i++) bytes.fill(0x80 + i, 16 + banks * 0x4000 + i * 0x2000, 16 + banks * 0x4000 + (i + 1) * 0x2000);
  return bytes;
}

for (const mapper of [87, 140, 177, 241]) test(`mapper ${mapper} decodes every register byte, aliases and ignored writes in both cores`, async () => {
  const low = mapper === 87 || mapper === 140;
  const wasm = await WasmCore.from(binary);
  for (const banks of [1, 2, 64]) for (const register of low ? [0x6000, 0x7fff] : [0x8000, 0xffff]) {
    const ignored = low ? 0x8000 : 0x7fff;
    const code = [0xad, 0, 0x80, 0x85, 0, 0xad, 0, 0xc0, 0x85, 1];
    for (let value = 0; value < 256; value++) code.push(
      0xa9, value, 0x8d, register & 255, register >>> 8,
      0xa9, 0, 0x8d, ignored & 255, ignored >>> 8,
      0xad, 0, 0x80, 0x85, 0, 0xad, 0, 0xc0, 0x85, 1);
    const chr = mapper === 87 ? 4 : mapper === 140 ? 16 : 1;
    const bytes = image(mapper, code, banks, chr), js = new Nes(bytes);
    js.reset(); wasm.loadRom(bytes); wasm.reset();
    js.step(14); wasm.step(14);
    assert.deepEqual([0, 1].map(i => wasm.exports.ramRead(i)), [0, 1 % banks]);
    wasm.loadBatteryRam(new Uint8Array(8192).fill(0x59));
    js.loadBatteryRam(new Uint8Array(8192).fill(0x59));
    for (let value = 0; value < 256; value++) {
      js.step(26); wasm.step(26);
      const bank = mapper === 87 ? 0 : mapper === 140 ? (value >>> 4) & 3 : value & 31;
      const pattern = mapper === 87 ? [0, 2, 1, 3][value & 3] : mapper === 140 ? value & 15 : 0;
      const expected = [bank * 2 % banks, (bank * 2 + 1) % banks];
      assert.deepEqual([js.read(0), js.read(1)], expected);
      assert.deepEqual([0, 1].map(i => wasm.exports.ramRead(i)), expected);
      for (const address of [0, 0x1000, 0x1fff]) {
        assert.equal(js.cartridge.readChr(address), 0x80 + pattern);
        assert.equal(wasm.exports.chrRead(address), 0x80 + pattern);
      }
    }
    if (low) assert.ok(wasm.saveBatteryRam().every(v => v === 0x59), 'register writes must not write PRG RAM');
    js.step(30000); wasm.step(30000);
    assert.deepEqual(wasm.frame(), js.frame);
    assert.deepEqual(wasm.audioSamples(), js.audioSamples());
    assert.equal(wasm.programCounter, js.cpu.pc);
    assert.equal(wasm.exports.unknownOpcodeCount(), 0);
    js.reset(); wasm.reset();
    assert.equal(wasm.exports.chrRead(0), 0x80);
    js.step(14); wasm.step(14);
    assert.deepEqual([0, 1].map(i => wasm.exports.ramRead(i)), [0, 1 % banks]);
  }
});

for (const mapper of [79, 113]) test(`mapper ${mapper} selects only its wired bank bits across expansion-register aliases`, async () => {
  const wasm = await WasmCore.from(binary);
  for (const banks of [1, 16]) for (const register of [0x4100, 0x4b22, 0x5fff]) {
    const code = [];
    for (let value = 0; value < 256; value++) {
      code.push(0xa9, value, 0x8d, register & 255, register >>> 8);
      // These addresses have no mapper register, despite being nearby/on the cartridge bus.
      for (const ignored of [0x4200, 0x5000, 0x6000, 0x8000]) code.push(0xa9, 0, 0x8d, ignored & 255, ignored >>> 8);
      code.push(0xad, 0, 0x80, 0x85, 0, 0xad, 0, 0xc0, 0x85, 1);
    }
    const bytes = image(mapper, code, banks, 16), js = new Nes(bytes);
    js.reset(); wasm.loadRom(bytes); wasm.reset();
    for (let value = 0; value < 256; value++) {
      js.step(44); wasm.step(44);
      const prg = mapper === 79 ? (value >>> 3) & 1 : (value >>> 3) & 7;
      const chr = mapper === 79 ? value & 7 : (value & 7) + (value & 64 ? 8 : 0);
      const expected = [2 * prg % banks, (2 * prg + 1) % banks];
      assert.deepEqual([js.read(0), js.read(1)], expected);
      assert.deepEqual([0, 1].map(i => wasm.exports.ramRead(i)), expected);
      for (const address of [0, 0x1000, 0x1fff]) {
        assert.equal(js.cartridge.readChr(address), 0x80 + chr);
        assert.equal(wasm.exports.chrRead(address), 0x80 + chr);
      }
      if (mapper === 113) assert.equal(js.cartridge.mirroring, value & 128 ? 'vertical' : 'horizontal');
    }
    // Older mapper-79 snapshots may contain mapper-113-only bank bits.
    const state = js.saveState();
    state[11 + 7] = 7; state[11 + 8] = 15;
    js.loadState(state);
    assert.equal(js.read(0x8000), (mapper === 79 ? 2 : 14) % banks);
    assert.equal(js.cartridge.readChr(0), mapper === 79 ? 0x87 : 0x8f);
    wasm.reset(); assert.equal(wasm.exports.chrRead(0), 0x80);
    assert.equal(wasm.exports.unknownOpcodeCount(), 0);
  }
});

test('discrete mapper CHR RAM, mirroring changes and reset reach PPU reads in both cores', async () => {
  const wasm = await WasmCore.from(binary);
  for (const mapper of [79, 87, 113, 140, 177, 241]) for (const vertical of [false, true]) {
    const code = [], write = (a, v) => code.push(0xa9, v, 0x8d, a & 255, a >>> 8);
    const addr = a => { write(0x2006, a >>> 8); write(0x2006, a & 255); };
    const readPpu = (a, target) => { addr(a); code.push(0xad, 7, 0x20, 0xad, 7, 0x20, 0x85, target); };
    addr(0); write(0x2007, 0x5a);
    const register = mapper === 79 || mapper === 113 ? 0x5fff : mapper === 87 || mapper === 140 ? 0x7fff : 0xffff;
    const value = mapper === 113 ? (vertical ? 0xff : 0x7f) : vertical ? 0xdf : 0xff;
    write(register, value);
    readPpu(0, 4);
    for (let i = 0; i < 4; i++) { addr(0x2000 + i * 0x400); write(0x2007, i + 1); }
    for (let i = 0; i < 4; i++) readPpu(0x2000 + i * 0x400, i);
    // Draw tile zero from retained CHR RAM after switching the mapper register.
    for (let i = 0; i < 4; i++) { addr(0x2000 + i * 0x400); write(0x2007, 0); }
    addr(0x3f01); write(0x2007, 0x2a); write(0x2001, 0x0a);
    const bytes = image(mapper, code, 8, 0, vertical ? 1 : 0), js = new Nes(bytes);
    js.reset(); wasm.loadRom(bytes); wasm.reset(); js.step(60000); wasm.step(60000);
    const expected = vertical ? [3, 4, 3, 4] : [2, 2, 4, 4];
    assert.deepEqual([0, 1, 2, 3].map(i => js.read(i)), expected);
    assert.deepEqual([0, 1, 2, 3].map(i => wasm.exports.ramRead(i)), expected);
    assert.equal(wasm.exports.ramRead(4), 0x5a);
    assert.equal(wasm.frame()[1], (0xff000000 | NES_PALETTE[0x2a]) >>> 0);
    assert.deepEqual(wasm.frame(), js.frame);
    wasm.reset(); assert.equal(wasm.exports.chrRead(0), 0x5a);
  }
});

test('TypeScript 32 KiB mapper windows mirror a 16 KiB PRG image', () => {
  for (const mapper of [79, 113, 140, 177, 241]) {
    const nes = new Nes(image(mapper, [], 1));
    for (const value of [0, 1, 0xff]) {
      nes.write(mapper === 79 || mapper === 113 ? 0x4100 : mapper === 140 ? 0x6000 : 0x8000, value);
      for (let offset = 0; offset < 0x4000; offset++) {
        assert.equal(nes.read(0xc000 + offset), nes.read(0x8000 + offset));
      }
    }
  }
});
