import assert from 'node:assert/strict';
import test from 'node:test';
import { Apu, Nes } from '../dist/index.js';

function machine() {
  const rom = new Uint8Array(16 + 0x4000);
  rom.set([78, 69, 83, 26, 1, 0]);
  rom.set([0x58, 0x4c, 1, 0x80], 16); // CLI; JMP $8001. No status polling in the main loop.
  rom.set([0xad, 0x15, 0x40, 0x85, 0x12, 0xe6, 0x11, 0x40], 16 + 0x100); // LDA $4015; STA $12; INC $11; RTI.
  rom.set([0, 0x81, 0, 0x80, 0, 0x81], 16 + 0x3ffa);
  const nes = new Nes(rom); nes.reset();
  return nes;
}

test('four-step IRQ is absent at earlier frame clocks and asserted on all three terminal cycles', () => {
  const apu = new Apu();
  let cycles = 0;
  for (const target of [7457, 14913, 22371, 29827]) {
    apu.step(target - cycles); cycles = target;
    assert.equal(apu.irqPending, false, `unexpected IRQ at cycle ${target}`);
  }
  for (const target of [29828, 29829, 29830]) {
    apu.step(1);
    assert.equal(apu.irqPending, true, `missing IRQ at cycle ${target}`);
    assert.equal(apu.readStatus() & 0x40, 0x40);
    assert.equal(apu.irqPending, false);
    assert.equal(apu.readStatus() & 0x40, 0);
  }
  apu.step(1);
  assert.equal(apu.irqPending, false, 'the next sequence starts without another assertion');
});

test('IRQ latch persists until acknowledged, including across snapshots and mode changes', () => {
  const apu = new Apu(); apu.step(30000);
  assert.equal(apu.irqPending, true);
  const state = apu.saveState();
  const restored = new Apu(); restored.loadState(state);
  for (const target of [apu, restored]) {
    target.write(0x4015, 0); // Channel enable writes do not acknowledge the frame IRQ.
    target.write(0x4017, 0x80); // Five-step mode prevents new IRQs, but does not acknowledge this one.
    target.step(40000);
    assert.equal(target.irqPending, true);
    assert.equal(target.readStatus() & 0x40, 0x40);
    target.step(80000);
    assert.equal(target.irqPending, false);
  }
});

test('$4017 inhibit immediately clears the pending IRQ and survives restoration', () => {
  const apu = new Apu(); apu.step(30000);
  apu.write(0x4017, 0x40);
  assert.equal(apu.irqPending, false);
  const restored = new Apu(); restored.loadState(apu.saveState());
  restored.step(90000);
  assert.equal(restored.readStatus() & 0x40, 0);
  restored.write(0x4017, 0);
  restored.step(30000);
  assert.equal(restored.irqPending, true);
});

test('CPU services exactly one acknowledged IRQ per four-step sequence and returns to its main loop', () => {
  const nes = machine();
  nes.step(14920);
  assert.equal(nes.read(0x11), 0, 'the first half-frame must not interrupt the CPU');
  for (let count = 1; count <= 3; count++) {
    nes.step(count * 30000 - nes.cycleCount);
    assert.equal(nes.read(0x11), count);
    assert.equal(nes.read(0x12) & 0x40, 0x40, 'handler must observe its IRQ source');
    assert.equal(nes.apu.irqPending, false);
    assert.equal(nes.cpu.pc, 0x8001);
    assert.equal(nes.cpu.sp, 0xfd);
  }
});

test('CPU masking preserves pending APU IRQs until interrupts are enabled', () => {
  const nes = machine(); nes.step(2); // Execute CLI before explicitly masking interrupts.
  nes.cpu.p |= 4;
  nes.step(30000);
  assert.equal(nes.read(0x11), 0);
  assert.equal(nes.apu.irqPending, true);
  nes.cpu.p &= ~4;
  nes.step(100);
  assert.equal(nes.read(0x11), 1);
  assert.equal(nes.apu.irqPending, false);
  assert.equal(nes.cpu.sp, 0xfd);
});
