import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { WasmCore } from '../dist/index.js';

const binary = await readFile(new URL('../dist-wasm/lib-jsnes.wasm', import.meta.url));
function rom(mapper, banks, chr = 0, trainer = false) {
  const bytes = new Uint8Array(16 + (trainer ? 512 : 0) + banks * 0x4000 + chr * 0x2000);
  bytes.set([78, 69, 83, 26, banks, chr, mapper << 4 | (trainer ? 4 : 0), 0]);
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
    nes2, noPrg, rom(0, 3).bytes,
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
  for (const invalid of [rom(0, 3).bytes, nes2]) {
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
