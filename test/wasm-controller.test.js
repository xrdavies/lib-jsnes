import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Nes, WasmCore } from '../dist/index.js';

const binary = await readFile(new URL('../dist-wasm/lib-jsnes.wasm', import.meta.url));
function rom(code) {
  const bytes = new Uint8Array(16 + 0x4000);
  bytes.set([78, 69, 83, 26, 1, 0]); bytes.set(code, 16);
  bytes.set([0, 0x80], 16 + 0x3ffc);
  return bytes;
}
const readPair = offset => [0xad, 0x16, 0x40, 0x85, offset, 0xad, 0x17, 0x40, 0x85, offset + 16];
const latch = [0xa9, 1, 0x8d, 0x16, 0x40, 0xa9, 0, 0x8d, 0x16, 0x40];
// Absolute reads leave the operand's high byte ($40) on the undriven bus bits.
const expected = mask => Array.from({ length: 10 }, (_, i) => 0x40 | (i < 8 ? (mask >>> i) & 1 : 1));

test('WASM CPU reads both controllers for every mask, with identical TypeScript results', async () => {
  const image = rom([...latch, ...Array.from({ length: 10 }, (_, i) => readPair(i)).flat()]);
  const js = new Nes(image), wasm = await WasmCore.from(binary); wasm.loadRom(image);
  for (let mask = 0; mask < 256; mask++) {
    js.reset(); wasm.reset();
    for (const core of [js, wasm]) {
      core.setController(1, mask); core.setController(2, mask ^ 0xff); core.step(152);
    }
    for (const [offset, buttons] of [[0, mask], [16, mask ^ 0xff]]) {
      assert.deepEqual(Array.from({ length: 10 }, (_, i) => wasm.exports.ramRead(offset + i)), expected(buttons));
      assert.deepEqual(Array.from({ length: 10 }, (_, i) => js.read(offset + i)), expected(buttons));
    }
    assert.equal(wasm.cycleCount, js.cycleCount);
    assert.equal(wasm.programCounter, js.cpu.pc);
  }
});

test('WASM strobe tracks live A then freezes both masks; $4017 writes do not relatch', async () => {
  const image = rom([0xa9, 1, 0x8d, 0x16, 0x40, ...readPair(0),
    0xa9, 0, 0x8d, 0x16, 0x40, 0xa9, 1, 0x8d, 0x17, 0x40,
    ...Array.from({ length: 10 }, (_, i) => readPair(i + 1)).flat()]);
  const core = await WasmCore.from(binary); core.loadRom(image); core.reset();
  core.setController(1, 0); core.setController(2, 1); core.step(6);
  core.setController(1, 1); core.setController(2, 0); core.step(14);
  assert.equal(core.exports.ramRead(0), 0x41); assert.equal(core.exports.ramRead(16), 0x40);
  core.setController(1, 0x55); core.setController(2, 0xaa); core.step(6);
  core.setController(1, 0); core.setController(2, 0); core.step(146);
  assert.deepEqual(Array.from({ length: 10 }, (_, i) => core.exports.ramRead(1 + i)), expected(0x55));
  assert.deepEqual(Array.from({ length: 10 }, (_, i) => core.exports.ramRead(17 + i)), expected(0xaa));
});

test('WASM rejects invalid controller ports and does not change valid input state', async () => {
  const core = await WasmCore.from(binary);
  core.loadRom(rom([...latch, ...readPair(0)])); core.reset(); core.setController(1, 1);
  for (const player of [0, 3, 1.5, NaN]) assert.throws(() => core.setController(player, 0), /player/);
  assert.throws(() => core.exports.setController(3, 0));
  core.step(26);
  assert.equal(core.exports.ramRead(0), 0x41);
});
