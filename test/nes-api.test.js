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

test('Nes reserves interrupt-entry headroom before executing near the safe limit', () => {
  const value = nes();
  value.cpu.cycles = Number.MAX_SAFE_INTEGER - 7;
  assert.throws(() => value.step(1), /safe integer range/);
  assert.equal(value.cpu.cycles, Number.MAX_SAFE_INTEGER - 7);
  value.cpu.cycles = Number.MAX_SAFE_INTEGER - 15;
  value.step(1);
  assert.equal(value.cpu.cycles, Number.MAX_SAFE_INTEGER - 12);
});

test('cycle guard covers an eight-cycle instruction followed by NMI or IRQ without partial changes', () => {
  for (const nmi of [true, false]) {
    const rom = new Uint8Array(16 + 0x4000);
    rom.set([78, 69, 83, 26, 1, 0]); rom.set([0x03, 0x10], 16); // SLO ($10,X), eight cycles.
    rom.set([0, 0x81, 0, 0x80, 0, 0x81], 16 + 0x3ffa);
    const value = new Nes(rom); value.reset(); value.write(0x10, 0); value.write(0x11, 2);
    value.write(0x200, 0x81);
    if (nmi) { value.write(0x2000, 0x80); value.ppu.step(241 * 341 + 1); }
    else { value.cpu.p &= ~4; value.apu.step(29829); }
    for (const remaining of [8, 9, 14]) {
      value.cpu.cycles = Number.MAX_SAFE_INTEGER - remaining;
      const before = value.saveState();
      assert.throws(() => value.step(1), /safe integer range/);
      assert.deepEqual(value.saveState(), before);
    }
    value.cpu.cycles = Number.MAX_SAFE_INTEGER - 15;
    value.step(1);
    assert.equal(value.cycleCount, Number.MAX_SAFE_INTEGER);
    assert.equal(value.cpu.pc, 0x8100);
    assert.equal(value.read(0x200), 2);
    const stopped = value.saveState();
    assert.throws(() => value.runFrame(1), /safe integer range/);
    assert.deepEqual(value.saveState(), stopped);
  }
});
