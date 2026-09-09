import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Cpu6502, Nes, WasmCore } from '../dist/index.js';

const binary = await readFile(new URL('../dist-wasm/lib-jsnes.wasm', import.meta.url));
const official = `00 01 05 06 08 09 0a 0d 0e 10 11 15 16 18 19 1d 1e
20 21 24 25 26 28 29 2a 2c 2d 2e 30 31 35 36 38 39 3d 3e
40 41 45 46 48 49 4a 4c 4d 4e 50 51 55 56 58 59 5d 5e
60 61 65 66 68 69 6a 6c 6d 6e 70 71 75 76 78 79 7d 7e
81 84 85 86 88 8a 8c 8d 8e 90 91 94 95 96 98 99 9a 9d
a0 a1 a2 a4 a5 a6 a8 a9 aa ac ad ae b0 b1 b4 b5 b6 b8 b9 ba bc bd be
c0 c1 c4 c5 c6 c8 c9 ca cc cd ce d0 d1 d5 d6 d8 d9 dd de
e0 e1 e4 e5 e6 e8 e9 ea ec ed ee f0 f1 f5 f6 f8 f9 fd fe`.split(/\s+/).map(x => parseInt(x, 16));
function image(code, start = 0x8000) {
  const rom = new Uint8Array(16 + 0x4000);
  rom.set([78, 69, 83, 26, 1, 0]);
  rom.set(code, 16 + (start & 0x3fff));
  rom.set([0, 0x90, start & 255, start >>> 8, 0, 0x90], 16 + 0x3ffa);
  return rom;
}

test('WASM and TypeScript execute official and stable undocumented opcodes with identical state', async () => {
  assert.equal(new Set(official).size, 151);
  const core = await WasmCore.from(binary);
  const stable = 'a3 a7 af b3 b7 bf 83 87 8f 97 03 07 0f 13 17 1b 1f 23 27 2f 33 37 3b 3f 43 47 4f 53 57 5b 5f 63 67 6f 73 77 7b 7f c3 c7 cf d3 d7 db df e3 e7 ef f3 f7 fb ff'.split(' ').map(x => parseInt(x, 16));
  assert.equal(stable.length, 52);
  for (const opcode of [...official, ...stable, 0x0b, 0x2b, 0x4b, 0x6b, 0xcb, 0xeb, 0xbb]) for (const seed of [0, 1, 0x7f, 0xff]) {
    const prefix = [];
    for (const at of [0, 1, 2, 0x7f, 0x80, 0xff, 0x100, 0x1fe, 0x1ff, 0x200, 0x2ff, 0x300]) {
      prefix.push(0xa9, (at + seed) & 255, 0x8d, at & 255, at >>> 8);
    }
    prefix.push(0xa9, seed, 0x48, 0x28, 0xa9, seed, 0xa2, seed, 0xa0, seed);
    const rom = image([...prefix, opcode, 0xff, 2]);
    const ram = new Uint8Array(0x800);
    const cpu = new Cpu6502({
      read: a => a < 0x2000 ? ram[a & 0x7ff] : a >= 0x8000 ? rom[16 + (a & 0x3fff)] : 0,
      write: (a, v) => { if (a < 0x2000) ram[a & 0x7ff] = v; },
    });
    cpu.reset(); core.loadRom(rom); core.reset();
    while (cpu.pc < 0x8000 + prefix.length) { cpu.step(); core.step(1); }
    cpu.step(); core.step(1);
    const label = `opcode ${opcode.toString(16)}, seed ${seed}`;
    assert.deepEqual([0, 1, 2, 3, 4, 5].map(i => core.exports.cpuRegister(i)),
      [cpu.a, cpu.x, cpu.y, cpu.sp, cpu.p, cpu.pc], label);
    assert.equal(core.cycleCount, cpu.cycles, label);
    assert.equal(core.exports.unknownOpcodeCount(), 0, label);
    assert.deepEqual(Uint8Array.from({ length: ram.length }, (_, i) => core.exports.ramRead(i)), ram, label);
  }
});

test('WASM ADC/SBC implement carry and signed overflow for every operand pair', async () => {
  const core = await WasmCore.from(binary);
  core.loadRom(image([0x18, 0xa9, 0, 0x69, 0, 0x4c, 0, 0x80]));
  core.reset();
  for (const opcode of [0x69, 0xe9, 0xeb]) {
    core.exports.romWrite(19, opcode);
    for (let a = 0; a < 256; a++) for (let b = 0; b < 256; b++) for (let carry = 0; carry <= 1; carry++) {
      core.exports.romWrite(16, carry ? 0x38 : 0x18);
      core.exports.romWrite(18, a); core.exports.romWrite(20, b);
      core.step(9);
      const value = opcode === 0x69 ? a + b + carry : a - b - 1 + carry;
      const signedA = a < 128 ? a : a - 256, signedB = b < 128 ? b : b - 256;
      const signed = opcode === 0x69 ? signedA + signedB + carry : signedA - signedB - 1 + carry;
      const result = value & 255;
      const flags = 0x24 | (result === 0 ? 2 : 0) | (result & 128) |
        (signed < -128 || signed > 127 ? 64 : 0) | (opcode === 0x69 ? +(value > 255) : +(value >= 0));
      assert.equal(core.exports.cpuRegister(0), result);
      assert.equal(core.exports.cpuRegister(4), flags);
    }
  }
});

