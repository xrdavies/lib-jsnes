import assert from 'node:assert/strict';
import test from 'node:test';
import { Apu, Nes } from '../dist/index.js';

function configure(apu, mask) {
  apu.write(0x4015, mask);
  for (const base of [0x4000, 0x4004, 0x4008, 0x400c]) {
    apu.write(base, 0x4f);
    apu.write(base + 2, base === 0x400c ? 3 : 0x39);
    apu.write(base + 3, 0x08);
  }
}

for (const mask of [1, 2, 4, 8, 15]) {
  test(`APU snapshot replays identical PCM for channel mask ${mask}`, () => {
    const apu = new Apu();
    configure(apu, mask);
    apu.step(7319); // Nonzero sampling fraction, just before a length-clock event.
    apu.drainSamples();
    const snapshot = apu.saveState();
    const budgets = [1000, 9000, 37, 14919];
    const expected = budgets.map(cycles => {
      apu.step(cycles);
      return apu.drainSamples();
    });
    assert.ok(expected[0].length > 0);
    assert.ok(new Set(expected[0]).size > 1, 'exercise a changing waveform');
    const finalState = apu.saveState();
    apu.write(0x4015, 0);
    apu.write(0x400a, 2);
    apu.step(8000); // Queue stale PCM and disturb timers and frame phase.
    for (const target of [apu, new Apu()]) {
      target.loadState(snapshot);
      assert.equal(target.drainSamples().length, 0);
      assert.deepEqual(target.saveState(), snapshot);
      for (let i = 0; i < budgets.length; i++) {
        target.step(budgets[i]);
        assert.deepEqual(target.drainSamples(), expected[i]);
      }
      assert.deepEqual(target.saveState(), finalState);
    }
  });
}

test('invalid APU snapshot is rejected before altering state or queued audio', () => {
  const apu = new Apu(); configure(apu, 15); apu.step(7319);
  const state = apu.saveState();
  assert.throws(() => apu.loadState(state.subarray(1)), /APU state/);
  assert.deepEqual(apu.saveState(), state);
  assert.ok(apu.drainSamples().length > 0);
});

test('Nes snapshot preserves APU continuation across the public audio interface', () => {
  const rom = new Uint8Array(16 + 0x4000);
  rom.set([78, 69, 83, 26, 1, 0]);
  rom.set([0x4c, 0, 0x80], 16); // JMP $8000, no register writes or interrupts.
  rom[16 + 0x3ffd] = 0x80;
  const nes = new Nes(rom); nes.reset(); configure(nes.apu, 15);
  nes.step(7319); nes.audioSamples();
  const snapshot = nes.saveState();
  nes.step(10000);
  const expected = nes.audioSamples(), cycles = nes.cycleCount;
  nes.reset(); nes.loadState(snapshot); nes.step(10000);
  assert.equal(nes.cycleCount, cycles);
  assert.deepEqual(nes.audioSamples(), expected);
});

test('APU snapshots accept offset views and reject invalid field values atomically', () => {
  const source = new Apu(); configure(source, 15); source.step(7319);
  const snapshot = source.saveState();
  const storage = new Uint8Array(snapshot.length + 7);
  storage.set(snapshot, 3);
  const restored = new Apu(); restored.loadState(storage.subarray(3, 3 + snapshot.length));
  assert.deepEqual(restored.saveState(), snapshot);
  for (const corrupt of [
    bytes => { bytes[43] = 2; },
    bytes => { bytes[12] = 8; },
    bytes => { bytes[36] = 2; },
    bytes => { new DataView(bytes.buffer).setUint32(37, 1789773, true); },
    bytes => { new DataView(bytes.buffer).setUint16(41, 7457, true); },
    bytes => { new DataView(bytes.buffer).setUint16(30, 65535, true); },
  ]) {
    const bytes = snapshot.slice(); corrupt(bytes);
    assert.throws(() => restored.loadState(bytes), /Invalid APU state/);
    assert.deepEqual(restored.saveState(), snapshot);
  }
});
