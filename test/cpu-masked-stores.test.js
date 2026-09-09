import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Cpu6502, WasmCore } from '../dist/index.js';

test('SHX/SHY preserve flags, perform a dummy read and corrupt the address only on page crossing', async () => {
  const binary = await readFile('dist-wasm/lib-jsnes.wasm');
  // base, index, register, destination, stored byte
  const cases = [[0x1200, 1, 5, 0x1201, 1], [0x12ff, 1, 5, 0x0100, 1],
    [0x12ff, 2, 0x1f, 0x1301, 0x13], [0xffff, 1, 0xff, 0, 0],
    [0, 255, 0x80, 255, 0], [0x12ff, 0, 5, 0x12ff, 1]];
  for (const opcode of [0x9c, 0x9e]) for (const [base, index, value, target, stored] of cases) {
    const memory = new Uint8Array(65536), accesses = [];
    memory.set([opcode, base & 255, base >>> 8], 0x8000);
    const cpu = new Cpu6502({ read(a) { accesses.push(['r', a]); return memory[a]; },
      write(a, v) { accesses.push(['w', a, v]); memory[a] = v; } }, true);
    cpu.pc = 0x8000; cpu.a = 0x55; cpu.p = 0xeb;
    cpu.x = opcode === 0x9c ? index : value; cpu.y = opcode === 0x9c ? value : index;
    const x = cpu.x, y = cpu.y;
    assert.equal(cpu.step(), 5);
    assert.deepEqual(accesses, [['r', 0x8000], ['r', 0x8001], ['r', 0x8002],
      ['r', (base & 0xff00) | ((base + index) & 255)], ['w', target, stored]]);
    assert.deepEqual([cpu.a, cpu.x, cpu.y, cpu.p, cpu.pc], [0x55, x, y, 0xeb, 0x8003]);
    const rom = new Uint8Array(16 + 16384);
    rom.set([78, 69, 83, 26, 1, 0]); rom.set([0, 0x80], 16 + 0x3ffc);
    rom.set([0xa9, 0x55, 0xa2, x, 0xa0, y, opcode, base & 255, base >>> 8], 16);
    const wasm = await WasmCore.from(binary); wasm.loadRom(rom); wasm.reset(); wasm.step(6);
    const flags = wasm.exports.cpuRegister(4); wasm.step(5);
    assert.equal(wasm.exports.ramRead(target & 0x7ff), stored);
    assert.deepEqual([0, 1, 2, 4].map(i => wasm.exports.cpuRegister(i)), [0x55, x, y, flags]);
    assert.equal(wasm.cycleCount, 11); assert.equal(wasm.programCounter, 0x8009);
    assert.equal(wasm.exports.unknownOpcodeCount(), 0);
  }
});
