import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Nes, WasmCore } from '../dist/index.js';

const binary = await readFile(new URL('../dist-wasm/lib-jsnes.wasm', import.meta.url));
function program() {
  const code = []; let cycles = 0;
  const write = (a, v) => { code.push(0xa9, v, 0x8d, a & 255, a >>> 8); cycles += 6; };
  const read = (a, slot) => { code.push(0xad, a & 255, a >>> 8, 0x85, slot); cycles += 7; };
  const serial = (a, v) => { for (let i = 0; i < 5; i++) write(a, (v >>> i) & 1); };
  const ppuAddress = a => { write(0x2006, a >>> 8); write(0x2006, a & 255); };
  const ppuRead = (a, slot) => { ppuAddress(a); read(0x2007, 255); read(0x2007, slot); };
  return { code, write, read, serial, ppuAddress, ppuRead, get cycles() { return cycles; } };
}
function image(p, banks = 8, chr = 4) {
  const bytes = new Uint8Array(16 + banks * 0x4000 + chr * 0x2000);
  bytes.set([78, 69, 83, 26, banks, chr, 0x10]);
  const loop = 0x8000 + p.code.length, code = [...p.code, 0x4c, loop & 255, loop >>> 8];
  assert.ok(code.length < 0x1000);
  // Replicate code and vectors so every banking mode executes the same next instruction.
  for (let bank = 0; bank < banks; bank++) {
    const start = 16 + bank * 0x4000;
    bytes.fill(0x30 + bank, start, start + 0x4000); bytes.set(code, start);
    bytes.set([0, 0x80], start + 0x3ffc);
  }
  for (let bank = 0; bank < chr * 2; bank++) bytes.fill(0x60 + bank,
    16 + banks * 0x4000 + bank * 0x1000, 16 + banks * 0x4000 + (bank + 1) * 0x1000);
  return bytes;
}
async function check(p, expected, chr = 4) {
  const bytes = image(p, 8, chr), js = new Nes(bytes), core = await WasmCore.from(binary);
  js.reset(); core.loadRom(bytes); core.reset();
  js.step(p.cycles); core.step(p.cycles);
  assert.equal(core.programCounter, 0x8000 + p.code.length);
  assert.equal(core.cycleCount, p.cycles);
  assert.equal(core.exports.unknownOpcodeCount(), 0);
  for (const [slot, value] of expected.entries()) {
    assert.equal(js.read(slot), value, `JS slot ${slot}`);
    assert.equal(core.exports.ramRead(slot), value, `WASM slot ${slot}`);
  }
  return { js, core, bytes };
}

test('WASM MMC1 boots with the final bank fixed and implements all PRG modes', async () => {
  const p = program(), expected = [];
  const pair = (a, b) => { p.read(0x9000, expected.length); expected.push(a); p.read(0xd000, expected.length); expected.push(b); };
  pair(0x30, 0x37);
  p.serial(0xe000, 3); pair(0x33, 0x37);
  for (const [control, a, b] of [[0, 0x32, 0x33], [4, 0x32, 0x33], [8, 0x30, 0x33], [12, 0x33, 0x37]]) {
    p.serial(0x8000, control); pair(a, b);
  }
  p.serial(0xe000, 31); pair(0x37, 0x37); // PRG RAM disable bit must not select a bank.
  await check(p, expected);
});

test('WASM MMC1 latches only the fifth bit using its address and reset discards partial writes', async () => {
  const p = program();
  for (const bit of [1, 0, 1, 0]) p.write(0x8000, bit);
  p.read(0x9000, 0); p.write(0xe000, 0); p.read(0x9000, 1);
  p.write(0xe000, 1); p.write(0xffff, 0x80); p.serial(0xe000, 2); p.read(0x9000, 2);
  p.serial(0x8000, 0); p.write(0x9000, 0x80); p.read(0xd000, 3);
  const { core } = await check(p, [0x30, 0x35, 0x32, 0x37]);
  core.reset(); core.step(31); assert.equal(core.exports.ramRead(0), 0x30);
});

