import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Cpu6502, Nes, WasmCore } from '../dist/index.js';

test('CLI SEI and PLP use the old I bit; RTI uses restored flags for instruction-end IRQ polling', () => {
  for (const opcode of [0x58, 0x78, 0x28, 0x40]) for (const oldMask of [0, 4]) for (const pulledMask of [0, 4]) {
    const memory = new Uint8Array(65536);
    memory.set([opcode, 0xea], 0x8000); memory[0x9000] = 0xea;
    memory[0x1fe] = 0x20 | pulledMask; memory[0x1ff] = 0; memory[0x100] = 0x90;
    memory[0xffff] = 0xa0;
    const cpu = new Cpu6502({ read: a => memory[a], write: (a, v) => { memory[a] = v; } }, true);
    cpu.pc = 0x8000; cpu.p = 0x20 | oldMask;
    cpu.step();
    const mask = opcode === 0x40 ? pulledMask : oldMask;
    const flags = cpu.p;
    assert.equal(cpu.irqAfterInstruction(), !mask, `${opcode.toString(16)} old ${oldMask} pulled ${pulledMask}`);
    if (!mask) {
      assert.equal(cpu.pc, 0xa000);
      assert.equal(memory[0x100 | ((cpu.sp + 1) & 255)], flags & ~16 | 32, 'stacked flags reflect the instruction result');
      assert.equal(cpu.irqAfterInstruction(), false, 'entry masks a second poll');
    } else {
      const newMask = cpu.p & 4;
      cpu.step();
      assert.equal(cpu.irqAfterInstruction(), !newMask, 'next instruction uses the new I bit');
    }
  }
});

function rom(code) {
  const bytes = new Uint8Array(16 + 32768); bytes.set([78, 69, 83, 26, 2, 0]); bytes.set(code, 16);
  bytes.set([0xad, 0x15, 0x40, 0xe6, 0x11, 0x40], 16 + 0x7000);
  bytes.set([0, 0xf0, 0, 0x80, 0, 0xf0], 16 + 32768 - 6);
  return bytes;
}
const binary = await readFile(new URL('../dist-wasm/lib-jsnes.wasm', import.meta.url));

test('pending APU IRQ waits for the instruction after CLI, including across host calls and snapshots', async () => {
  const bytes = rom([0x4c, 0, 0x80]);
  bytes.set([0x58, 0xe6, 0x10, 0x4c, 3, 0x81], 16 + 256);
  const js = new Nes(bytes), wasm = await WasmCore.from(binary);
  js.reset(); wasm.loadRom(bytes); wasm.reset(); js.step(30000); wasm.step(30000);
  js.rom.prgRom[2] = 0x81; wasm.exports.romWrite(18, 0x81);
  js.step(3); wasm.step(3); js.step(2); wasm.step(2);
  assert.equal(js.cpu.pc, 0x8101); assert.equal(wasm.programCounter, 0x8101);
  assert.equal(js.apu.irqPending, true);
  const saved = js.saveState();
  js.step(1); wasm.step(1);
  assert.equal(js.cpu.pc, 0xf000); assert.equal(wasm.programCounter, 0xf000);
  assert.equal(js.read(0x10), 1); assert.equal(wasm.exports.ramRead(0x10), 1);
  assert.equal(js.read(0x1fc), 3); assert.equal(wasm.exports.ramRead(0x1fc), 3);
  const after = js.saveState(); js.loadState(saved); js.step(1);
  assert.deepEqual(js.saveState(), after);
  assert.equal(wasm.cycleCount, js.cycleCount);
});

test('SEI and PLP cannot mask an APU IRQ polled before their I-bit update in either core', async () => {
  for (const opcode of [0x78, 0x28]) {
    // First frame IRQ assertion is at cycle 29828, during SEI or PLP.
    const prefix = opcode === 0x78 ? [0x58] : [0xa9, 0x24, 0x48, 0x58, 0x24, 0];
    const prefixCycles = opcode === 0x78 ? 2 : 10;
    const beforeCycles = opcode === 0x78 ? 29826 : 29824;
    const code = [...prefix, ...Array((beforeCycles - prefixCycles) / 2).fill(0xea), opcode, 0xe6, 0x10];
    const bytes = rom(code), js = new Nes(bytes), wasm = await WasmCore.from(binary);
    js.reset(); wasm.loadRom(bytes); wasm.reset(); js.step(beforeCycles); wasm.step(beforeCycles);
    assert.equal(js.cpu.p & 4, 0);
    js.step(1); wasm.step(1);
    assert.equal(js.cpu.pc, 0xf000); assert.equal(wasm.programCounter, 0xf000);
    assert.equal(js.cycleCount, 29835); assert.equal(wasm.cycleCount, 29835);
    assert.equal(js.read(0x10), 0); assert.equal(wasm.exports.ramRead(0x10), 0);
    assert.equal(js.read(0x1fb) & 4, 4); assert.equal(wasm.exports.ramRead(0x1fb) & 4, 4);
    assert.deepEqual(wasm.audioSamples(), js.audioSamples());
  }
});
