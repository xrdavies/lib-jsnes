import assert from 'node:assert/strict';
import test from 'node:test';
import { Apu } from '../dist/index.js';

const quarter = index => Math.floor(index / 4) * 29830 + [7457, 14913, 22371, 29829][index % 4];
function channel(base, mask, control) {
  const apu = new Apu();
  apu.write(0x4015, mask);
  apu.write(base, control);
  apu.write(base + 2, base === 0x400c ? 0 : 0x39);
  apu.write(base + 3, 0x08); // Long enough to observe envelope decay.
  let cycles = 0;
  return {
    apu,
    advanceTo(target) { assert.ok(target >= cycles); apu.step(target - cycles); cycles = target; apu.drainSamples(); },
    peak() {
      apu.step(1000); cycles += 1000;
      const pcm = apu.drainSamples();
      assert.ok(pcm.length > 0);
      // Invert the single-channel transfer curve; quantization is below half a DAC step.
      const level = Math.max(...pcm) / 32767;
      return Math.round(base === 0x400c ? level * 24329 / (2 * (163.67 - 100 * level))
        : level * 8128 / (95.52 - 100 * level));
    },
  };
}

for (const [base, mask] of [[0x4000, 1], [0x4004, 2], [0x400c, 8]]) {
  test(`channel $${base.toString(16)} decays and holds zero at envelope period 0`, () => {
    const voice = channel(base, mask, 0x40);
    for (let i = 0; i < 18; i++) {
      voice.advanceTo(quarter(i));
      assert.equal(voice.peak(), Math.max(0, 15 - i));
    }
  });
  test(`channel $${base.toString(16)} honors divider period, looping, and constant volume`, () => {
    const voice = channel(base, mask, 0x62); // Loop/halt, envelope period 2.
    for (let i = 0; i < 51; i++) {
      voice.advanceTo(quarter(i));
      assert.equal(voice.peak(), 15 - (Math.floor(i / 3) % 16));
    }
    assert.equal(voice.apu.readStatus() & mask, mask);
    voice.apu.write(base, 0x77); // Constant volume 7, does not reset envelope.
    assert.equal(voice.peak(), 7);
    voice.apu.write(base, 0x62);
    assert.equal(voice.peak(), 15); // Hidden envelope kept running.
  });
  test(`channel $${base.toString(16)} restarts its envelope only on a length write`, () => {
    const voice = channel(base, mask, 0x40);
    voice.advanceTo(quarter(4));
    assert.equal(voice.peak(), 11);
    voice.apu.write(base, 0x40);
    assert.equal(voice.peak(), 11);
    voice.apu.write(base + 3, 0x08);
    assert.equal(voice.peak(), 11); // Start flag is consumed on the next quarter event.
    voice.advanceTo(quarter(5));
    assert.equal(voice.peak(), 15);
  });
}

test('length counters clock on half frames, honor halt, and only load when enabled', () => {
  for (const [base, mask, halt] of [[0x4000, 1, 0x20], [0x4004, 2, 0x20], [0x4008, 4, 0x80], [0x400c, 8, 0x20]]) {
    const apu = new Apu();
    apu.write(base + 3, 0x18); // Length 2; disabled channel must ignore loading.
    assert.equal(apu.readStatus() & mask, 0);
    apu.write(0x4015, mask);
    assert.equal(apu.readStatus() & mask, 0);
    apu.write(base + 3, 0x18);
    apu.step(14912);
    assert.equal(apu.readStatus() & mask, mask);
    apu.step(1); // First half frame: 2 -> 1.
    assert.equal(apu.readStatus() & mask, mask);
    apu.write(base, halt);
    apu.step(29830); // Two half-frame events, both halted.
    assert.equal(apu.readStatus() & mask, mask);
    apu.write(base, 0);
    apu.step(14915); // Up to cycle 29828 of the following sequence.
    assert.equal(apu.readStatus() & mask, mask);
    apu.step(1);
    assert.equal(apu.readStatus() & mask, 0);
    apu.write(base + 3, 0x18);
    apu.write(0x4015, 0);
    assert.equal(apu.readStatus() & mask, 0);
  }
});

test('triangle linear counter gates waveform and reload flag controls its lifetime', () => {
  const apu = new Apu(); apu.write(0x4015, 4); apu.write(0x4008, 0x02); apu.write(0x400a, 1); apu.write(0x400b, 0x08);
  apu.step(1000); const before = apu.saveState(); assert.equal(before[19], 0); apu.step(7000); const after = apu.saveState(); assert.notEqual(after[19], 0);
  apu.step(30000); const expired = apu.saveState(); assert.equal(expired[46], 0);
  apu.write(0x4008, 0x82); apu.write(0x400b, 0x08); apu.step(7457); assert.ok(apu.saveState()[46] > 0);
});

test('$4017 selects five-step sequencing and clocks immediately', () => {
  const apu = new Apu();
  apu.write(0x4015, 1); apu.write(0x4000, 0x00); apu.write(0x4003, 0x08);
  apu.write(0x4017, 0x80);
  assert.equal(apu.saveState()[45], 1);
  const before = apu.saveState()[20];
  apu.step(14913); // The five-step half-frame clocks at this point.
  assert.ok(apu.saveState()[20] < before);
  apu.write(0x4017, 0);
  assert.equal(apu.saveState()[45], 0);
  assert.equal(apu.saveState()[57], 0);
});

test('$4015 reports and clears the four-step frame IRQ, while $4017 inhibit suppresses it', () => {
  const apu = new Apu();
  apu.step(29829);
  assert.equal(apu.readStatus() & 0x40, 0x40);
  assert.equal(apu.readStatus() & 0x40, 0);
  apu.step(29830);
  assert.equal(apu.readStatus() & 0x40, 0x40);
  apu.write(0x4017, 0x40);
  assert.equal(apu.readStatus() & 0x40, 0);
  apu.step(29830);
  assert.equal(apu.readStatus() & 0x40, 0);
});

test('triangle phase freezes while length or linear counters are inactive', () => {
  const apu = new Apu();
  apu.write(0x4008, 0x80); apu.write(0x400a, 1); apu.write(0x400b, 0x08); apu.write(0x4015, 4);
  apu.step(1000); assert.equal(apu.saveState()[19], 0);
  apu.write(0x4008, 0x02); apu.step(7457); assert.equal(apu.saveState()[19], 0);
  apu.write(0x400b, 0x08); apu.step(7457); assert.notEqual(apu.saveState()[19], 0);
});
