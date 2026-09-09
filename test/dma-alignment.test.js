import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Cpu6502, Nes, WasmCore } from '../dist/index.js';

test('CPU write phase reflects the actual last bus cycle, including high cumulative cycle counts', () => {
  for (const opcode of [0x8d, 0x9d, 0xee, 0xfe]) for (const start of [0, 1, 2 ** 32, 2 ** 32 + 1]) {
    const memory = new Uint8Array(65536), events = [];
    memory.set([opcode, 0, 2], 0x8000);
    const cpu = new Cpu6502({ read: a => memory[a], write(a, v, consecutive, odd) {
      events.push({ consecutive, odd }); memory[a] = v;
    } }); cpu.pc = 0x8000; cpu.cycles = start;
    const used = cpu.step();
    assert.equal(events.at(-1).odd, (start + used) % 2 === 1);
    if (opcode === 0xee || opcode === 0xfe) {
      assert.equal(events[0].odd, (start + used - 1) % 2 === 1);
      assert.deepEqual(events.map(e => e.consecutive), [false, true]);
    }
  }
});

test('CPU-requested OAM DMA uses write-cycle parity for every relevant store mode', async () => {
  const binary = await readFile(new URL('../dist-wasm/lib-jsnes.wasm', import.meta.url));
  for (const [opcode, duration] of [[0x8d, 4], [0x9d, 5], [0x99, 5], [0x91, 6], [0xee, 6], [0xfe, 7]]) {
    for (const offset of [0, 3]) {
      const prefix = [0xa9, 0x14, 0x85, 0x20, 0xa9, 0x40, 0x85, 0x21, 0xa9, 2]; // 12 cycles.
      if (offset) prefix.push(0x24, 0); // BIT zero page adds three cycles.
      const instruction = opcode === 0x91 ? [opcode, 0x20] : [opcode, 0x14, 0x40];
      const code = [...prefix, ...instruction, 0xe6, 0x10];
      const rom = new Uint8Array(16 + 16384); rom.set([78, 69, 83, 26, 1, 0]);
      rom.set(code, 16); rom.set([0, 0x80], 16 + 16384 - 4);
      const js = new Nes(rom), wasm = await WasmCore.from(binary);
      js.reset(); wasm.loadRom(rom); wasm.reset();
      js.step(12 + offset); wasm.step(12 + offset);
      js.step(1); wasm.step(1);
      const before = 12 + offset + duration, pc = 0x8000 + prefix.length + instruction.length;
      assert.equal(js.cycleCount, before); assert.equal(wasm.cycleCount, before);
      const stall = before % 2 ? 513 : 514;
      const saved = js.saveState();
      js.step(stall - 1); wasm.step(stall - 1);
      assert.equal(js.cpu.pc, pc); assert.equal(wasm.programCounter, pc);
      js.step(1); wasm.step(1);
      assert.equal(js.cpu.pc, pc); assert.equal(wasm.programCounter, pc);
      assert.equal(js.cycleCount, before + stall); assert.equal(wasm.cycleCount, before + stall);
      js.step(1); wasm.step(1);
      assert.equal(js.read(0x10), 1); assert.equal(wasm.exports.ramRead(0x10), 1);
      assert.equal(js.cycleCount, before + stall + 5); assert.equal(wasm.cycleCount, before + stall + 5);
      const final = js.saveState(); js.loadState(saved); js.step(stall); js.step(1);
      assert.deepEqual(js.saveState(), final);
    }
  }
});

test('DMA stalls inside an operand read update the following CPU write parity', () => {
  for (const start of [0, 1, 2 ** 32]) for (const stalls of [3, 4]) {
    const memory = new Uint8Array(65536); memory.set([0x8d, 0, 2], 0x8000);
    let writeOdd;
    const cpu = new Cpu6502({ read(a) {
      if (a === 0x8001) for (let i = 0; i < stalls; i++) cpu.stallCycle();
      return memory[a];
    }, write(a, v, consecutive, odd) { writeOdd = odd; } });
    cpu.pc = 0x8000; cpu.cycles = start;
    assert.equal(cpu.step(), 4); assert.equal(cpu.busCycles, 4);
    assert.equal(cpu.cycles, start + stalls + 4);
    assert.equal(writeOdd, cpu.cycles % 2 === 1);
  }
});
