import assert from 'node:assert/strict';
import test from 'node:test';
import { Nes } from '../dist/index.js';

function nes() {
  const rom = new Uint8Array(16 + 0x4000);
  rom.set([78, 69, 83, 26, 1, 0]); rom.set([0x4c, 0, 0x80], 16);
  rom[16 + 0x3ffc] = 0; rom[16 + 0x3ffd] = 0x80;
  const value = new Nes(rom); value.reset(); return value;
}

test('runFrame honors an explicit host cycle budget and returns the shared frame', () => {
  const value = nes(); const frame = value.runFrame(1234);
  assert.ok(value.cycleCount >= 1234 && value.cycleCount <= 1236); assert.equal(frame.pixels, value.frame);
  assert.equal(frame.width, 256); assert.equal(frame.height, 240);
});

test('runFrame rejects invalid cycle budgets through the step guard', () => {
  assert.throws(() => nes().runFrame(0), /cycles must be a positive integer/);
  assert.throws(() => nes().runFrame(1.5), /cycles must be a positive integer/);
});

test('Nes rejects a budget that would make the cumulative cycle count unsafe', () => {
  const value = nes();
  value.cpu.cycles = Number.MAX_SAFE_INTEGER - 1;
  assert.throws(() => value.step(2), /safe integer range/);
  assert.equal(value.cpu.cycles, Number.MAX_SAFE_INTEGER - 1);
  assert.throws(() => value.runFrame(2), /safe integer range/);
  assert.equal(value.cpu.cycles, Number.MAX_SAFE_INTEGER - 1);
});
