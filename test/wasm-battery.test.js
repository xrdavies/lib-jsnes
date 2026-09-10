import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Nes, WasmCore } from '../dist/index.js';
const binary = await readFile(new URL('../dist-wasm/lib-jsnes.wasm', import.meta.url));
function image(mapper, code = []) {
  const rom = new Uint8Array(16 + 0x8000);
  rom.set([78, 69, 83, 26, 2, 0, ((mapper & 15) << 4) | 2, mapper & 0xf0]);
  for (let bank = 0; bank < 4; bank++) {
    rom.set(code, 16 + bank * 8192);
    rom.set([0, 0x80], 16 + (bank + 1) * 8192 - 4);
  }
  return rom;
}
const readEdges = [0xad, 0, 0x60, 0x85, 0, 0xad, 0xff, 0x7f, 0x85, 1];
async function core(rom) {
  const wasm = await WasmCore.from(binary); wasm.loadRom(rom); wasm.reset(); return wasm;
}

for (const mapper of [0, 1, 2, 3, 4, 7, 9, 10, 11, 13, 32, 34, 66, 71, 180]) test(`mapper ${mapper} battery bytes transfer between JS and fresh WASM instances`, async () => {
  const rom = image(mapper, readEdges), js = new Nes(rom), first = await core(rom), second = await core(rom);
  const bytes = Uint8Array.from({ length: 8192 }, (_, i) => (i * 17 + 5) & 255);
  js.loadBatteryRam(bytes); first.loadBatteryRam(js.saveBatteryRam());
  assert.deepEqual(first.saveBatteryRam(), bytes);
  second.loadBatteryRam(first.saveBatteryRam()); second.reset(); second.step(14);
  assert.equal(second.exports.ramRead(0), bytes[0]); assert.equal(second.exports.ramRead(1), bytes[8191]);
  const back = new Nes(rom); back.loadBatteryRam(second.saveBatteryRam());
  assert.deepEqual(back.saveBatteryRam(), bytes);
});

test('WASM battery buffers are independent, accept offset views, and reject wrong sizes atomically', async () => {
  const wasm = await core(image(0));
  const storage = new Uint8Array(8200); storage.fill(0x5a);
  wasm.loadBatteryRam(storage.subarray(3, 8195)); storage.fill(0);
  const saved = wasm.saveBatteryRam(); assert.ok(saved.every(v => v === 0x5a));
  saved.fill(0xff); assert.equal(wasm.saveBatteryRam()[0], 0x5a);
  for (const length of [0, 8191, 8193]) assert.throws(() => wasm.loadBatteryRam(new Uint8Array(length)), /8192 bytes/);
  assert.ok(wasm.saveBatteryRam().every(v => v === 0x5a));
  wasm.exports.memory.grow(1);
  assert.ok(wasm.saveBatteryRam().every(v => v === 0x5a), 'use the current memory buffer after growth');
  wasm.loadRom(image(0)); assert.ok(wasm.saveBatteryRam().every(v => v === 0), 'new cartridge clears old battery bytes');
});

test('MMC1 disable and MMC3 write protection do not block host persistence or change mapper controls', async () => {
  for (const mapper of [1, 4]) for (const protect of [false, true]) {
    if (mapper === 1 && protect) continue;
    const write = (a, v) => [0xa9, v, 0x8d, a & 255, a >>> 8];
    const configure = enabled => mapper === 1
      ? Array.from({ length: 5 }, (_, i) => write(0xe000, enabled ? 0 : +(i === 4))).flat()
      : write(0xa001, enabled ? 0x80 : protect ? 0xc0 : 0);
    const disable = configure(false), enable = configure(true);
    const rom = image(mapper, [...disable, ...write(0x6000, 0xff), ...readEdges, ...enable, ...readEdges]);
    const wasm = await core(rom); wasm.step(mapper === 1 ? 30 : 6); // LDA/STA costs six cycles, five pairs for MMC1.
    const bytes = new Uint8Array(8192).fill(0x55); wasm.loadBatteryRam(bytes);
    assert.deepEqual(wasm.saveBatteryRam(), bytes);
    wasm.step(20); // Protected CPU write + two edge reads.
    assert.equal(wasm.exports.ramRead(0), protect ? 0x55 : 0x60);
    assert.equal(wasm.exports.ramRead(1), protect ? 0x55 : 0x7f);
    assert.deepEqual(wasm.saveBatteryRam(), bytes);
    wasm.step((mapper === 1 ? 30 : 6) + 14);
    assert.equal(wasm.exports.ramRead(0), 0x55); assert.equal(wasm.exports.ramRead(1), 0x55);
  }
});
