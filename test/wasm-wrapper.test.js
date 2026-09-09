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

test('WasmCore falls back when streaming compilation rejects the response MIME type', async () => {
  const bytes = await readFile('dist-wasm/lib-jsnes.wasm');
  const response = new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } });
  const core = await WasmCore.from(response);
  core.reset(); assert.equal(core.frame().length, 256 * 240);
});

test('WasmCore.loadRom accepts an ArrayBuffer like the JavaScript core', async () => {
  const core = await WasmCore.from(await readFile('dist-wasm/lib-jsnes.wasm'));
  const rom = new Uint8Array(16 + 0x4000);
  rom.set([78, 69, 83, 26, 1, 0]); rom.set([0, 0x80], 16 + 0x3ffc);
  core.loadRom(rom.buffer); core.reset(); core.runFrame();
  assert.equal(core.frame().length, 256 * 240);
});

test('WasmCore accepts a precompiled WebAssembly.Module for compile caching', async () => {
  const bytes = await readFile('dist-wasm/lib-jsnes.wasm');
  const module = await WebAssembly.compile(bytes);
  const core = await WasmCore.from(module);
  core.reset();
  assert.equal(core.frame().length, 256 * 240);
});

test('WasmCore rejects valid WASM modules that do not implement its ABI', async () => {
  const emptyModule = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  await assert.rejects(WasmCore.from(emptyModule), /does not implement the lib-jsnes ABI/);
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

test('WasmCore rejects cycle budgets that would wrap at the i32 ABI before changing state', async () => {
  const core = await WasmCore.from(await readFile('dist-wasm/lib-jsnes.wasm'));
  const rom = new Uint8Array(16 + 0x4000);
  rom.set([78, 69, 83, 26, 1, 0]); rom.set([0xea, 0x4c, 0, 0x80], 16);
  rom[16 + 0x3ffd] = 0x80;
  core.loadRom(rom); core.reset();
  for (const cycles of [2 ** 31, 2 ** 32, 2 ** 32 + 1, Number.MAX_SAFE_INTEGER, 2 ** 53]) {
    assert.throws(() => core.step(cycles), /must not exceed 2147483647/);
    assert.throws(() => core.runFrame(cycles), /must not exceed 2147483647/);
    assert.equal(core.cycleCount, 0);
    assert.equal(core.programCounter, 0x8000);
  }
  assert.equal(core.audioSamples().length, 0);
  core.step(1);
  assert.equal(core.cycleCount, 2);
});