test('WASM MMC1 selects aligned 8KB and independent 4KB CHR banks and ignores ROM writes', async () => {
  const p = program(); p.serial(0xa000, 3); p.serial(0xc000, 6);
  p.ppuRead(0, 0); p.ppuRead(0x1000, 1);
  p.serial(0x8000, 0x1c); p.ppuRead(0, 2); p.ppuRead(0x1000, 3);
  p.serial(0xa000, 31); p.serial(0xc000, 30); p.ppuAddress(0); p.write(0x2007, 0xff);
  p.ppuRead(0, 4); p.ppuRead(0x1000, 5);
  await check(p, [0x62, 0x63, 0x63, 0x66, 0x67, 0x66]);
});

test('WASM MMC1 CHR RAM follows bank mapping and PRG RAM survives disable and reset', async () => {
  const p = program(); p.read(0x6000, 4); p.write(0x6000, 0x5a); p.serial(0xe000, 16);
  p.write(0x6000, 0xff); p.read(0x6000, 0); p.serial(0xe000, 0); p.read(0x6000, 1);
  p.ppuAddress(0); p.write(0x2007, 0xa5); p.ppuAddress(0x1000); p.write(0x2007, 0x5a);
  p.serial(0x8000, 0x1c); p.serial(0xa000, 1); p.serial(0xc000, 0);
  p.ppuRead(0, 2); p.ppuRead(0x1000, 3);
  const { core } = await check(p, [0, 0x5a, 0x5a, 0xa5], 0);
  core.reset(); core.step(7); assert.equal(core.exports.ramRead(4), 0x5a); assert.equal(core.exports.chrRead(0), 0xa5); assert.equal(core.exports.chrRead(0x1000), 0x5a);
});

test('WASM MMC1 changes nametable mirroring in all four modes', async () => {
  const p = program(); p.serial(0x8000, 12); p.ppuAddress(0x2000); p.write(0x2007, 11);
  p.serial(0x8000, 13); p.ppuAddress(0x2400); p.write(0x2007, 22);
  for (let mode = 0; mode < 4; mode++) {
    p.serial(0x8000, 12 | mode);
    for (let i = 0; i < 4; i++) p.ppuRead(0x2000 + i * 0x400, mode * 4 + i);
  }
  await check(p, [11, 11, 11, 11, 22, 22, 22, 22, 11, 22, 11, 22, 11, 11, 22, 22]);
});

test('WASM and wrapper reject extended MMC1 boards', async () => {
  for (const [banks, chr] of [[17, 0], [2, 17]]) {
    const bytes = image(program(), banks, chr), core = await WasmCore.from(binary);
    assert.throws(() => core.loadRom(bytes), /Extended MMC1/);
    for (let i = 0; i < bytes.length; i++) core.exports.romWrite(i, bytes[i]);
    assert.throws(() => core.exports.loadRom(bytes.length));
  }
});

test('MMC1 CHR bank changes reach the renderer in both builds', async () => {
  for (const bank of [0, 2]) {
    const p = program(); p.serial(0xa000, bank);
    p.ppuAddress(0x3f00); for (const color of [0x0f, 0x2a, 0x16]) p.write(0x2007, color);
    p.write(0x2001, 10);
    const bytes = image(p, 8, 2), start = 16 + 8 * 0x4000;
    bytes.fill(0, start);
    bytes.fill(255, start, start + 8); // First CHR pair: color index 1.
    bytes.fill(255, start + 0x2008, start + 0x2010); // Second pair: color index 2.
    const js = new Nes(bytes), core = await WasmCore.from(binary);
    js.reset(); core.loadRom(bytes); core.reset(); js.step(60000); core.step(60000);
    assert.equal(core.frame()[8], bank ? 0xffb53120 : 0xff5eea6f);
    assert.deepEqual(core.frame(), js.frame);
    assert.deepEqual(core.audioSamples(), js.audioSamples());
    assert.equal(core.programCounter, js.cpu.pc); assert.equal(core.cycleCount, js.cycleCount);
  }
});
