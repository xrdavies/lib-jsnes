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

test('WASM BNROM switches both 16KB windows as one 32KB bank', async () => {
  const { bytes, start } = rom(34, 4);
  const program = [0xad, 0, 0x80, 0x85, 0, 0xa9, 1, 0x8d, 0, 0x80,
    0xad, 0, 0x80, 0x85, 1, 0xad, 0, 0xc0, 0x85, 2, 0x4c, 0x14, 0x81];
  for (let bank = 0; bank < 4; bank++) bytes.set(program, start + bank * 0x4000 + 0x100);
  bytes.set([0, 0x81], start + 0x8000 - 4); // BNROM reset vectors live in the selected upper half.
  const js = new Nes(bytes), core = await WasmCore.from(binary);
  js.reset(); core.loadRom(bytes); core.reset(); js.step(100); core.step(100);
  assert.deepEqual([core.exports.ramRead(0), core.exports.ramRead(1), core.exports.ramRead(2)], [0x30, 0x32, 0x33]);
  assert.deepEqual([core.programCounter, core.cycleCount], [js.cpu.pc, js.cycleCount]);
  assert.equal(core.exports.unknownOpcodeCount(), 0);
});

test('WASM Color Dreams switches 32KB PRG and 8KB CHR from one register', async () => {
  const { bytes, start } = rom(11, 8, 8);
  for (let bank = 0; bank < 8; bank++) bytes.fill(0x40 + bank, start + 8 * 0x4000 + bank * 0x2000, start + 8 * 0x4000 + (bank + 1) * 0x2000);
  const program = [0xa9, 0x21, 0x8d, 0, 0x80, 0xad, 0, 0x80, 0x85, 0, 0xad, 0, 0xc0, 0x85, 1, 0x4c, 0x0f, 0x81];
  for (let bank = 0; bank < 8; bank++) bytes.set(program, start + bank * 0x4000 + 0x100);
  bytes.set([0, 0x81], start + 0x8000 - 4);
  const js = new Nes(bytes), core = await WasmCore.from(binary);
  js.reset(); core.loadRom(bytes); core.reset(); js.step(100); core.step(100);
  assert.deepEqual([core.exports.ramRead(0), core.exports.ramRead(1)], [0x32, 0x33]);
  assert.equal(core.exports.chrRead(0), 0x42); assert.equal(core.exports.chrRead(0x1fff), 0x42);
  assert.deepEqual([core.programCounter, core.cycleCount], [js.cpu.pc, js.cycleCount]);
  assert.equal(core.exports.unknownOpcodeCount(), 0);
});

test('WASM CPROM keeps the lower 4KB CHR page fixed and switches the upper page', async () => {
  const { bytes, start } = rom(13, 2, 8);
  const chrStart = start + 2 * 0x4000;
  for (let bank = 0; bank < 16; bank++) bytes.fill(0x40 + bank, chrStart + bank * 0x1000, chrStart + (bank + 1) * 0x1000);
  bytes.set([0xa9, 3, 0x8d, 0, 0x80, 0x4c, 0x05, 0x81], start + 0x100);
  bytes.set([0, 0x81], start + 2 * 0x4000 - 4);
  const js = new Nes(bytes), core = await WasmCore.from(binary);
  js.reset(); core.loadRom(bytes); core.reset(); js.step(40); core.step(40);
  assert.deepEqual([core.exports.chrRead(0), core.exports.chrRead(0x1000)], [0x40, 0x43]);
  assert.deepEqual([core.programCounter, core.cycleCount], [js.cpu.pc, js.cycleCount]);
  assert.equal(core.exports.unknownOpcodeCount(), 0);
});

