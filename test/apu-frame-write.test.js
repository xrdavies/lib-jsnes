import assert from 'node:assert/strict';
import test from 'node:test';
import { Apu } from '../dist/index.js';

const frame = apu => new DataView(apu.saveState().buffer).getUint16(57, true);
function voice() {
  const apu = new Apu(); apu.write(0x4015, 1);
  apu.write(0x4000, 0x1f); apu.write(0x4002, 99); apu.write(0x4003, 0x18);
  return apu; // Length two, not halted.
}

test('$4017 applies mode and half-frame clocks after 3/4 cycles without resetting pulse parity', () => {
  for (const parity of [0, 1]) for (const mode of [0, 0x80]) {
    const apu = voice(); apu.step(100 + parity);
    const delay = parity ? 4 : 3, before = frame(apu);
    apu.write(0x4017, mode);
    assert.equal(frame(apu), before);
    for (let i = 1; i < delay; i++) {
      apu.step(1);
      assert.equal(frame(apu), before + i);
      assert.equal(apu.saveState()[45], 0);
      assert.equal(apu.saveState()[20], 2);
    }
    apu.step(1);
    assert.equal(frame(apu), 0);
    assert.equal(apu.saveState()[45], mode ? 1 : 0);
    assert.equal(apu.saveState()[20], mode ? 1 : 2);
    assert.equal(apu.saveState()[78], (100 + parity + delay) & 1);
    apu.step(14912); assert.equal(apu.saveState()[20], mode ? 1 : 2);
    apu.step(1); assert.equal(apu.saveState()[20], mode ? 0 : 1);
  }
});

test('IRQ inhibition is immediate; a second frame write replaces the pending reset', () => {
  const apu = voice(); apu.step(29829); assert.equal(apu.irqPending, true);
  apu.write(0x4017, 0x80); assert.equal(apu.irqPending, true);
  apu.step(1); const position = frame(apu);
  apu.write(0x4017, 0x40); assert.equal(apu.irqPending, false);
  const delay = apu.saveState()[127]; apu.step(delay - 1);
  assert.equal(frame(apu), position + delay - 1);
  assert.equal(apu.saveState()[45], 0);
  apu.step(1); assert.equal(frame(apu), 0); assert.equal(apu.saveState()[45], 0);
});

test('delayed five-step clock does not duplicate coincident quarter/half-frame clocks', () => {
  for (const endpoint of [7457, 14913]) {
    const apu = voice(); apu.step(endpoint - 3);
    apu.write(0x4017, 0x80); apu.step(apu.saveState()[127]);
    assert.equal(frame(apu), 0);
    assert.equal(apu.saveState()[20], endpoint === 7457 ? 2 : 1, 'coincident delayed clock is suppressed');
    assert.equal(apu.saveState()[45], 1);
  }
});

test('snapshots resume every pending write phase and reject malformed delay state atomically', () => {
  for (const parity of [0, 1]) for (let elapsed = 0; elapsed <= (parity ? 4 : 3); elapsed++) {
    const apu = voice(); apu.step(100 + parity); apu.write(0x4017, 0x80);
    apu.step(elapsed); apu.drainSamples();
    const saved = apu.saveState(), restored = new Apu(); restored.loadState(saved);
    apu.step(20000); restored.step(20000);
    assert.deepEqual(restored.saveState(), apu.saveState());
    assert.deepEqual(restored.drainSamples(), apu.drainSamples());
    const before = restored.saveState();
    for (const [offset, value] of [[127, 5], [128, 2], [129, 2]]) {
      const invalid = saved.slice(); invalid[offset] = value;
      assert.throws(() => restored.loadState(invalid), /Invalid APU state/);
      assert.deepEqual(restored.saveState(), before);
    }
    assert.throws(() => restored.loadState(saved.subarray(0, 127)), /APU state size/);
    restored.reset(); assert.deepEqual(restored.saveState(), new Apu().saveState());
  }
});
