import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Nes, WasmCore } from '../dist/index.js';
import { workload } from '../scripts/benchmark-core.mjs';

const binary = await readFile(new URL('../dist-wasm/lib-jsnes.wasm', import.meta.url));
function largeMmc3() {
  const start = 16 + 512, prg = 0x80000, chr = 0x40000;
  const bytes = new Uint8Array(start + prg + chr);
  bytes.set([78, 69, 83, 26, 32, 32, 0x44, 0]);
  bytes.fill(0x5a, 16, start);
  for (let i = 0; i < 64; i++) bytes.fill(i, start + i * 8192, start + (i + 1) * 8192);
  for (let i = 0; i < 256; i++) bytes.fill(i, start + prg + i * 1024, start + prg + (i + 1) * 1024);
  const code = [0xa9, 6, 0x8d, 0, 0x80, 0xa9, 60, 0x8d, 1, 0x80,
    0xa9, 7, 0x8d, 0, 0x80, 0xa9, 61, 0x8d, 1, 0x80,
    0xa9, 2, 0x8d, 0, 0x80, 0xa9, 255, 0x8d, 1, 0x80];
  for (let i = 0; i < 4; i++) code.push(0xad, 0, 0x80 + i * 0x20, 0x85, i);
  code.push(0xad, 0, 0x70, 0x85, 4);
  const loop = 0xe100 + code.length;
  bytes.set([...code, 0x4c, loop & 255, loop >>> 8], start + prg - 0x1f00);
  bytes.set([0, 0xe1], start + prg - 4);
  return bytes;
}

test('WASM boots a 512 KiB PRG plus 256 KiB CHR MMC3 ROM and rejects replacements atomically', async () => {
  const bytes = largeMmc3(), js = new Nes(bytes), wasm = await WasmCore.from(binary);
  js.reset(); wasm.loadRom(bytes); wasm.reset();
  assert.equal(wasm.programCounter, 0xe100);
  js.step(60000); wasm.step(60000);
  assert.deepEqual([0, 1, 2, 3, 4].map(i => wasm.exports.ramRead(i)), [60, 61, 62, 63, 0x5a]);
  assert.equal(wasm.exports.chrRead(0x1000), 255);
  assert.deepEqual(wasm.frame(), js.frame);
  assert.deepEqual(wasm.audioSamples(), js.audioSamples());
  assert.equal(wasm.programCounter, js.cpu.pc);
  assert.equal(wasm.cycleCount, js.cycleCount);
  const unsupported = bytes.slice(); unsupported[6] = 0x54;
  for (const invalid of [bytes.subarray(0, bytes.length - 1), unsupported]) {
    assert.throws(() => wasm.loadRom(invalid));
    assert.equal(wasm.programCounter, js.cpu.pc);
    assert.equal(wasm.exports.chrRead(0x1000), 255);
  }
  for (const length of [-1, 0, 15, WasmCore.MAX_ROM_SIZE + 1]) {
    assert.throws(() => wasm.exports.romAllocate(length));
    assert.equal(wasm.exports.chrRead(0x1000), 255);
  }
});

test('NES 2.0 CNROM and GxROM bank CHR using the full extended size', async () => {
  for (const mapper of [3, 66]) {
    const bytes = new Uint8Array(16 + 0x4000 + 256 * 0x2000);
    bytes.set([78, 69, 83, 26, 1, 0, (mapper & 15) << 4, (mapper & 0xf0) | 8, 0, 0x10]);
    for (let i = 0; i < 256; i++) {
      bytes.set([0xa9, i, 0x8d, 0, 0x80], 16 + i * 5);
      bytes.fill(i, 16 + 0x4000 + i * 0x2000, 16 + 0x4000 + (i + 1) * 0x2000);
    }
    bytes.set([0, 0x80], 16 + 0x3ffc);
    const js = new Nes(bytes), wasm = await WasmCore.from(binary);
    js.reset(); wasm.loadRom(bytes); wasm.reset();
    for (let value = 0; value < 256; value++) {
      js.step(6); wasm.step(6);
      const expected = mapper === 3 ? value : value & 3;
      for (const address of [0, 0x1000, 0x1fff]) {
        assert.equal(wasm.exports.chrRead(address), expected);
        assert.equal(js.cartridge.readChr(address), expected);
      }
    }
  }
});

test('ROM bulk copy accepts WASM-backed views and repeated large/small reloads reclaim storage', async () => {
  const wasm = await WasmCore.from(binary), small = workload(), large = largeMmc3();
  const pointer = wasm.exports.romAllocate(small.length);
  const input = new Uint8Array(wasm.exports.memory.buffer, pointer, small.length);
  input.set(small);
  wasm.loadRom(input); wasm.reset(); wasm.runFrame();
  assert.equal(wasm.exports.unknownOpcodeCount(), 0);
  const reload = () => { wasm.loadRom(large); wasm.reset(); wasm.loadRom(small); wasm.reset(); };
  reload(); reload();
  const warmedBytes = wasm.exports.memory.buffer.byteLength;
  for (let i = 0; i < 30; i++) reload();
  assert.equal(wasm.exports.memory.buffer.byteLength, warmedBytes);
  wasm.runFrame(); assert.equal(wasm.exports.unknownOpcodeCount(), 0);
});
