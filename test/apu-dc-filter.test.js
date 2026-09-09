import assert from 'node:assert/strict';
import test from 'node:test';
import { Apu } from '../dist/index.js';

function referenceChain() {
  const stages = [90, 440, 14000].map((hz, index) => {
    const c = 44100 / (Math.PI * hz), b0 = index === 2 ? 1 / (1 + c) : c / (1 + c);
    return { b0, b1: index === 2 ? b0 : -b0, a1: (1 - c) / (1 + c), x: 0, y: 0 };
  });
  return input => {
    for (const stage of stages) {
      const output = stage.b0 * input + stage.b1 * stage.x - stage.a1 * stage.y;
      stage.x = input; stage.y = output; input = output;
    }
    return Math.round(Math.min(32767, Math.max(-32768, input)));
  };
}
const dac = value => Math.floor(32767 * 163.67 * value / (24329 + 100 * value));

test('fixed DMC DAC levels decay to zero, with signed transients when the level changes', () => {
  const apu = new Apu(); apu.write(0x4011, 100); apu.step(178978);
  const pcm = apu.drainSamples();
  const reference = referenceChain();
  for (let i = 0; i < pcm.length; i++) {
    assert.ok(Math.abs(pcm[i] - reference(dac(100))) <= 1, `sample ${i}`);
  }
  assert.ok(pcm.slice(-100).every(sample => sample === 0));
  apu.write(0x4011, 0); apu.step(178978);
  const down = apu.drainSamples(); assert.ok(down[0] < 0);
  assert.ok(down.slice(-100).every(sample => sample === 0));
  apu.reset(); apu.step(1000); assert.ok(apu.drainSamples().every(sample => sample === 0));
});

test('three-stage frequency response matches the bilinear transfer functions', () => {
  for (const frequency of [20, 90, 440, 1000, 10000, 14000, 20000]) {
    const apu = new Apu(); let inputEnergy = 0, outputEnergy = 0;
    for (let i = 0; i < 22050; i++) {
      // Isolate filter response from the DMC's 7-bit quantization and nonlinear mixer.
      const input = Math.round(12000 + 5000 * Math.sin(2 * Math.PI * frequency * i / 44100));
      const output = apu.filterSample(input);
      if (i >= 4410) { inputEnergy += (input - 12000) ** 2; outputEnergy += output ** 2; }
    }
    const measured = Math.sqrt(outputEnergy / inputEnergy);
    const sin = Math.sin(Math.PI * frequency / 44100), cos = Math.cos(Math.PI * frequency / 44100);
    const expected = [90, 440, 14000].reduce((gain, cutoff, i) => {
      const c = 44100 / (Math.PI * cutoff);
      return gain * (i === 2 ? cos : c * sin) / Math.hypot(c * sin, cos);
    }, 1);
    assert.ok(Math.abs(measured - expected) < 0.002, `${frequency} Hz: ${measured} vs ${expected}`);
  }
});

test('filter history survives snapshots and drains, while invalid history is rejected atomically', () => {
  const apu = new Apu(); apu.write(0x4011, 127); apu.step(1000); apu.drainSamples();
  const saved = apu.saveState();
  apu.write(0x4011, 31); apu.step(10000);
  const expected = apu.drainSamples(), final = apu.saveState();
  const restored = new Apu(); restored.loadState(saved); restored.write(0x4011, 31);
  restored.step(333); const first = restored.drainSamples(); restored.step(9667);
  assert.deepEqual(Int16Array.from([...first, ...restored.drainSamples()]), expected);
  assert.deepEqual(restored.saveState(), final);
  for (const [offset, value] of [[79, -1], [79, 0.5], [79, 32768], [87, Infinity], [87, NaN], [87, -32768], [95, NaN], [103, Infinity], [111, -Infinity], [119, 65535]]) {
    const invalid = saved.slice(); new DataView(invalid.buffer).setFloat64(offset, value, true);
    assert.throws(() => restored.loadState(invalid), /Invalid APU filter state/);
    assert.deepEqual(restored.saveState(), final);
  }
  assert.throws(() => restored.loadState(saved.subarray(0, 95)), /APU state size/);
});

test('filter output saturates instead of wrapping an excessive transient into Int16 PCM', () => {
  const apu = new Apu();
  assert.equal(apu.filterSample(1e9), 32767);
  assert.equal(apu.filterSample(-1e9), -32768);
});