test('WASM Camerica mapper 71 switches the lower PRG window and preserves the fixed upper bank', async () => {
  const { bytes, start } = rom(71, 4, 1, false);
  const program = [0xa9, 2, 0x8d, 0, 0x80, 0xad, 0, 0x80, 0x85, 0, 0xad, 0, 0xc0, 0x85, 1,
    0xa9, 0x10, 0x8d, 0, 0x90, 0x4c, 0x14, 0xc1];
  bytes.set(program, start + 3 * 0x4000 + 0x100);
  vector(bytes, start, 4, 0xc100);
  const js = new Nes(bytes), core = await WasmCore.from(binary);
  js.reset(); core.loadRom(bytes); core.reset(); js.step(100); core.step(100);
  assert.deepEqual([core.exports.ramRead(0), core.exports.ramRead(1)], [0x32, 0x33]);
  assert.deepEqual([core.programCounter, core.cycleCount], [js.cpu.pc, js.cycleCount]);
  assert.equal(core.exports.unknownOpcodeCount(), 0);
});

test('WASM MMC2 and MMC4 switch PRG windows and latch both CHR halves from PPU addresses', async () => {
  for (const mapper of [9, 10]) {
    const { bytes, start } = rom(mapper, 8, 8);
    const chrStart = start + 8 * 0x4000;
    for (let bank = 0; bank < 16; bank++) bytes.fill(0x40 + bank, chrStart + bank * 0x1000, chrStart + (bank + 1) * 0x1000);
    const code = [], write = (address, value) => code.push(0xa9, value, 0x8d, address & 255, address >>> 8);
    const read = (address, destination) => code.push(0xad, address & 255, address >>> 8, 0x85, destination);
    write(0xb000, 0); write(0xc000, 1); write(0xd000, 2); write(0xe000, 3); write(0xa000, 3);
    read(0x8000, 0); read(0xa000, 1); read(0xc000, 2); read(0xe000, 3);
    const pc = mapper === 9 ? 0xe100 : 0xc100, loop = pc + code.length;
    code.push(0x4c, loop & 255, loop >>> 8);
    bytes.set(code, start + 7 * 0x4000 + (mapper === 9 ? 0x2100 : 0x100));
    bytes.set([pc & 255, pc >>> 8], start + 8 * 0x4000 - 4);
    const js = new Nes(bytes), core = await WasmCore.from(binary);
    js.reset(); core.loadRom(bytes); core.reset(); js.step(200); core.step(200);
    const expected = mapper === 9 ? [0x31, 0x36, 0x37, 0x37] : [0x33, 0x33, 0x37, 0x37];
    assert.deepEqual([0, 1, 2, 3].map(i => core.exports.ramRead(i)), expected);
    assert.deepEqual([core.programCounter, core.cycleCount], [js.cpu.pc, js.cycleCount]);
    for (const address of [0, 0x1000]) assert.equal(core.exports.chrRead(address), js.cartridge.readChr(address));
    assert.equal(core.exports.chrRead(0x0fd0), 0x40); assert.equal(js.cartridge.readChr(0x0fd0), 0x40);
    assert.equal(core.exports.chrRead(0), 0x40); assert.equal(js.cartridge.readChr(0), 0x40);
    assert.equal(core.exports.chrRead(0x1fd0), 0x42); assert.equal(js.cartridge.readChr(0x1fd0), 0x42);
    assert.equal(core.exports.chrRead(0x1000), 0x42); assert.equal(js.cartridge.readChr(0x1000), 0x42);
    const state = core.saveState(); core.exports.chrRead(0x0fe0); core.loadState(state);
    assert.equal(core.exports.chrRead(0), 0x40); assert.equal(core.exports.unknownOpcodeCount(), 0);
  }
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
    rom(5, 2).bytes, noPrg,
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
  for (const invalid of [rom(5, 2).bytes, rom(0, 3).bytes, rom(13, 1).bytes, rom(13, 4).bytes]) {
    assert.throws(() => core.loadRom(invalid));
    assert.equal(core.programCounter, 0x8000);
    assert.equal(core.cycleCount, 0);
  }
  core.step(5);
  assert.equal(core.exports.ramRead(0), 0x55);
  const frame = core.frame();
  assert.equal(frame.length, 61440);
  assert.ok(frame.subarray(0, 15).every(pixel => pixel === 0xff666666));
  assert.ok(frame.subarray(15).every(pixel => pixel === 0xff000000));
});

