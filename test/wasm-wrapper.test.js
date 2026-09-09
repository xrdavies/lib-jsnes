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
