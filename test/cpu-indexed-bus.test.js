import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Cpu6502, Nes, WasmCore } from '../dist/index.js';

test('zero-page indexed modes read the base before indexing, including zero index and wrap', () => {
  const groups = [
    ['15 35 55 75 b5 b4 d5 f5 14 34 54 74 d4 f4', 'x', 'read'],
    ['b6 b7', 'y', 'read'], ['94 95', 'x', 'write'], ['96 97', 'y', 'write'],
    ['16 36 56 76 d6 f6 17 37 57 77 d7 f7', 'x', 'rmw'],
    ['01 21 41 61 a1 c1 e1 a3', 'ind', 'read'], ['81 83', 'ind', 'write'],
    ['03 23 43 63 c3 e3', 'ind', 'rmw'],
  ];
  for (const [opcodes, mode, action] of groups) for (const hex of opcodes.split(' ')) {
    for (const [base, index] of [[0x10, 0], [0x10, 3], [0xff, 1], [0xfe, 1], [1, 255]]) {
      const memory = new Uint8Array(65536), accesses = [];
      memory.set([parseInt(hex, 16), base], 0x8000);
      const indexed = (base + index) & 255;
      const target = mode === 'ind' ? 0x4321 : indexed;
      memory[target] = 0x41;
      if (mode === 'ind') { memory[indexed] = 0x21; memory[(indexed + 1) & 255] = 0x43; }
      const cpu = new Cpu6502({ read(a) { accesses.push(['r', a]); return memory[a]; },
        write(a, v) { accesses.push(['w', a]); memory[a] = v; } }, true);
      cpu.pc = 0x8000; cpu.a = 0x57;
      cpu.x = mode === 'y' ? 0x72 : index; cpu.y = mode === 'y' ? index : 0x91;
      const prefix = [0x8000, 0x8001, base, ...(mode === 'ind' ? [indexed, (indexed + 1) & 255] : [])];
      const expected = [...prefix.map(a => ['r', a]),
        ...(action === 'write' ? [] : [['r', target]]),
        ...(action === 'rmw' ? [['w', target]] : []),
        ...(action === 'read' ? [] : [['w', target]])];
      assert.equal(cpu.step(), expected.length, `${hex} cycles`);
      assert.deepEqual(accesses, expected, `${hex}, base ${base}, index ${index}`);
      assert.equal(cpu.pc, 0x8002);
    }
  }
});

test('indexed stores and RMW instructions read the provisional address before accessing the target', () => {
  const stores = [[0x9d, 'x'], [0x99, 'y'], [0x91, 'ind']];
  const rmw = [[0x1e, 'x'], [0x3e, 'x'], [0x5e, 'x'], [0x7e, 'x'], [0xde, 'x'], [0xfe, 'x'],
    ...['1f 3f 5f 7f df ff', '1b 3b 5b 7b db fb', '13 33 53 73 d3 f3'].flatMap((row, i) =>
      row.split(' ').map(op => [parseInt(op, 16), ['x', 'y', 'ind'][i]]))];
  for (const [opcode, mode] of [...stores, ...rmw]) for (const base of [0x2300, 0x23ff, 0xffff]) {
    const memory = new Uint8Array(65536), accesses = [];
    memory.set([opcode, base & 255, base >>> 8], 0x8000);
    const target = (base + 1) & 65535;
    memory[target] = 0x41;
    if (mode === 'ind') { memory[0x8001] = 0x10; memory[0x10] = base & 255; memory[0x11] = base >>> 8; }
    const cpu = new Cpu6502({ read(a) { accesses.push(['r', a]); return memory[a]; },
      write(a, value) { accesses.push(['w', a]); memory[a] = value; } }, true);
    cpu.pc = 0x8000; cpu.x = cpu.y = 1; cpu.a = 0x57;
    const store = stores.some(([op]) => op === opcode);
    const cycles = mode === 'ind' ? (store ? 6 : 8) : store ? 5 : 7;
    assert.equal(cpu.step(), cycles);
    const fetches = mode === 'ind' ? [0x8000, 0x8001, 0x10, 0x11] : [0x8000, 0x8001, 0x8002];
    assert.deepEqual(accesses, [...fetches.map(a => ['r', a]), ['r', (base & 0xff00) | (target & 255)],
      ...(store ? [] : [['r', target], ['w', target]]), ['w', target]], `opcode ${opcode.toString(16)}, base ${base.toString(16)}`);
  }
});

test('indexed store dummy reads acknowledge PPU/APU status through the real bus in both cores', async () => {
  const binary = await readFile(new URL('../dist-wasm/lib-jsnes.wasm', import.meta.url));
  for (const status of [0x2002, 0x4015]) for (const crossing of [false, true]) {
    const rom = new Uint8Array(16 + 16384); rom.set([78, 69, 83, 26, 1, 0]);
    rom.set([0x4c, 0, 0x80], 16); rom.set([0, 0x80], 16 + 16384 - 4);
    const base = crossing ? (status & 0xff00) | 255 : status - 1;
    const index = crossing ? (status & 255) + 1 : 1;
    rom.set([0xa2, index, 0xa9, 0, 0x9d, base & 255, base >>> 8,
      0xad, status & 255, status >>> 8, 0x85, 0, 0x4c, 0x0c, 0x81], 16 + 256);
    const js = new Nes(rom), wasm = await WasmCore.from(binary); js.reset(); wasm.loadRom(rom); wasm.reset();
    const warmup = status === 0x2002 ? 28002 : 30000;
    js.step(warmup); wasm.step(warmup);
    js.rom.prgRom[2] = 0x81; wasm.exports.romWrite(18, 0x81);
    js.step(30); wasm.step(30);
    const mask = status === 0x2002 ? 128 : 64;
    assert.equal(js.read(0) & mask, 0);
    assert.equal(wasm.exports.ramRead(0) & mask, 0);
    assert.equal(wasm.cycleCount, js.cycleCount);
    assert.equal(wasm.programCounter, js.cpu.pc);
    assert.equal(wasm.exports.unknownOpcodeCount(), 0);
  }
});
