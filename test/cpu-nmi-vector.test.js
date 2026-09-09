import assert from 'node:assert/strict';
import test from 'node:test';
import { Cpu6502, Nes } from '../dist/index.js';

test('NMI takes over BRK/IRQ through the PC push, while later edges preserve the selected vector', () => {
  for (const brk of [false, true]) for (let edge = 0; edge <= 7; edge++) {
    const memory = new Uint8Array(65536), accesses = [];
    memory.set([0x78, 0xa2], 0xfffa); memory.set([0x34, 0x91], 0xfffe);
    const tick = () => { if (cpu.busCycles === edge) cpu.nmiPending = true; };
    const cpu = new Cpu6502({
      read(a) { accesses.push(['r', a]); tick(); return memory[a]; },
      write(a, v) { accesses.push(['w', a, v]); memory[a] = v; tick(); },
    }, true);
    cpu.pc = 0x8000; cpu.p = 0x61; cpu.nmiPending = edge === 0;
    if (brk) assert.equal(cpu.step(), 7); else assert.equal(cpu.irq(), true);
    const vector = edge <= 4 ? 0xfffa : 0xfffe;
    assert.equal(cpu.pc, edge <= 4 ? 0xa278 : 0x9134, `${brk}:${edge}`);
    assert.deepEqual(accesses.slice(-2), [['r', vector], ['r', vector + 1]]);
    assert.deepEqual(accesses.filter(([kind]) => kind === 'w'),
      [['w', 0x1fd, 0x80], ['w', 0x1fc, brk ? 2 : 0], ['w', 0x1fb, brk ? 0x71 : 0x61]]);
    assert.equal(cpu.busCycles, 7); assert.equal(cpu.sp, 0xfa);
    assert.equal(cpu.nmiPending, edge > 4); assert.equal(cpu.interruptEntry, true);
  }
});

test('a late NMI waits for the first BRK-handler instruction and survives system snapshot replay', () => {
  const rom = new Uint8Array(16 + 16384); rom.set([78, 69, 83, 26, 1, 0]);
  rom.set([0, 0xea], 16); rom[16 + 0x1000] = 0x38; // BRK; padding, handler starts with SEC.
  rom.set([0, 0xa0, 0, 0x80, 0, 0x90], 16 + 0x3ffa);
  const nes = new Nes(rom); nes.reset(); nes.write(0x2000, 0x80);
  nes.ppu.step(241 * 341 - 13); // NMI arrives during the fifth BRK cycle.
  nes.step(7);
  assert.equal(nes.cpu.pc, 0x9000); assert.equal(nes.cpu.nmiPending, true);
  const saved = nes.saveState();
  let expected;
  for (let replay = 0; replay < 2; replay++) {
    if (replay) nes.loadState(saved);
    assert.equal(nes.cpu.jammed, false); assert.equal(nes.cpu.nmiPending, true);
    nes.step(1);
    assert.equal(nes.cpu.pc, 0xa000); assert.equal(nes.cycleCount, 16);
    assert.equal(nes.read(0x1f8) & 0x11, 1, 'SEC executes before NMI; the NMI stack has B clear');
    assert.equal(nes.read(0x1f9), 1, 'NMI returns after SEC');
    if (replay) assert.deepEqual(nes.saveState(), expected); else expected = nes.saveState();
  }
});

test('CPU snapshots preserve JAM and latched NMI independently in the flags byte', () => {
  const cpu = new Cpu6502({ read: () => 0, write() {} });
  for (let flags = 0; flags < 4; flags++) {
    const state = cpu.save(); state[15] = flags; cpu.load(state);
    assert.equal(cpu.jammed, !!(flags & 1)); assert.equal(cpu.nmiPending, !!(flags & 2));
    assert.deepEqual(cpu.save(), state);
  }
  cpu.reset(); assert.equal(cpu.nmiPending, false);
});
