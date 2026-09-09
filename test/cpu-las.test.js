import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Cpu6502, WasmCore } from '../dist/index.js';

test('LAS masks memory by SP for every byte pair, preserving flags other than N/Z in both cores', async () => {
  const bytes = new Uint8Array(16 + 16384); bytes.set([78, 69, 83, 26, 1, 0]);
  // Restore flags via PLP, set arbitrary SP via TXS, then LAS and loop.
  bytes.set([0xa9, 0x6d, 0x48, 0x28, 0xa2, 0, 0x9a, 0xbb, 0, 0x90, 0x4c, 0, 0x80], 16);
  bytes.set([0, 0x80], 16 + 16384 - 4);
  const wasm = await WasmCore.from(await readFile('dist-wasm/lib-jsnes.wasm'));
  wasm.loadRom(bytes); wasm.reset();
  const memory = new Uint8Array(65536); memory.set([0xbb, 0, 0x90], 0x8000);
  const cpu = new Cpu6502({ read: a => memory[a], write() { assert.fail('LAS must not write'); } }, true);
  for (let sp = 0; sp < 256; sp++) for (let value = 0; value < 256; value++) {
    memory[0x9000] = value; cpu.sp = sp; cpu.a = 0x55; cpu.x = 0xaa; cpu.pc = 0x8000; cpu.p = 0x6d;
    assert.equal(cpu.step(), 4);
    const expected = sp & value, flags = 0x6d | (expected ? 0 : 2) | (expected & 128);
    assert.deepEqual([cpu.a, cpu.x, cpu.sp, cpu.y, cpu.p, cpu.pc], [expected, expected, expected, 0, flags, 0x8003]);
    wasm.exports.romWrite(21, sp); wasm.exports.romWrite(16 + 0x1000, value);
    const before = wasm.cycleCount; wasm.step(20);
    assert.equal(wasm.cycleCount, before + 20);
    assert.deepEqual([0, 1, 2, 3, 4, 5].map(i => wasm.exports.cpuRegister(i)),
      [expected, expected, 0, expected, flags, 0x8000]);
  }
  assert.equal(wasm.exports.unknownOpcodeCount(), 0);
});

test('LAS charges page crossing and reads the provisional address before the final value', () => {
  for (const [base, y] of [[0x1234, 0], [0x1234, 1], [0x12ff, 1], [0xffff, 1]]) {
    const memory = new Uint8Array(65536), accesses = [];
    memory.set([0xbb, base & 255, base >>> 8], 0x8000);
    const target = (base + y) & 65535, provisional = (base & 0xff00) | (target & 255);
    memory[target] = 0xd7;
    const cpu = new Cpu6502({ read(a) { accesses.push(a); return memory[a]; }, write() { assert.fail(); } }, true);
    cpu.pc = 0x8000; cpu.sp = 0x6b; cpu.y = y;
    assert.equal(cpu.step(), target === provisional ? 4 : 5);
    assert.deepEqual(accesses, [0x8000, 0x8001, 0x8002, ...(target === provisional ? [] : [provisional]), target]);
    assert.deepEqual([cpu.a, cpu.x, cpu.sp, cpu.y], [0x43, 0x43, 0x43, y]);
    const state = cpu.save(); const restored = new Cpu6502({ read: a => memory[a], write() {} });
    restored.load(state); assert.deepEqual(restored.save(), state);
  }
});
