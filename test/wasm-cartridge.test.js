import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { WasmCore, Nes, parseRom } from '../dist/index.js';

const binary = await readFile(new URL('../dist-wasm/lib-jsnes.wasm', import.meta.url));
function rom(mapper, banks, chr = 0, trainer = false) {
  const bytes = new Uint8Array(16 + (trainer ? 512 : 0) + banks * 0x4000 + chr * 0x2000);
  bytes.set([78, 69, 83, 26, banks, chr, (mapper & 15) << 4 | (trainer ? 4 : 0), mapper & 0xf0]);
  const start = 16 + (trainer ? 512 : 0);
  for (let i = 0; i < banks; i++) bytes.fill(0x30 + i, start + i * 0x4000, start + (i + 1) * 0x4000);
  return { bytes, start };
}
function vector(bytes, start, banks, pc) {
  bytes.set([pc & 255, pc >>> 8], start + banks * 0x4000 - 4);
}

test('WASM boots 16KB NROM through its upper mirror, ignoring CHR and trainer bytes', async () => {
  for (const trainer of [false, true]) {
    const { bytes, start } = rom(0, 1, 1, trainer);
    if (trainer) bytes.fill(0x5a, 16, start);
    bytes.set([0xad, 0, 0x80, 0x85, 0, 0xad, 0, 0xc0, 0x85, 1,
      0xad, 0, 0x70, 0x85, 2], start + 0x100);
    vector(bytes, start, 1, 0xc100);
    const core = await WasmCore.from(binary); core.loadRom(bytes); core.reset();
    assert.equal(core.programCounter, 0xc100);
    core.step(21);
    assert.equal(core.programCounter, 0xc10f);
    assert.deepEqual([0, 1, 2].map(i => core.exports.ramRead(i)), [0x30, 0x30, trainer ? 0x5a : 0]);
  }
});

test('WASM UxROM switches only the lower PRG window and keeps vectors in the final PRG bank', async () => {
  const { bytes, start } = rom(2, 4, 1, true);
  const fixed = start + 3 * 0x4000;
  // Execute from the fixed bank so changing the lower window cannot replace the next opcode.
  const program = [0xad, 0, 0x80, 0x85, 0,
    0xa9, 2, 0x8d, 0, 0x80, 0xad, 0, 0x80, 0x85, 1,
    0xad, 0, 0xc0, 0x85, 2,
    0xa9, 0xff, 0x8d, 0xff, 0xff, 0xad, 0, 0x80, 0x85, 3,
    0xa9, 0x67, 0x8d, 0, 0x60, 0xad, 0, 0x60, 0x85, 4];
  bytes.set(program, fixed + 0x100);
  vector(bytes, start, 4, 0xc100);
  const core = await WasmCore.from(binary); core.loadRom(bytes); core.reset();
  assert.equal(core.programCounter, 0xc100);
  core.step(53);
  assert.equal(core.programCounter, 0xc100 + program.length);
  assert.deepEqual([0, 1, 2, 3, 4].map(i => core.exports.ramRead(i)), [0x30, 0x32, 0x33, 0x33, 0x67]);
  core.reset(); core.step(7);
  assert.equal(core.exports.ramRead(0), 0x30, 'reset restores bank zero');
});

test('WASM CNROM switches CHR banks without changing PRG bytes', async () => {
  const { bytes, start } = rom(3, 2, 4);
  bytes.fill(0x11, start + 2 * 0x4000, start + 2 * 0x4000 + 0x2000);
  bytes.fill(0x22, start + 2 * 0x4000 + 0x2000, start + 2 * 0x4000 + 0x4000);
  vector(bytes, start, 2, 0x8000);
  const core = await WasmCore.from(binary); core.loadRom(bytes); core.reset();
  assert.equal(core.exports.chrRead(0), 0x11);
  core.exports.romWrite(start + 0x100, 3); // ROM writes cannot change CHR bank; use CPU opcode instead below.
  const program = [0xa9, 1, 0x8d, 0, 0x80, 0x4c, 0, 0x80]; bytes.set(program, start);
  core.loadRom(bytes); core.reset(); core.step(9);
  assert.equal(core.exports.chrRead(0), 0x22);
  assert.equal(core.exports.ramRead(0), 0);
});

