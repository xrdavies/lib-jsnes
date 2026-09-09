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

test('a same-page taken branch delays an IRQ that a three-cycle JMP would accept', async () => {
  for (const branch of [false, true]) {
    const code = [0x58, ...Array((29826 - 2) / 2).fill(0xea)];
    const next = 0x8000 + code.length + (branch ? 2 : 3);
    code.push(...(branch ? [0x90, 0] : [0x4c, next & 255, next >>> 8]), 0xe6, 0x10);
    const bytes = rom(code), js = new Nes(bytes), wasm = await WasmCore.from(binary);
    js.reset(); wasm.loadRom(bytes); wasm.reset(); js.step(29826); wasm.step(29826);
    js.step(1); wasm.step(1); // IRQ asserts during the operand cycle at 29828.
    assert.equal(js.cpu.pc, branch ? next : 0xf000);
    assert.equal(wasm.programCounter, js.cpu.pc);
    assert.equal(js.read(0x10), 0); assert.equal(wasm.exports.ramRead(0x10), 0);
    if (branch) {
      js.step(1); wasm.step(1);
      assert.equal(js.cpu.pc, 0xf000); assert.equal(wasm.programCounter, 0xf000);
      assert.equal(js.read(0x10), 1); assert.equal(wasm.exports.ramRead(0x10), 1);
    }
    assert.equal(wasm.cycleCount, js.cycleCount);
    assert.deepEqual(wasm.audioSamples(), js.audioSamples());
  }
});

test('a same-page branch also retains a late NMI until the next instruction, including snapshot replay', () => {
  const js = new Nes(rom([0x90, 0, 0xe6, 0x10])); js.reset();
  js.write(0x2000, 0x80); js.ppu.step(241 * 341 - 4);
  js.step(1); assert.equal(js.cpu.pc, 0x8002);
  const saved = js.saveState();
  js.step(1); assert.equal(js.read(0x10), 1); assert.equal(js.cpu.pc, 0xf000);
  const after = js.saveState();
  js.loadState(saved); js.step(1); assert.equal(js.read(0x10), 1);
  assert.deepEqual(js.saveState(), after);
});

test('the earlier branch sample cannot revive an IRQ cleared before the normal poll', () => {
  const nes = new Nes(rom([0x90, 0])); nes.reset(); nes.cpu.p &= ~4;
  nes.apu.step(29828);
  const read = nes.read.bind(nes);
  nes.read = (address, tick) => {
    const value = read(address, tick);
    if (address === 0x8001) nes.apu.readStatus();
    return value;
  };
  nes.step(1);
  assert.equal(nes.cpu.pc, 0x8002); assert.equal(nes.apu.irqPending, false);
});

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
  assert.equal(js.read(0x10), 1); assert.equal(js.read(0x1fc), 3);
  assert.deepEqual(js.saveState(), after);
  assert.equal(wasm.cycleCount, js.cycleCount);
});

test('SEI and PLP poll IRQ before their last cycle and I-bit update in either core', async () => {
  for (const opcode of [0x78, 0x28]) for (const early of [false, true]) {
    // IRQ asserts at 29828: the late case reaches it on the last cycle;
    // adding a cycle puts it before the instruction's interrupt poll.
    const prefix = opcode === 0x78 ? [0x58] : [0xa9, 0x24, 0x48, 0x58, 0x24, 0];
    if (early) prefix.push(0x24, 0);
    const prefixCycles = (opcode === 0x78 ? 2 : 10) + (early ? 3 : 0);
    const beforeCycles = (opcode === 0x78 ? 29826 : 29824) + Number(early);
    const code = [...prefix, ...Array((beforeCycles - prefixCycles) / 2).fill(0xea), opcode, 0xe6, 0x10];
    const bytes = rom(code), js = new Nes(bytes), wasm = await WasmCore.from(binary);
    js.reset(); wasm.loadRom(bytes); wasm.reset(); js.step(beforeCycles); wasm.step(beforeCycles);
    assert.equal(js.cpu.p & 4, 0);
    js.step(1); wasm.step(1);
    const pc = early ? 0xf000 : 0x8000 + code.length - 2;
    assert.equal(js.cpu.pc, pc); assert.equal(wasm.programCounter, pc);
    assert.equal(js.cycleCount, early ? 29836 : 29828); assert.equal(wasm.cycleCount, js.cycleCount);
    assert.equal(js.read(0x10), 0); assert.equal(wasm.exports.ramRead(0x10), 0);
    if (early) {
      assert.equal(js.read(0x1fb) & 4, 4); assert.equal(wasm.exports.ramRead(0x1fb) & 4, 4);
    } else {
      js.step(1); wasm.step(1);
      assert.equal(js.read(0x10), 1); assert.equal(wasm.exports.ramRead(0x10), 1);
    }
    assert.deepEqual(wasm.audioSamples(), js.audioSamples());
  }
});
