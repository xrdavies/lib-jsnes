import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { WasmCore } from '../dist/index.js';
import { benchmark, workload } from '../scripts/benchmark-core.mjs';

test('shared benchmark rejects corrupted pixels before reporting timings', async () => {
  const binary = await readFile(new URL('../dist-wasm/lib-jsnes.wasm', import.meta.url));
  const from = WasmCore.from;
  WasmCore.from = async source => {
    const core = await from(source), frame = core.frame.bind(core);
    core.frame = () => { const pixels = frame().slice(); pixels[7] ^= 1; return pixels; };
    return core;
  };
  const updates = [];
  try {
    await assert.rejects(benchmark(workload(), binary, async message => updates.push(message)), /Frame 0 pixels\[7\]/);
    assert.equal(updates.length, 1, 'timing must not start after a parity failure');
  } finally {
    WasmCore.from = from;
  }
});
