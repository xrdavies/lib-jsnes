import assert from 'node:assert/strict';
import test from 'node:test';
import { Apu } from '../dist/index.js';

const timer = apu => new DataView(apu.saveState().buffer).getUint16(28, true);
const phase = apu => apu.saveState()[19];
function triangle(period, enable = true, linear = 0x82) {
  const apu = new Apu();
  apu.write(0x4015, enable ? 4 : 0);
  apu.write(0x4008, linear);
  apu.write(0x400a, period & 255);
  apu.write(0x400b, 8 | (period >>> 8));
  return apu;
}

test('triangle high-register writes reload the complete eleven-bit timer', () => {
  for (const period of [0, 1, 99, 255, 256, 511, 2047]) {
    const apu = triangle(period);
    assert.equal(timer(apu), period);
    apu.step(1);
    assert.equal(timer(apu), period ? period - 1 : 0, 'timer runs before linear counter reload');
  }
});

test('triangle phase advances once per period+1 CPU cycles, including zero and maximum periods', () => {
  for (const period of [0, 1, 2, 99, 255, 256, 2047]) {
    const apu = triangle(period); apu.step(7457); // Quarter frame loads linear counter.
    const before = phase(apu);
    for (let i = 1; i <= 32; i++) {
      apu.step(period + 1);
      assert.equal(phase(apu), (before + i) & 31, `period ${period}, tick ${i}`);
    }
  }
});

test('inactive linear counter gates only the sequencer and length-zero also freezes phase', () => {
  const apu = triangle(9, true, 0x80); // Linear reload value zero.
  apu.step(3); assert.equal(timer(apu), 6); assert.equal(phase(apu), 0);
  apu.step(7); assert.equal(timer(apu), 9); assert.equal(phase(apu), 0);
  const disabled = triangle(9, false); disabled.step(7457);
  assert.ok(disabled.saveState()[46] > 0); assert.equal(disabled.readStatus() & 4, 0);
  const before = timer(disabled); disabled.step(1);
  assert.equal(timer(disabled), before === 0 ? 9 : before - 1);
  assert.equal(phase(disabled), 0);
  disabled.write(0x4015, 4); disabled.write(0x400b, 8);
  disabled.step(10); assert.equal(phase(disabled), 1);
});

test('triangle frequency matches the programmed period in emitted PCM', () => {
  const apu = triangle(99); apu.step(7457); apu.drainSamples();
  apu.step(3200000); // 1000 cycles of a 32-step waveform at 100 CPU clocks/step.
  const pcm = apu.drainSamples();
  let peaks = 0;
  for (let i = 1; i < pcm.length; i++) {
    if (pcm[i] > 0 && pcm[i - 1] <= 0) peaks++;
  }
  assert.ok(Math.abs(peaks - 1000) <= 1, `expected 1000 triangle periods, got ${peaks}`);
});
