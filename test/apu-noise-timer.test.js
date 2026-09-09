import assert from 'node:assert/strict';
import test from 'node:test';
import { Apu } from '../dist/index.js';

const periods = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];
const shift = apu => new DataView(apu.saveState().buffer).getUint16(14, true);
const timer = apu => new DataView(apu.saveState().buffer).getUint16(30, true);
// Reference bit sequence, independent of the emulator's packed-register arithmetic.
function sequence(short, count) {
  const bits = [1, ...Array(14).fill(0)], result = [];
  for (let i = 0; i < count; i++) {
    const feedback = bits[0] !== bits[short ? 6 : 1] ? 1 : 0;
    bits.shift(); bits.push(feedback);
    result.push(bits.reduce((n, bit, index) => n + bit * 2 ** index, 0));
  }
  return result;
}

test('noise LFSR updates at each NTSC table period in both modes even while disabled', () => {
  for (const short of [false, true]) for (const [index, period] of periods.entries()) {
    const apu = new Apu(); apu.write(0x400e, index | (short ? 0x80 : 0));
    const expected = sequence(short, 32);
    apu.step(1); // Initial zero timer expires.
    for (let tick = 0; tick < expected.length; tick++) {
      assert.equal(shift(apu), expected[tick], `mode ${short}, period ${period}, tick ${tick}`);
      assert.equal(timer(apu), period - 1);
      apu.step(period - 1); assert.equal(shift(apu), expected[tick]);
      apu.step(1);
    }
    assert.equal(apu.readStatus() & 8, 0);
  }
});

test('noise register writes preserve LFSR and countdown until the next expiration', () => {
  const apu = new Apu(); apu.write(0x400e, 3); apu.step(10);
  const before = shift(apu), remaining = timer(apu);
  apu.write(0x400e, 0x80); apu.write(0x400f, 8); apu.write(0x400c, 0x3f);
  assert.equal(shift(apu), before); assert.equal(timer(apu), remaining);
  apu.step(remaining); assert.equal(shift(apu), before);
  apu.step(1); assert.equal(timer(apu), 3);
});

test('noise snapshot replays timer phase and PCM at the longest period', () => {
  const apu = new Apu(); apu.write(0x4015, 8); apu.write(0x400c, 0x3f);
  apu.write(0x400e, 15); apu.write(0x400f, 8); apu.step(7319); apu.drainSamples();
  const state = apu.saveState(); apu.step(100000);
  const pcm = apu.drainSamples(), final = apu.saveState();
  const restored = new Apu(); restored.loadState(state); restored.step(100000);
  assert.deepEqual(restored.drainSamples(), pcm); assert.deepEqual(restored.saveState(), final);
});
