import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Apu, Nes, WasmCore } from '../dist/index.js';

function configure(apu) {
  apu.write(0x4015, 3);
  for (const base of [0x4000, 0x4004]) {
    apu.write(base, 0xbf); apu.write(base + 1, 8);
    apu.write(base + 2, 99); apu.write(base + 3, 8);
  }
}

test('$4017 writes never rephase pulse timers, for either CPU parity or frame mode', () => {
  for (const parity of [0, 1]) for (const mode of [0, 0x40, 0x80, 0xc0]) {
    const source = new Apu(), reference = new Apu(); configure(source); configure(reference);
    source.step(parity); reference.step(parity);
    for (const cycles of [1, 2, 3, 199, 200, 7457, 29831]) {
      source.write(0x4017, mode);
      source.step(cycles); reference.step(cycles);
      assert.deepEqual(source.saveState().subarray(12, 14), reference.saveState().subarray(12, 14));
      assert.deepEqual(source.saveState().subarray(24, 28), reference.saveState().subarray(24, 28));
      assert.deepEqual(source.drainSamples(), reference.drainSamples());
    }
  }
});

test('APU snapshots retain the pulse phase independently of frame phase and reject invalid phase', () => {
  const source = new Apu(); configure(source); source.step(1); source.write(0x4017, 0);
  const saved = source.saveState(), restored = new Apu(); restored.loadState(saved);
  assert.equal(saved[78], 1); assert.equal(new DataView(saved.buffer).getUint16(57, true), 0);
  source.step(10000); restored.step(10000);
  assert.deepEqual(restored.drainSamples(), source.drainSamples());
  assert.deepEqual(restored.saveState(), source.saveState());
  const before = restored.saveState(), invalid = saved.slice(); invalid[78] = 2;
  assert.throws(() => restored.loadState(invalid), /Invalid APU state/);
  assert.deepEqual(restored.saveState(), before);
  assert.throws(() => restored.loadState(saved.subarray(0, 78)), /APU state size/);
  restored.reset(); assert.deepEqual(restored.saveState(), new Apu().saveState());
});

test('CPU-driven frame-counter writes preserve the pulse waveform in TypeScript and WASM', async () => {
  const binary = await readFile(new URL('../dist-wasm/lib-jsnes.wasm', import.meta.url));
  function rom(address, mode) {
    const code = [], write = (a, v) => code.push(0xa9, v, 0x8d, a & 255, a >>> 8);
    write(0x4015, 3);
    for (const base of [0x4000, 0x4004]) {
      write(base, 0xbf); write(base + 1, 8); write(base + 2, 99); write(base + 3, 8);
    }
    const loop = 0x8000 + code.length;
    write(address, mode); code.push(0x4c, loop & 255, loop >>> 8); // 9-cycle loop alternates CPU parity.
    const bytes = new Uint8Array(16 + 16384); bytes.set([78, 69, 83, 26, 1, 0]); bytes.set(code, 16);
    bytes.set([0, 0x80], 16 + 16384 - 4); return bytes;
  }
  for (const mode of [0, 0x80]) {
    const reference = new Nes(rom(0x5000, mode)), js = new Nes(rom(0x4017, mode));
    const wasm = await WasmCore.from(binary); reference.reset(); js.reset(); wasm.loadRom(rom(0x4017, mode)); wasm.reset();
    for (const budget of [10000, 30000, 90000]) {
      reference.step(budget); js.step(budget); wasm.step(budget);
      const expected = reference.audioSamples(); assert.ok(new Set(expected).size > 1);
      assert.deepEqual(js.audioSamples(), expected); assert.deepEqual(wasm.audioSamples(), expected);
      assert.equal(js.cycleCount, reference.cycleCount); assert.equal(wasm.cycleCount, reference.cycleCount);
    }
  }
});
