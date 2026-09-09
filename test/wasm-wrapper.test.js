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
});
