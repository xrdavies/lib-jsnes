import assert from 'node:assert/strict';
import test from 'node:test';
import { Apu } from '../dist/index.js';
const periods = [428,380,340,320,286,254,226,214,190,160,142,128,106,84,72,54];
const output = apu => apu.saveState()[66];
const remaining = apu => new DataView(apu.saveState().buffer).getUint16(74, true);
function voice(data = 0x85, rate = 15) {
  const reads = [], apu = new Apu({ readDmc: address => { reads.push(address); return data; } });
  apu.write(0x4010, rate); apu.write(0x4011, 64); apu.write(0x4012, 0); apu.write(0x4013, 0); apu.write(0x4015, 16);
  return { apu, reads };
}

test('DMC shifts samples LSB first at every NTSC rate after the silent output cycle', () => {
  for (const [rate, period] of periods.entries()) {
    const { apu, reads } = voice(0x85, rate);
    apu.step(1 + 7 * period); assert.equal(output(apu), 64); assert.deepEqual(reads, [0xc000]);
    for (const expected of [66, 64, 66, 64, 62, 60, 58, 60]) {
      const before = output(apu); apu.step(period - 1); assert.equal(output(apu), before);
      apu.step(1); assert.equal(output(apu), expected);
    }
    apu.step(8 * period); assert.equal(output(apu), 60, 'empty output unit holds the DAC');
    assert.equal(remaining(apu), 0);
  }
});

test('DMC direct DAC writes mask to seven bits and delta output does not overflow', () => {
  const bare = new Apu(); bare.write(0x4011, 255); bare.step(100);
  assert.equal(output(bare), 127); assert.ok(bare.drainSamples().every(v => v === -4096 + 127 * 80));
  bare.write(0x4015, 0); assert.equal(output(bare), 127);
  for (const [data, value] of [[255, 126], [0, 1]]) {
    const { apu } = voice(data); apu.write(0x4011, value); apu.step(9000);
    assert.equal(output(apu), value);
  }
});

test('DMC reader wraps $ffff to $8000 and status clears at the final fetch', () => {
  const { apu, reads } = voice(); apu.write(0x4015, 0);
  apu.write(0x4012, 255); apu.write(0x4013, 4); apu.write(0x4010, 0x8f); apu.write(0x4015, 16);
  assert.equal(apu.readStatus() & 16, 16);
  apu.step(30000);
  assert.deepEqual(reads, Array.from({ length: 65 }, (_, i) => i < 64 ? 0xffc0 + i : 0x8000));
  assert.equal(apu.readStatus() & 0x90, 0x80);
  assert.equal(apu.readStatus() & 0x80, 0x80, 'status reads do not acknowledge DMC IRQ');
  apu.write(0x4010, 15); assert.equal(apu.irqPending, false, 'prior status reads already acknowledged frame IRQ');
});

test('DMC loop restarts at the programmed address and suppresses completion IRQ', () => {
  const { apu, reads } = voice(); apu.write(0x4010, 0xcf); apu.write(0x4017, 0x40);
  apu.step(2000);
  assert.ok(reads.length >= 4); assert.ok(reads.every(a => a === 0xc000));
  assert.equal(apu.readStatus() & 0x90, 16);
  const before = reads.length; apu.write(0x4015, 0); apu.step(2000);
  assert.equal(reads.length, before); assert.equal(apu.readStatus() & 16, 0);
});

test('DMC repeated enable preserves the reader, and stopping preserves buffered output', () => {
  const { apu, reads } = voice(255); apu.write(0x4015, 0); apu.write(0x4013, 1); apu.write(0x4015, 16);
  apu.step(1); assert.equal(remaining(apu), 16); apu.write(0x4015, 16); assert.equal(remaining(apu), 16);
  apu.write(0x4015, 0); apu.step(1000);
  assert.deepEqual(reads, [0xc000]); assert.equal(output(apu), 80);
});

test('DMC completion IRQ is acknowledged by either $4015 write or disabling IRQ via $4010', () => {
  for (const address of [0x4010, 0x4015]) {
    const { apu } = voice(); apu.write(0x4010, 0x8f); apu.step(1);
    assert.equal(apu.readStatus() & 0x90, 0x80); assert.equal(output(apu), 64);
    apu.write(address, 0); assert.equal(apu.irqPending, false);
  }
});

test('DMC snapshot preserves prefetch, bit phase, DAC, and subsequent reads and PCM', () => {
  const { apu, reads } = voice(); apu.write(0x4010, 0xcf); apu.step(600); apu.drainSamples();
  const state = apu.saveState(); reads.length = 0; apu.step(10000);
  const expectedReads = reads.slice(), pcm = apu.drainSamples(), final = apu.saveState();
  const restored = voice(); restored.apu.loadState(state); restored.apu.step(10000);
  assert.deepEqual(restored.reads, expectedReads); assert.deepEqual(restored.apu.drainSamples(), pcm);
  assert.deepEqual(restored.apu.saveState(), final);
  for (const [offset, value] of [[66,128], [67,4], [68,0], [68,9], [71,2], [73,0], [75,255], [77,255]]) {
    const corrupt = state.slice(); corrupt[offset] = value;
    assert.throws(() => restored.apu.loadState(corrupt), /DMC state/);
    assert.deepEqual(restored.apu.saveState(), final);
  }
  apu.reset(); assert.equal(output(apu), 0); assert.equal(remaining(apu), 0);
});

test('DMC maximum length fetches exactly 4081 bytes and retains its completion IRQ in a snapshot', () => {
  const { apu, reads } = voice(0); apu.write(0x4015, 0); apu.write(0x4013, 255);
  apu.write(0x4010, 0x8f); apu.write(0x4017, 0x40); apu.write(0x4015, 16);
  assert.equal(remaining(apu), 4081); apu.step(1800000);
  assert.equal(reads.length, 4081); assert.equal(reads.at(-1), 0xc000 + 4080);
  assert.equal(apu.readStatus() & 0x90, 0x80);
  const restored = voice(); restored.apu.loadState(apu.saveState());
  assert.equal(restored.apu.readStatus() & 0x90, 0x80);
  assert.equal(restored.apu.irqPending, true);
  restored.apu.write(0x4015, 0); assert.equal(restored.apu.irqPending, false);
});
