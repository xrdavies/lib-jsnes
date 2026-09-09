import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Cpu6502, Nes, WasmCore } from '../dist/index.js';

const binary = await readFile(new URL('../dist-wasm/lib-jsnes.wasm', import.meta.url));
function image(code, registerByte) {
  const bytes = new Uint8Array(16 + 4 * 16384); bytes.set([78, 69, 83, 26, 4, 0, 0x10]);
  for (let i = 0; i < 4; i++) bytes.fill(i, 16 + i * 16384, 16 + (i + 1) * 16384);
  bytes[16 + 3 * 16384 + 0x2000] = registerByte;
  const end = 0xc100 + code.length;
  bytes.set([...code, 0x4c, end & 255, end >>> 8], 16 + 3 * 16384 + 256);
  bytes.set([0, 0xc1], 16 + 4 * 16384 - 4); return bytes;
}

test('MMC1 accepts only the first write from every absolute RMW opcode in both cores', async () => {
  const wasm = await WasmCore.from(binary);
  for (const opcode of [0xee, 0xce, 0x0e, 0x2e, 0x4e, 0x6e, 0x0f, 0x2f, 0x4f, 0x6f, 0xcf, 0xef]) {
    for (const value of [0, 1, 0x7f]) {
      const code = [];
      for (let i = 0; i < 5; i++) code.push(opcode, 0, 0xe0);
      code.push(0xad, 0, 0x80, 0x85, 0);
      const bytes = image(code, value), js = new Nes(bytes);
      js.reset(); wasm.loadRom(bytes); wasm.reset(); js.step(100); wasm.step(100);
      const expected = value & 1 ? 3 : 0;
      assert.equal(js.read(0), expected, `${opcode.toString(16)}:${value}`);
      assert.equal(wasm.exports.ramRead(0), expected);
      assert.equal(wasm.cycleCount, js.cycleCount);
      assert.equal(wasm.programCounter, js.cpu.pc);
    }
  }
});

test('MMC1 ignores an RMW second write even when the first completes a serial transfer', async () => {
  const code = [], serial = bits => bits.forEach(bit => code.push(0xa9, bit, 0x8d, 0, 0xe0));
  serial([1, 0, 0, 0]); code.push(0xee, 0, 0xe0, 0xad, 0, 0x80, 0x85, 0);
  serial([0, 1, 0, 0, 0]); code.push(0xad, 0, 0x80, 0x85, 1);
  const bytes = image(code, 0), js = new Nes(bytes), wasm = await WasmCore.from(binary);
  js.reset(); wasm.loadRom(bytes); wasm.reset();
  js.step(30); wasm.step(30); // First transfer completed, RMW second write ignored.
  const saved = js.saveState(); js.step(100); wasm.step(100);
  assert.deepEqual([js.read(0), js.read(1)], [1, 2]);
  assert.deepEqual([0, 1].map(i => wasm.exports.ramRead(i)), [1, 2]);
  const final = js.saveState(); js.loadState(saved); js.step(100);
  assert.deepEqual([js.read(0), js.read(1)], [1, 2]);
  assert.deepEqual(js.saveState(), final);
});

test('CPU bus marks RMW second writes but still emits both values to ordinary memory', () => {
  const memory = new Uint8Array(65536), writes = [];
  memory.set([0xee, 0, 2, 0x8d, 0, 2], 0x8000); memory[0x200] = 0x7f;
  const cpu = new Cpu6502({ read: a => memory[a], write(a, v, consecutive) {
    writes.push([a, v, consecutive]); memory[a] = v;
  } }); cpu.pc = 0x8000; cpu.a = 0x33; cpu.step(); cpu.step();
  assert.deepEqual(writes, [[0x200, 0x7f, false], [0x200, 0x80, true], [0x200, 0x33, false]]);
});
