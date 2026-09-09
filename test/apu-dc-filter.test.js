import assert from 'node:assert/strict';
import test from 'node:test';
import { Apu } from '../dist/index.js';

const c = 44100 / (Math.PI * 90), gain = c / (c + 1), feedback = (c - 1) / (c + 1);
const dac = value => Math.floor(32767 * 163.67 * value / (24329 + 100 * value));

test('fixed DMC DAC levels decay to zero, with signed transients when the level changes', () => {
  const apu = new Apu(); apu.write(0x4011, 100); apu.step(178978);
  const pcm = apu.drainSamples();
  for (let i = 0; i < pcm.length; i++) {
    assert.equal(pcm[i], Math.floor(gain * dac(100) * feedback ** i + 0.5), `sample ${i}`);
  }
  assert.ok(pcm.slice(-100).every(sample => sample === 0));
  apu.write(0x4011, 0); apu.step(178978);
  const down = apu.drainSamples(); assert.ok(down[0] < 0);
  assert.ok(down.slice(-100).every(sample => sample === 0));
  apu.reset(); apu.step(1000); assert.ok(apu.drainSamples().every(sample => sample === 0));
});

test('DC blocker attenuates low frequencies and passes a 1 kHz tone', () => {
  for (const [frequency, min, max] of [[20, 0.1, 0.35], [1000, 0.97, 1.02]]) {
    const apu = new Apu(); let cycles = 0, rawSum = 0, rawSquared = 0, filteredSquared = 0, count = 0;
    for (let i = 0; i < 22050; i++) {
      const value = Math.round(64 + 20 * Math.sin(2 * Math.PI * frequency * i / 44100));
      apu.write(0x4011, value);
      const target = Math.ceil((i + 1) * 1789773 / 44100);
      apu.step(target - cycles); cycles = target;
      const pcm = apu.drainSamples(); assert.equal(pcm.length, 1);
      if (i >= 4410) {
        const raw = dac(value); rawSum += raw; rawSquared += raw * raw;
        filteredSquared += pcm[0] * pcm[0]; count++;
      }
    }
    const ratio = Math.sqrt(filteredSquared / (rawSquared - rawSum * rawSum / count));
    assert.ok(ratio > min && ratio < max, `${frequency} Hz gain ${ratio}`);
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
  for (const [offset, value] of [[79, -1], [79, 0.5], [79, 32768], [87, Infinity], [87, NaN], [87, -32768]]) {
    const invalid = saved.slice(); new DataView(invalid.buffer).setFloat64(offset, value, true);
    assert.throws(() => restored.loadState(invalid), /Invalid APU filter state/);
    assert.deepEqual(restored.saveState(), final);
  }
  assert.throws(() => restored.loadState(saved.subarray(0, 79)), /APU state size/);
});
