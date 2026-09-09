import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Nes, WasmCore } from '../dist/index.js';

const binary = await readFile(new URL('../dist-wasm/lib-jsnes.wasm', import.meta.url));
function rom(mask, mode = 0, interrupts = false, timerHigh = 0, noisePeriod = 0x83) {
  const code = [], write = (address, value) => code.push(0xa9, value, 0x8d, address & 255, address >>> 8);
  write(0x4015, mask);
  for (const base of [0x4000, 0x4004, 0x4008, 0x400c]) {
    write(base, base === 0x4008 ? 0x82 : 0x62);
    if (base < 0x4008) write(base + 1, 0x89); // Negative sweep; distinct negate on pulse 1/2.
    write(base + 2, base === 0x400c ? noisePeriod : 0x39);
    write(base + 3, 0x08 | timerHigh);
  }
  write(0x4017, mode);
  if (interrupts) { write(0x2000, 0x80); code.push(0x58); }
  const loop = 0x8000 + code.length;
  write(0x4014, 2); // OAM DMA must keep both APU and PPU running.
  code.push(0x4c, loop & 255, loop >>> 8);
  const bytes = new Uint8Array(16 + 0x4000);
  bytes.set([78, 69, 83, 26, 1, 0]); bytes.set(code, 16);
  bytes.set([0xe6, 0x10, 0x40], 16 + 0x100); // NMI: INC $10; RTI.
  bytes.set([0xad, 0x15, 0x40, 0xe6, 0x11, 0x40], 16 + 0x110); // IRQ: acknowledge; count; RTI.
  bytes.set([0, 0x81, 0, 0x80, 0x10, 0x81], 16 + 0x3ffa);
  return bytes;
}

for (const mask of [1, 2, 4, 8, 15]) test(`WASM PCM matches TypeScript for channel mask ${mask} in both frame modes`, async () => {
  for (const mode of [0, 0x80]) {
    const image = rom(mask, mode), js = new Nes(image), wasm = await WasmCore.from(binary);
    js.reset(); wasm.loadRom(image); wasm.reset();
    assert.equal(wasm.sampleRate, 44100);
    assert.equal(wasm.sampleRate, js.apu.sampleRate);
    for (const budget of [7319, 1000, 9000, 37, 14919, 30000, 50000]) {
      js.step(budget); wasm.step(budget);
      assert.equal(wasm.cycleCount, js.cycleCount);
      const expected = js.audioSamples();
      assert.deepEqual(wasm.audioSamples(), expected);
      assert.equal(wasm.audioSamples().length, 0, 'drain clears queued PCM');
      if (budget === 9000) assert.ok(new Set(expected).size > 1, 'exercise a changing waveform');
    }
  }
});

test('WASM PCM and CPU state include NMI, frame IRQ, and DMA cycles exactly once', async () => {
  const image = rom(15, 0, true), js = new Nes(image), wasm = await WasmCore.from(binary);
  js.reset(); wasm.loadRom(image); wasm.reset();
  js.step(90000); wasm.step(90000);
  assert.equal(wasm.cycleCount, js.cycleCount);
  assert.equal(wasm.programCounter, js.cpu.pc);
  for (const address of [0x10, 0x11]) {
    assert.equal(wasm.exports.ramRead(address), js.read(address));
    assert.ok(js.read(address) >= 2);
  }
  assert.deepEqual(wasm.audioSamples(), js.audioSamples());
});

test('drained WASM PCM is owned by the host and reset discards the old timeline', async () => {
  const image = rom(15), core = await WasmCore.from(binary);
  core.loadRom(image); core.reset(); core.step(20000);
  const pcm = core.audioSamples(), copy = pcm.slice();
  assert.ok(pcm.length > 0);
  core.step(100000); core.audioSamples();
  assert.deepEqual(pcm, copy, 'later drains must not overwrite a retained host buffer');
  core.step(1000); core.reset();
  assert.equal(core.audioSamples().length, 0);
  core.step(20000);
  assert.deepEqual(core.audioSamples(), copy);
});

test('WASM audio queue is bounded if the host does not drain it', async () => {
  const image = rom(15), js = new Nes(image), core = await WasmCore.from(binary);
  js.reset(); core.loadRom(image); core.reset();
  const budget = 1789773 * 3;
  js.step(budget); core.step(budget);
  const pcm = core.audioSamples();
  assert.ok(pcm.length > 0 && pcm.length <= 88200);
  assert.deepEqual(pcm, js.audioSamples());
});


test('WASM preserves all eleven timer bits for pulse and triangle periods', async () => {
  for (const high of [1, 3, 7]) for (const mask of [1, 2, 4]) {
    const image = rom(mask, 0, false, high), js = new Nes(image), core = await WasmCore.from(binary);
    js.reset(); core.loadRom(image); core.reset();
    js.step(100000); core.step(100000);
    const expected = js.audioSamples();
    assert.ok(new Set(expected).size > 1);
    assert.deepEqual(core.audioSamples(), expected, `channel ${mask}, timer high ${high}`);
  }
});

test('WASM triangle PCM has the programmed period+1 frequency', async () => {
  const core = await WasmCore.from(binary); core.loadRom(rom(4)); core.reset();
  core.step(20000); core.audioSamples(); // Finish register setup and linear reload.
  core.step(32 * (0x39 + 1) * 1000);
  const pcm = core.audioSamples(); let peaks = 0, direction = 0;
  for (let i = 1; i < pcm.length; i++) {
    const next = Math.sign(pcm[i] - pcm[i - 1]);
    if (next < 0 && direction > 0) peaks++;
    if (next) direction = next;
  }
  assert.ok(Math.abs(peaks - 1000) <= 1, `expected 1000 periods, got ${peaks}`);
});


test('WASM noise PCM matches all sixteen periods and both feedback taps', async () => {
  const core = await WasmCore.from(binary);
  for (const mode of [0, 0x80]) for (let period = 0; period < 16; period++) {
    const image = rom(8, 0, false, 0, mode | period), js = new Nes(image);
    js.reset(); core.loadRom(image); core.reset();
    js.step(160000); core.step(160000);
    const expected = js.audioSamples();
    assert.ok(new Set(expected).size > 1, 'exercise audible noise');
    assert.deepEqual(core.audioSamples(), expected, `mode ${mode}, period ${period}`);
    assert.equal(core.cycleCount, js.cycleCount);
  }
});