test('WASM NROM-256 keeps its two halves distinct and replacing a cartridge discards old bank state', async () => {
  const core = await WasmCore.from(binary);
  const { bytes, start } = rom(0, 2, 1);
  bytes.set([0xad, 0, 0x80, 0x85, 0, 0xad, 0, 0xc0, 0x85, 1], start + 0x100);
  vector(bytes, start, 2, 0x8100);
  core.loadRom(bytes); core.reset(); core.step(14);
  assert.deepEqual([core.exports.ramRead(0), core.exports.ramRead(1)], [0x30, 0x31]);
  const small = rom(0, 1);
  small.bytes.set([0xa9, 0x55, 0x85, 0], small.start);
  vector(small.bytes, small.start, 1, 0xc000);
  core.loadRom(small.bytes); core.reset(); core.step(5);
  assert.equal(core.exports.ramRead(0), 0x55);
});

test('native WASM loadRom validates layout and mapper even without the TypeScript wrapper', async () => {
  const core = await WasmCore.from(binary), e = core.exports;
  const nes2 = rom(0, 1).bytes; nes2[7] = 8;
  const noPrg = rom(0, 0).bytes;
  for (const bytes of [new Uint8Array(16), rom(0, 1).bytes.subarray(0, 32),
    rom(4, 2).bytes, nes2, noPrg, rom(0, 3).bytes,
    rom(2, 2, 1).bytes.subarray(0, 16 + 0x8000)]) {
    for (let i = 0; i < bytes.length; i++) e.romWrite(i, bytes[i]);
    assert.throws(() => e.loadRom(bytes.length));
  }
  assert.throws(() => e.loadRom(WasmCore.MAX_ROM_SIZE + 1));
});

test('wrapper rejects unsupported cartridges before replacing the running ROM', async () => {
  const core = await WasmCore.from(binary);
  const valid = rom(0, 1);
  valid.bytes.set([0xa9, 0x55, 0x85, 0], valid.start);
  vector(valid.bytes, valid.start, 1, 0x8000);
  core.loadRom(valid.bytes); core.reset();
  const nes2 = rom(0, 1).bytes; nes2[7] = 8;
  for (const invalid of [rom(4, 2).bytes, rom(0, 3).bytes, nes2]) {
    assert.throws(() => core.loadRom(invalid));
    assert.equal(core.programCounter, 0x8000);
    assert.equal(core.cycleCount, 0);
  }
  core.step(5);
  assert.equal(core.exports.ramRead(0), 0x55);
  const frame = core.frame();
  assert.equal(frame.length, 61440);
  assert.ok(frame.every(pixel => pixel === 0xff000000));
});

function gxrom(banks = 8, chr = 4, value = 0x21) {
  const { bytes, start } = rom(66, banks, chr);
  assert.equal(parseRom(bytes).mapper, 66, 'exercise mapper 66, not mapper 2');
  const code = [];
  const write = (address, data) => code.push(0xa9, data, 0x8d, address & 255, address >>> 8);
  const read = (address, destination) => code.push(0xad, address & 255, address >>> 8, 0x85, destination);
  write(0x8000, value);
  read(0x9000, 0); read(0xd000, 1);
  write(0x2006, 0); write(0x2006, 0);
  read(0x2007, 15); read(0x2007, 2);
  write(0x2006, 0x1f); write(0x2006, 0xff);
  read(0x2007, 15); read(0x2007, 3);
  const loop = 0x8000 + code.length;
  code.push(0x4c, loop & 255, loop >>> 8);
  // Identical code in each bank keeps the instruction after STA valid.
  // Each 16KB half has its own marker at $9000/$d000.
  for (let bank = 0; bank < banks; bank++) {
    bytes.set(code, start + bank * 0x4000);
    vector(bytes, start, bank + 1, 0x8000);
  }
  for (let bank = 0; bank < chr; bank++) {
    bytes.fill(0x60 + bank, start + banks * 0x4000 + bank * 0x2000,
      start + banks * 0x4000 + (bank + 1) * 0x2000);
  }
  return bytes;
}

test('WASM GxROM switches both PRG halves and the entire CHR window for all register values', async () => {
  const core = await WasmCore.from(binary);
  for (let value = 0; value < 256; value++) {
    const bytes = gxrom(8, 4, value);
    core.loadRom(bytes); core.reset(); core.step(100);
    const prg = (value >>> 4) & 3, chr = value & 3;
    assert.deepEqual([0, 1, 2, 3].map(i => core.exports.ramRead(i)),
      [0x30 + prg * 2, 0x31 + prg * 2, 0x60 + chr, 0x60 + chr], `register ${value}`);
    assert.equal(core.exports.unknownOpcodeCount(), 0);
    core.reset();
    assert.equal(core.exports.chrRead(0), 0x60, 'reset restores CHR bank zero');
  }
});

