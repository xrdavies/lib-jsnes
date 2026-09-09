import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Nes, WasmCore } from '../dist/index.js';

test('warm reset preserves A/X/Y in both cores; loading a new ROM initializes them to zero', async () => {
  const bytes = new Uint8Array(16 + 16384); bytes.set([78, 69, 83, 26, 1, 0]);
  // Observe incoming registers before setting distinct values, dirtying the stack and jamming.
  bytes.set([0x85, 0, 0x86, 1, 0x84, 2, 0xa9, 0x37, 0xa2, 0x48, 0xa0, 0x59, 0x48, 0x02], 16);
  bytes.set([0, 0x80], 16 + 16384 - 4);
  const js = new Nes(bytes), wasm = await WasmCore.from(await readFile('dist-wasm/lib-jsnes.wasm'));
  js.reset(); wasm.loadRom(bytes); wasm.reset();
  const registers = () => [0, 1, 2, 3, 4, 5].map(i => wasm.exports.cpuRegister(i));
  assert.deepEqual(registers(), [0, 0, 0, 0xfd, 0x24, 0x8000]);
  for (let iteration = 0; iteration < 3; iteration++) {
    js.step(30000); wasm.step(30000);
    const expected = iteration ? [0x37, 0x48, 0x59] : [0, 0, 0];
    assert.deepEqual([0, 1, 2].map(a => js.read(a)), expected);
    assert.deepEqual([0, 1, 2].map(a => wasm.exports.ramRead(a)), expected);
    assert.equal(js.cpu.jammed, true); assert.equal(wasm.jammed, true);
    js.reset(); wasm.reset();
    assert.deepEqual(registers(), [0x37, 0x48, 0x59, 0xfd, 0x24, 0x8000]);
    assert.deepEqual(registers(), [js.cpu.a, js.cpu.x, js.cpu.y, js.cpu.sp, js.cpu.p, js.cpu.pc]);
    assert.equal(wasm.cycleCount, 0); assert.equal(js.cycleCount, 0);
    assert.equal(wasm.jammed, false); assert.equal(js.cpu.jammed, false);
    assert.deepEqual(wasm.audioSamples(), new Int16Array()); assert.deepEqual(js.audioSamples(), new Int16Array());
    assert.deepEqual(wasm.frame(), js.frame);
  }
  wasm.loadRom(bytes); wasm.reset(); wasm.step(9);
  assert.deepEqual([0, 1, 2].map(a => wasm.exports.ramRead(a)), [0, 0, 0]);
});