test('WASM branch page penalties and signed displacement match 6502 timing', async () => {
  const core = await WasmCore.from(binary);
  for (const [start, operand, target, cycles] of [[0x8000, 0, 0x8002, 3],
    [0x80fd, 1, 0x8100, 4], [0x8100, 0x80, 0x8082, 4], [0x80fe, 0x80, 0x8080, 4]]) {
    core.loadRom(image([0xd0, operand], start)); core.reset();
    core.step(1);
    assert.equal(core.programCounter, target);
    assert.equal(core.cycleCount, cycles);
    assert.equal(core.exports.cpuRegister(4), 0x24);
  }
});

test('WASM unknown opcode diagnostics distinguish missing instructions from NOPs', async () => {
  const core = await WasmCore.from(binary);
  core.loadRom(image([0x8b, 0xea])); core.reset(); core.step(1);
  assert.equal(core.exports.unknownOpcodeCount(), 1);
  assert.equal(core.programCounter, 0x8002);
  core.reset(); assert.equal(core.exports.unknownOpcodeCount(), 0);
});

test('WASM shares SHA and TAS masked stores with TypeScript', async () => {
  const core = await WasmCore.from(binary);
  for (const opcode of [0x9b, 0x9f]) {
    const rom = image([0xa9, 1, 0xa2, 1, 0xa0, 1, opcode, 0xff, 0x12, 0x4c, 9, 0x80]);
    const js = new Nes(rom); js.reset(); core.loadRom(rom); core.reset();
    js.step(11); core.step(11);
    assert.equal(core.exports.ramRead(0x100), 1);
    assert.equal(core.exports.unknownOpcodeCount(), 0);
    assert.deepEqual([core.programCounter, core.cycleCount], [js.cpu.pc, js.cycleCount]);
    assert.deepEqual([0, 1, 2, 3, 4].map(i => core.exports.cpuRegister(i)),
      [js.cpu.a, js.cpu.x, js.cpu.y, js.cpu.sp, js.cpu.p]);
  }
});

test('WASM stack return and indirect jump preserve NMOS address wrapping', async () => {
  const core = await WasmCore.from(binary);
  core.loadRom(image([0xa9, 0xff, 0x48, 0x48, 0x60])); // Push $ffff, RTS wraps to $0000.
  core.reset(); core.step(14);
  assert.equal(core.programCounter, 0);
  assert.equal(core.exports.cpuRegister(3), 0xfd);
  core.loadRom(image([0xa9, 0x34, 0x8d, 0xff, 2, 0xa9, 0x81, 0x8d, 0, 2,
    0xa9, 0x92, 0x8d, 0, 3, 0x6c, 0xff, 2]));
  core.reset(); core.step(23);
  assert.equal(core.programCounter, 0x8134, 'JMP ($02ff) reads its high byte at $0200');
});

test('WASM JSR observes target bytes changed by overlapping stack writes', async () => {
  const core = await WasmCore.from(binary);
  core.loadRom(image([0xa9, 0x20, 0x8d, 0xfb, 1, 0xa9, 0x34, 0x8d, 0xfc, 1,
    0xa9, 0x92, 0x8d, 0xfd, 1, 0x4c, 0xfb, 1]));
  core.reset(); core.step(21);
  assert.equal(core.programCounter, 0x1fb);
  core.step(1);
  assert.equal(core.programCounter, 0x134);
  assert.equal(core.cycleCount, 27);
  assert.equal(core.exports.ramRead(0x1fd), 1);
  assert.equal(core.exports.ramRead(0x1fc), 0xfd);
  assert.equal(core.exports.cpuRegister(3), 0xfb);
});

test('implied opcode dummy reads acknowledge PPUSTATUS on the WASM CPU bus', async () => {
  const rom = image([0x4c, 0, 0x80]);
  // Execute SEC via a write-only PPU register's I/O latch. Its discarded read
  // of $2002 clears VBlank, making the following status-port opcode CLC, not TYA.
  rom.set([0xa9, 0x38, 0x8d, 2, 0x20, 0x4c, 1, 0x20], 16 + 256);
  const js = new Nes(rom), core = await WasmCore.from(binary);
  js.reset(); core.loadRom(rom); core.reset();
  js.step(28002); core.step(28002);
  js.rom.prgRom[2] = 0x81; core.exports.romWrite(18, 0x81);
  js.step(12); core.step(12); assert.equal(core.programCounter, 0x2001);
  js.step(1); core.step(1); assert.equal(core.exports.cpuRegister(4) & 1, 1);
  js.step(1); core.step(1); assert.equal(core.exports.cpuRegister(4) & 1, 0);
  assert.equal(core.programCounter, 0x2003);
  assert.equal(core.exports.cpuRegister(4), js.cpu.p);
  assert.equal(core.cycleCount, js.cycleCount);
});