test('WASM GxROM mirrors smaller PRG/CHR images and handles CHR RAM without division by zero', async () => {
  const core = await WasmCore.from(binary);
  for (const banks of [1, 2, 4]) for (const chr of [0, 1, 2]) {
    const bytes = gxrom(banks, chr, 0x33), js = new Nes(bytes);
    core.loadRom(bytes); core.reset(); js.reset();
    core.step(100); js.step(100);
    const expected = [0x30 + 6 % banks, 0x30 + 7 % banks, chr ? 0x60 + 3 % chr : 0, chr ? 0x60 + 3 % chr : 0];
    assert.deepEqual([0, 1, 2, 3].map(i => core.exports.ramRead(i)), expected);
    assert.deepEqual([0, 1, 2, 3].map(i => js.read(i)), expected);
    assert.equal(core.programCounter, js.cpu.pc);
    assert.equal(core.cycleCount, js.cycleCount);
  }
});

test('CNROM reset also restores CHR bank zero', async () => {
  const { bytes, start } = rom(3, 2, 2);
  bytes.set([0xa9, 1, 0x8d, 0, 0x80], start);
  bytes.fill(0x11, start + 0x8000, start + 0xa000);
  bytes.fill(0x22, start + 0xa000);
  vector(bytes, start, 2, 0x8000);
  const core = await WasmCore.from(binary); core.loadRom(bytes); core.reset(); core.step(6);
  assert.equal(core.exports.chrRead(0), 0x22);
  core.reset(); assert.equal(core.exports.chrRead(0), 0x11);
});

test('GxROM bank writes preserve CHR RAM and CHR ROM remains read-only through PPUDATA', async () => {
  for (const chr of [0, 4]) {
    const bytes = gxrom(8, chr), start = 16;
    const code = [
      0xa9, 0, 0x8d, 6, 0x20, 0x8d, 6, 0x20, // PPUADDR = 0.
      0xa9, 0x5a, 0x8d, 7, 0x20, // Write CHR RAM, or ignored for ROM.
      0xa9, 0x33, 0x8d, 0xff, 0xff,
      0xa9, 0, 0x8d, 6, 0x20, 0x8d, 6, 0x20,
      0xad, 7, 0x20, 0xad, 7, 0x20, 0x85, 0,
    ];
    const loop = 0x8000 + code.length; code.push(0x4c, loop & 255, loop >>> 8);
    for (let bank = 0; bank < 8; bank++) bytes.set(code, start + bank * 0x4000);
    const core = await WasmCore.from(binary), js = new Nes(bytes);
    core.loadRom(bytes); core.reset(); js.reset(); core.step(100); js.step(100);
    assert.equal(core.exports.ramRead(0), chr ? 0x63 : 0x5a);
    assert.equal(core.exports.ramRead(0), js.read(0));
    core.reset();
    assert.equal(core.exports.chrRead(0), chr ? 0x60 : 0x5a);
  }
});

test('GxROM CHR selection changes rendered pixels and matches the TypeScript frame', async () => {
  const core = await WasmCore.from(binary);
  for (const selection of [0, 1]) {
    const { bytes, start } = rom(66, 8, 2);
    const code = [], write = (a, v) => code.push(0xa9, v, 0x8d, a & 255, a >>> 8);
    write(0x8000, 0x20 | selection);
    write(0x2006, 0x3f); write(0x2006, 0);
    for (const value of [0x0f, 0x2a, 0x16]) write(0x2007, value);
    write(0x2001, 0x0a);
    const loop = 0x8000 + code.length; code.push(0x4c, loop & 255, loop >>> 8);
    for (let bank = 0; bank < 8; bank++) {
      bytes.set(code, start + bank * 0x4000);
      vector(bytes, start, bank + 1, 0x8000);
    }
    const chrStart = start + 8 * 0x4000;
    bytes.fill(255, chrStart, chrStart + 8); // Bank 0: color index 1.
    bytes.fill(255, chrStart + 0x2008, chrStart + 0x2010); // Bank 1: color index 2.
    const js = new Nes(bytes); js.reset(); core.loadRom(bytes); core.reset();
    js.step(60000); core.step(60000);
    assert.equal(core.frame()[8], selection ? 0xffb53120 : 0xff5eea6f);
    assert.deepEqual(core.frame(), js.frame);
    assert.equal(core.programCounter, js.cpu.pc);
    assert.equal(core.cycleCount, js.cycleCount);
  }
});
