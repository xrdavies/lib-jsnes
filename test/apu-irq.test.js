import assert from 'node:assert/strict';
import test from 'node:test';
import { Apu, Nes } from '../dist/index.js';
import { WasmCore } from '../dist/index.js';
import { readFile } from 'node:fs/promises';

function machine() {
  const rom = new Uint8Array(16 + 0x4000);
  rom.set([78, 69, 83, 26, 1, 0]);
  rom.set([0x58, 0x4c, 1, 0x80], 16); // CLI; JMP $8001. No status polling in the main loop.
  rom.set([0xad, 0x15, 0x40, 0x85, 0x12, 0xe6, 0x11, 0x40], 16 + 0x100); // LDA $4015; STA $12; INC $11; RTI.
  rom.set([0, 0x81, 0, 0x80, 0, 0x81], 16 + 0x3ffa);
  const nes = new Nes(rom); nes.reset();
  return nes;
}

test('four-step IRQ reasserts on all three terminal clocks after status acknowledgement', () => {
  const apu = new Apu();
  let cycles = 0;
  for (const target of [7457, 14913, 22371, 29827]) {
    apu.step(target - cycles); cycles = target;
    assert.equal(apu.irqPending, false, `unexpected IRQ at cycle ${target}`);
  }
  for (const cycle of [29828, 29829, 29830]) {
    apu.step(1); assert.equal(apu.irqPending, true, `missing IRQ at ${cycle}`);
    assert.equal(apu.readStatus() & 0x40, 0x40);
    assert.equal(apu.readStatus() & 0x40, 0, 'no reassertion without a clock');
  }
  apu.step(1); assert.equal(apu.irqPending, false);
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

test('terminal IRQ clocks survive snapshots and are suppressed by immediate inhibit', () => {
  for (const position of [29827, 29828, 29829, 29830]) {
    const apu = new Apu(); apu.step(position); apu.readStatus();
    const saved = apu.saveState(), restored = new Apu(); restored.loadState(saved);
    for (let i = 0; i < 4; i++) {
      apu.step(1); restored.step(1);
      const expected = position + i + 1 <= 29830;
      assert.equal(apu.irqPending, expected);
      assert.equal(restored.irqPending, expected);
      assert.deepEqual(apu.saveState(), restored.saveState());
      apu.readStatus(); restored.readStatus();
    }
    restored.loadState(saved); restored.write(0x4017, 0x40);
    assert.equal(restored.irqPending, false);
    for (let i = 0; i < 8; i++) { restored.step(1); assert.equal(restored.irqPending, false); }
  }
  const fiveStep = new Apu(); fiveStep.write(0x4017, 0x80); fiveStep.step(3);
  for (const cycles of [29827, 1, 1, 1, 7451, 1]) {
    fiveStep.step(cycles); assert.equal(fiveStep.readStatus() & 64, 0);
  }
});

test('JS and WASM observe a reasserted frame IRQ after a CPU status read in the terminal window', async () => {
  const bytes = new Uint8Array(16 + 16384); bytes.set([78, 69, 83, 26, 1, 0]);
  bytes.fill(0xea, 16, 16 + 14912); // First LDA reads $4015 on its fourth cycle, at 29828.
  const code = [0xad, 0x15, 0x40, 0x85, 0, 0xad, 0x15, 0x40, 0x85, 1,
    0xad, 0x15, 0x40, 0x85, 2];
  bytes.set(code, 16 + 14912); bytes.set([0, 0x80], 16 + 16384 - 4);
  const js = new Nes(bytes), wasm = await WasmCore.from(await readFile('dist-wasm/lib-jsnes.wasm'));
  js.reset(); wasm.loadRom(bytes); wasm.reset();
  js.step(29824); wasm.step(29824);
  js.step(21); wasm.step(21);
  assert.deepEqual([0, 1, 2].map(a => js.read(a)), [64, 64, 0]);
  assert.deepEqual([0, 1, 2].map(a => wasm.exports.ramRead(a)), [64, 64, 0]);
  assert.equal(wasm.cycleCount, js.cycleCount);
  assert.deepEqual(wasm.audioSamples(), js.audioSamples());
});
