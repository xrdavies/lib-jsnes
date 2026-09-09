import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Nes, WasmCore, Button } from '../dist/index.js';
import { workload } from '../scripts/benchmark-core.mjs';

const binary = await readFile(new URL('../dist-wasm/lib-jsnes.wasm', import.meta.url));

test('WASM collects during large steps without audio drains and retains all live core state', async () => {
  const bytes = workload(), js = new Nes(bytes), wasm = await WasmCore.from(binary);
  js.reset(); wasm.loadRom(bytes); wasm.reset();
  for (const core of [js, wasm]) {
    core.setController(1, Button.A | Button.Right);
    core.loadBatteryRam(new Uint8Array(8192).fill(0x5a));
    // Warm the maximum retained PCM queue and DMA/render allocation paths.
    core.step(29780 * 300);
  }
  const warmedBytes = wasm.exports.memory.buffer.byteLength;
  // One call covers roughly 50 emulated seconds. Collection only at the host
  // return boundary would retain thousands of frames of allocation garbage.
  js.step(29780 * 3000); wasm.step(29780 * 3000);
  assert.equal(wasm.exports.memory.buffer.byteLength, warmedBytes, 'heap must plateau without host audio drains');
  assert.deepEqual(wasm.frame(), js.frame);
  assert.deepEqual(wasm.audioSamples(), js.audioSamples());
  assert.equal(wasm.cycleCount, js.cycleCount);
  for (const [index, name] of ['a', 'x', 'y', 'sp', 'p', 'pc'].entries()) {
    assert.equal(wasm.exports.cpuRegister(index), js.cpu[name]);
  }
  for (let i = 0; i < 0x800; i++) assert.equal(wasm.exports.ramRead(i), js.read(i));
  assert.deepEqual(wasm.saveBatteryRam(), js.saveBatteryRam());
  assert.equal(wasm.exports.unknownOpcodeCount(), 0);
});

test('WASM reclaims repeated drains and resets even when emulation is stopped', async () => {
  const wasm = await WasmCore.from(binary); wasm.loadRom(workload()); wasm.reset();
  wasm.step(60000);
  const owned = wasm.audioSamples(), expected = owned.slice();
  wasm.reset(); wasm.audioSamples();
  const warmedBytes = wasm.exports.memory.buffer.byteLength;
  for (let i = 0; i < 10000; i++) {
    wasm.reset();
    assert.equal(wasm.audioSamples().length, 0);
  }
  assert.equal(wasm.exports.memory.buffer.byteLength, warmedBytes);
  assert.deepEqual(owned, expected, 'host-owned PCM survives collection');
  wasm.runFrame();
  assert.ok(wasm.audioSamples().length > 0);
});