test('WASM accepts standard NES 2.0 linear sizes for supported mappers', async () => {
  const { bytes, start } = rom(0, 1, 1);
  bytes[7] = 8; bytes[9] = 0; vector(bytes, start, 1, 0x8000);
  const core = await WasmCore.from(binary); core.loadRom(bytes); core.reset();
  assert.equal(core.programCounter, 0x8000);
  assert.equal(core.exports.chrRead(0), bytes[start + 0x4000]);
  const exponent = bytes.slice(); exponent[4] = 0x38; exponent[9] = 0x0f;
  assert.equal(parseRom(exponent).prgRom.length, 16384);
  core.loadRom(exponent); core.reset(); assert.equal(core.programCounter, 0x8000);
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


function axrom(program, banks = 8) {
  const { bytes, start } = rom(7, banks);
  // AxROM boots the first 32KB pair. Each pair has code and its own vector.
  for (let bank = 0; bank < banks; bank += 2) {
    bytes.set(program, start + bank * 0x4000);
    vector(bytes, start, Math.min(bank + 2, banks), 0x8000);
  }
  return bytes;
}

test('AxROM executes bank switching for every register value and mirrors small PRG images', async () => {
  const core = await WasmCore.from(binary);
  for (const banks of [1, 2, 8]) for (let value = 0; value < 256; value++) {
    const bytes = axrom([0xa9, value, 0x8d, 0xff, 0xff,
      0xad, 0, 0x90, 0x85, 0, 0xad, 0, 0xd0, 0x85, 1], banks);
    const js = new Nes(bytes); js.reset(); core.loadRom(bytes); core.reset();
    assert.equal(core.programCounter, 0x8000);
    js.step(20); core.step(20);
    const expected = [0x30 + ((value & 15) * 2) % banks, 0x30 + ((value & 15) * 2 + 1) % banks];
    assert.deepEqual([core.exports.ramRead(0), core.exports.ramRead(1)], expected);
    assert.deepEqual([js.read(0), js.read(1)], expected);
    assert.equal(core.programCounter, 0x800f);
    assert.equal(core.cycleCount, 20);
    assert.equal(core.exports.unknownOpcodeCount(), 0);
  }
});

test('AxROM single-screen pages remain independent and reset selects the lower page', async () => {
  const code = [], write = (a, v) => code.push(0xa9, v, 0x8d, a & 255, a >>> 8);
  const address = a => { write(0x2006, a >>> 8); write(0x2006, a & 255); };
  const read = destination => code.push(0xad, 7, 0x20, 0xad, 7, 0x20, 0x85, destination);
  address(0x2000); read(0); // 23 cycles; inspect reset page selection before changing it.
  write(0x8000, 0); address(0x2000); write(0x2007, 0x11);
  write(0x8000, 0x11); address(0x2400); write(0x2007, 0x22);
  for (const [selection, first] of [[0, 1], [0x11, 5]]) {
    write(0xffff, selection);
    for (let i = 0; i < 4; i++) { address(0x2000 + i * 0x400); read(first + i); }
  }
  const loop = 0x8000 + code.length; code.push(0x4c, loop & 255, loop >>> 8);
  const bytes = axrom(code), core = await WasmCore.from(binary), js = new Nes(bytes);
  js.reset(); core.loadRom(bytes); core.reset(); js.step(1000); core.step(1000);
  const expected = [0, 0x11, 0x11, 0x11, 0x11, 0x22, 0x22, 0x22, 0x22];
  assert.deepEqual(Array.from({ length: 9 }, (_, i) => core.exports.ramRead(i)), expected);
  assert.deepEqual(Array.from({ length: 9 }, (_, i) => js.read(i)), expected);
  js.reset(); core.reset(); js.step(23); core.step(23);
  assert.equal(core.exports.ramRead(0), 0x11);
  assert.equal(js.read(0), 0x11);
});

test('AxROM screen selection changes pixels without replacing CHR RAM', async () => {
  const core = await WasmCore.from(binary);
  for (const selection of [0, 0x13]) {
    const code = [], write = (a, v) => code.push(0xa9, v, 0x8d, a & 255, a >>> 8);
    const ppuWrite = (a, values) => {
      write(0x2006, a >>> 8); write(0x2006, a & 255);
      for (const v of values) write(0x2007, v);
    };
    ppuWrite(0, [...Array(8).fill(255), ...Array(16).fill(0), ...Array(8).fill(255)]);
    ppuWrite(0x3f00, [0x0f, 0x2a, 0x16]);
    write(0x8000, 0); ppuWrite(0x2000, [0]);
    write(0xffff, 0x13); ppuWrite(0x2000, [1]);
    write(0x8000, selection); write(0x2001, 0x0a);
    const loop = 0x8000 + code.length; code.push(0x4c, loop & 255, loop >>> 8);
    const bytes = axrom(code), js = new Nes(bytes);
    js.reset(); core.loadRom(bytes); core.reset(); js.step(60000); core.step(60000);
    assert.equal(core.frame()[0], selection ? 0xffb53120 : 0xff5eea6f);
    assert.deepEqual(core.frame(), js.frame);
    assert.equal(core.programCounter, js.cpu.pc);
    assert.equal(core.cycleCount, js.cycleCount);
    assert.deepEqual(core.audioSamples(), js.audioSamples());
  }
});

test('native NES 2.0 parser retains mapper and ROM-size extension bits', async () => {
  const core = await WasmCore.from(binary), e = core.exports;
  for (const [offset, value] of [[8, 1], [9, 1], [9, 0x10]]) {
    const { bytes } = rom(2, 1, 1); bytes[7] = 8; bytes[offset] = value;
    for (let i = 0; i < bytes.length; i++) e.romWrite(i, bytes[i]);
    assert.throws(() => e.loadRom(bytes.length), `extension byte ${offset} = ${value} must not be discarded`);
  }
  // These same bytes are not extensions in iNES 1.0.
  const { bytes, start } = rom(0, 1, 1); bytes[8] = bytes[9] = 0xff;
  bytes.set([0xa9, 0x55, 0x85, 0], start); vector(bytes, start, 1, 0x8000);
  core.loadRom(bytes); core.reset(); core.step(5);
  assert.equal(e.ramRead(0), 0x55);
});

test('WASM accepts correctly encoded exponent layouts and preserves the active cartridge on malformed input', async () => {
  const core = await WasmCore.from(binary);
  const { bytes, start } = rom(0, 1, 1);
  bytes.set([0xa9, 0x55, 0x85, 0], start); vector(bytes, start, 1, 0x8000);
  core.loadRom(bytes); core.reset();
  for (const chrExponent of [false, true]) {
    const exponent = bytes.slice(); exponent[7] = 8;
    if (chrExponent) { exponent[5] = 0x34; exponent[9] = 0xf0; }
    else { exponent[4] = 0x38; exponent[9] = 0x0f; }
    assert.equal(parseRom(exponent).prgRom.length, 16384);
    assert.equal(parseRom(exponent).chrRom.length, 8192);
    core.loadRom(exponent); core.reset(); assert.equal(core.programCounter, 0x8000);
    const native = await WasmCore.from(binary);
    for (let i = 0; i < exponent.length; i++) native.exports.romWrite(i, exponent[i]);
    native.exports.loadRom(exponent.length); native.exports.reset(); assert.equal(native.exports.programCounter(), 0x8000);
  }
  for (const format of [4, 12]) {
    const invalid = bytes.slice(); invalid[7] = format; invalid[start + 1] = 0xaa;
    assert.throws(() => core.loadRom(invalid), /Unsupported ROM format/);
  }
  core.step(5); assert.equal(core.exports.ramRead(0), 0x55);
});
