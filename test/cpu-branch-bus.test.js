import assert from 'node:assert/strict';
import test from 'node:test';
import { Cpu6502, Nes } from '../dist/index.js';

test('all branch opcodes read the discarded fetch and provisional address only when required', () => {
  const cases = [
    [0x8000, 0, 0x8002, [0x8002]],
    [0x80fd, 1, 0x8100, [0x80ff, 0x8000]],
    [0x8100, 0x80, 0x8082, [0x8102, 0x8182]],
    [0xfffd, 1, 0, [0xffff, 0xff00]],
    [0xffff, 0x80, 0xff81, [1, 0x81]],
  ];
  for (const [opcode, flag, set] of [[0x10, 128, false], [0x30, 128, true],
    [0x50, 64, false], [0x70, 64, true], [0x90, 1, false], [0xb0, 1, true],
    [0xd0, 2, false], [0xf0, 2, true]]) {
    for (const [start, operand, target, extra] of cases) for (const taken of [false, true]) {
      const memory = new Uint8Array(65536), reads = [];
      memory[start] = opcode; memory[(start + 1) & 65535] = operand;
      const cpu = new Cpu6502({ read(a) { reads.push(a); return memory[a]; },
        write() { assert.fail('branch must not write'); } }, true);
      cpu.pc = start; cpu.a = 0x43; cpu.x = 0x21; cpu.y = 0x87;
      cpu.p = 0x24 | (taken === set ? flag : 0);
      // Flags already set in the baseline must be cleared for a clear condition.
      if (taken !== set) cpu.p &= ~flag;
      const flags = cpu.p;
      assert.equal(cpu.step(), taken ? 2 + extra.length : 2);
      assert.deepEqual(reads, [start, (start + 1) & 65535, ...(taken ? extra : [])]);
      assert.equal(cpu.pc, taken ? target : (start + 2) & 65535);
      assert.deepEqual([cpu.a, cpu.x, cpu.y, cpu.p, cpu.sp], [0x43, 0x21, 0x87, flags, 0xfd]);
    }
  }
});

test('branch discarded reads preserve mapped-device side effects without changing flags', () => {
  const rom = new Uint8Array(16 + 16384); rom.set([78, 69, 83, 26, 1, 0]);
  const nes = new Nes(rom); nes.reset(); nes.write(0x2000, 0x80);
  nes.ppu.step(241 * 341 + 1);
  // A tracing CPU bus supplies the two instruction bytes, forwarding the dummy
  // access to the real PPUSTATUS port. Its returned byte must be discarded.
  const cpu = new Cpu6502({ read(a) { return a === 0x2000 ? 0xd0 : a === 0x2001 ? 0 : nes.read(a); },
    write() { assert.fail('branch must not write'); } }, true);
  cpu.pc = 0x2000;
  assert.equal(cpu.step(), 3);
  assert.equal(cpu.p, 0x24);
  assert.equal(nes.ppu.consumeNmi(), false, 'discarded read acknowledges pending NMI');
  assert.equal(nes.read(0x2002) & 128, 0, 'discarded read clears VBlank');
});
