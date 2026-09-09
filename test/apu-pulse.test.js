import assert from 'node:assert/strict';
import test from 'node:test';
import { Apu } from '../dist/index.js';

function pulse(channel = 0, period = 99, duty = 2) {
  const apu = new Apu(), base = 0x4000 + channel * 4;
  apu.write(0x4015, 1 << channel);
  apu.write(base, (duty << 6) | 0x3f); // Constant volume, length halt.
  apu.write(base + 2, period & 255);
  apu.write(base + 3, 8 | (period >>> 8));
  return apu;
}

function period(apu, channel = 0) {
  const state = apu.saveState(), offset = channel * 4;
  return state[offset + 2] | ((state[offset + 3] & 7) << 8);
}

test('both pulse channels produce the programmed frequency and duty cycle', () => {
  for (const channel of [0, 1]) for (const duty of [0, 1, 2, 3]) {
    const apu = pulse(channel, 99, duty);
    apu.step(160000); // 100 periods of 16 * (99 + 1) CPU cycles.
    const pcm = apu.drainSamples();
    let rises = 0;
    for (let i = 1; i < pcm.length; i++) if (pcm[i] > pcm[i - 1]) rises++;
    assert.ok(Math.abs(rises - 100) <= 1, `channel ${channel}, duty ${duty}: ${rises} rises`);
    const highRatio = pcm.filter(value => value > 0).length / pcm.length;
    assert.ok(Math.abs(highRatio - [0.125, 0.25, 0.5, 0.75][duty]) < 0.01);
  }
});

test('pulse timer clocks every other CPU cycle and register writes preserve its countdown', () => {
  const apu = pulse();
  apu.step(1); assert.equal(apu.saveState()[12], 0);
  apu.step(1); assert.equal(apu.saveState()[12], 1);
  apu.step(199); assert.equal(apu.saveState()[12], 1);
  const remaining = new DataView(apu.saveState().buffer).getUint16(24, true);
  apu.write(0x4003, 9); // Reset duty phase, preserve timer countdown.
  assert.equal(new DataView(apu.saveState().buffer).getUint16(24, true), remaining);
  assert.equal(apu.saveState()[12], 0);
  apu.step(1); assert.equal(apu.saveState()[12], 1);
});

test('sweep clocks on half frames and reload uses the divider before resetting it', () => {
  const apu = pulse(0, 100);
  apu.write(0x4001, 0x91); // Add half the period every two half frames.
  apu.step(7457); assert.equal(period(apu), 100);
  apu.step(7456); assert.equal(period(apu), 150);
  apu.step(14916); assert.equal(period(apu), 150);
  apu.step(14914); assert.equal(period(apu), 225);
  apu.write(0x4001, 0x81); // Reload with a nonzero divider: no immediate sweep.
  apu.step(14916); assert.equal(period(apu), 225);
  apu.step(14914); assert.equal(period(apu), 337);
});

test('sweep handles channel-specific negate, zero shift, and muted targets without clamping', () => {
  for (const channel of [0, 1]) {
    const apu = pulse(channel, 100);
    apu.write(0x4001 + 4 * channel, 0x89);
    apu.step(14913);
    assert.equal(period(apu, channel), channel ? 50 : 49);
  }
  for (const [initial, sweep, muted] of [[7, 0x08, true], [8, 0x08, false], [0x600, 0x81, true], [0x600, 0x01, true], [0x600, 0x08, false], [100, 0x80, false]]) {
    const apu = pulse(0, initial);
    apu.write(0x4001, sweep);
    apu.step(30000);
    assert.equal(period(apu), initial);
    const pcm = apu.drainSamples();
    assert.equal(pcm.every(value => value === 0), muted);
  }
});

test('reset clears sweep state and snapshots replay an active sweep across odd cycle budgets', () => {
  const apu = pulse(); apu.write(0x4001, 0x91); apu.step(14915); apu.drainSamples();
  const state = apu.saveState();
  apu.step(45001); const expected = apu.drainSamples(), finalState = apu.saveState();
  const restored = new Apu(); restored.loadState(state);
  restored.step(1); restored.step(45000);
  assert.deepEqual(restored.drainSamples(), expected);
  assert.deepEqual(restored.saveState(), finalState);
  apu.reset(); assert.deepEqual(apu.saveState(), new Apu().saveState());
});
