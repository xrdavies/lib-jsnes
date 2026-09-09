import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { WasmCore } from '../dist/index.js';

test('WasmCore accepts a fetch Response and exposes the shared frame view', async () => {
  const response = new Response(await readFile('dist-wasm/lib-jsnes.wasm'));
  const core = await WasmCore.from(response);
  core.reset();
  assert.equal(core.frame().length, 256 * 240);
  assert.equal(core.frame()[0], 0xff000000);
});

test('WasmCore rejects failed responses and oversized ROMs', async () => {
  await assert.rejects(WasmCore.from(new Response('', { status: 404 })), /request failed/);
  const core = await WasmCore.from(await readFile('dist-wasm/lib-jsnes.wasm'));
  assert.throws(() => core.loadRom(new Uint8Array(WasmCore.MAX_ROM_SIZE + 1)), /capacity/);
  assert.throws(() => core.loadRom(new Uint8Array(16)), /header/);
});

test('WasmCore rejects invalid cycle budgets like the JavaScript core', async () => {
  const core = await WasmCore.from(await readFile('dist-wasm/lib-jsnes.wasm'));
  for (const cycles of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => core.step(cycles), /cycles must be a positive integer/);
  }
  const rom = new Uint8Array(16 + 0x4000); rom.set([78,69,83,26,1,0]); rom.set([0xea], 16); rom[16 + 0x3ffc] = 0; rom[16 + 0x3ffd] = 0x80;
  core.loadRom(rom); core.reset(); core.step(1); assert.equal(core.cycleCount, 2);
});
