import assert from 'node:assert/strict';
import test from 'node:test';
import { Apu } from '../dist/index.js';

// Restore stable DAC inputs and emit exactly one sample before any timer expires.
function sample(p1, p2, triangle, noise, dmc) {
  const apu = new Apu(), state = apu.saveState(), view = new DataView(state.buffer);
  state[0] = 0xf0 | p1; state[4] = 0xf0 | p2;
  state[2] = state[6] = 100;
  state[8] = 0x30 | noise;
  state[16] = state[17] = state[18] = state[36] = 1;
  state[19] = triangle; state[20] = state[21] = state[22] = state[23] = 1;
  state[46] = 1;
  view.setUint16(14, 2, true); // Noise bit 0 clear, timer holds the LFSR.
  for (const offset of [24, 26, 28, 30]) view.setUint16(offset, 100, true);
  view.setUint32(41, 1789773 - 44100, true);
  state[66] = dmc;
  apu.loadState(state); apu.step(1);
  const pcm = apu.drainSamples(); assert.equal(pcm.length, 1);
  return pcm[0];
}

test('nonlinear mixer covers every pulse sum and weighted TND index without clipping', () => {
  for (let pulses = 0; pulses <= 30; pulses++) for (let tnd = 0; tnd <= 202; tnd++) {
    const dmc = Math.min(127, tnd), rest = tnd - dmc;
    const triangle = Math.min(15, Math.floor(rest / 3));
    const noise = Math.floor((rest - triangle * 3) / 2);
    const delta = rest - triangle * 3 - noise * 2;
    // Resolve an odd remainder with one fewer DMC step and one extra noise step.
    const d = dmc - delta, n = noise + delta;
    const expected = Math.floor(32767 * 95.52 / (pulses ? 8128 / pulses + 100 : Infinity))
      + Math.floor(32767 * 163.67 / (tnd ? 24329 / tnd + 100 : Infinity));
    const pcm = sample(Math.min(15, pulses), Math.max(0, pulses - 15), triangle, n, d);
    const c = 44100 / (Math.PI * 90), h = 44100 / (Math.PI * 440), l = 44100 / (Math.PI * 14000);
    assert.equal(pcm, Math.floor(expected * c / (c + 1) * h / (h + 1) / (l + 1) + 0.5), `pulse sum ${pulses}, TND index ${tnd}`);
    assert.ok(pcm >= 0 && pcm <= 32767);
  }
});

test('mixing compresses pulse sums and DMC reduces incremental triangle/noise gain', () => {
  assert.equal(sample(0, 0, 0, 0, 0), 0);
  assert.ok(sample(15, 15, 0, 0, 0) < 2 * sample(15, 0, 0, 0, 0));
  for (const [triangle, noise] of [[15, 0], [0, 15]]) {
    const low = sample(0, 0, triangle, noise, 0);
    const high = sample(0, 0, triangle, noise, 127) - sample(0, 0, 0, 0, 127);
    assert.ok(high > 0 && high < low);
  }
});
