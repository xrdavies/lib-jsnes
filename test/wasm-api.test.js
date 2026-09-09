import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { WasmCore } from '../dist/index.js';

test('WasmCore runFrame uses the shared frame budget and returns a fresh view', async () => {
  const core = await WasmCore.from(await readFile('dist-wasm/lib-jsnes.wasm'));
  const rom = new Uint8Array(16 + 0x4000);
  rom.set([78,69,83,26,1,0]); rom.set([0xea, 0x4c, 0, 0x80], 16);
  rom[16 + 0x3ffc] = 0; rom[16 + 0x3ffd] = 0x80;
  core.loadRom(rom); core.reset();
  const frame = core.runFrame();
  assert.equal(core.cycleCount, WasmCore.FRAME_CYCLES);
  assert.deepEqual(frame, core.frame());
  assert.equal(frame.length, WasmCore.FRAME_WIDTH * WasmCore.FRAME_HEIGHT);
  assert.throws(() => core.runFrame(0), /cycles must be a positive integer/);
});
