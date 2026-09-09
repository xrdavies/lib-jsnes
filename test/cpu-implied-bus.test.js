import assert from 'node:assert/strict';
import test from 'node:test';
import { Cpu6502, Nes } from '../dist/index.js';

const opcodes = 'ea 1a 3a 5a 7a da fa e8 ca c8 88 aa ba 9a 8a a8 98 18 38 58 78 b8 d8 f8 0a 4a 2a 6a'
  .split(' ').map(value => parseInt(value, 16));

test('two-cycle implied and accumulator instructions discard the next-byte read without consuming it', () => {
  for (const opcode of opcodes) for (const pc of [0x8000, 0xffff]) {
    let expected;
    for (const discarded of [0, 0xff]) {
      const reads = [];
      const cpu = new Cpu6502({
        read(address) { reads.push(address); return address === pc ? opcode : discarded; },
        write() { assert.fail('unexpected write'); },
      }, true);
      cpu.pc = pc; cpu.a = 0x81; cpu.x = 0xff; cpu.y = 1; cpu.p = 0xe5;
      assert.equal(cpu.step(), 2);
      assert.deepEqual(reads, [pc, (pc + 1) & 65535], `opcode ${opcode.toString(16)}`);
      assert.equal(cpu.pc, (pc + 1) & 65535);
      const state = cpu.save();
      if (expected) assert.deepEqual(state, expected, 'discarded data must not affect the instruction');
      expected = state;
    }
  }
});

test('discarded implied reads reach PPUSTATUS before the instruction changes flags', () => {
  const rom = new Uint8Array(16 + 16384); rom.set([78, 69, 83, 26, 1, 0]);
  const nes = new Nes(rom); nes.reset(); nes.ppu.step(241 * 341 + 1);
  let flagsDuringRead;
  const cpu = new Cpu6502({
    read(address) {
      if (address === 0x2001) return 0x38; // SEC
      flagsDuringRead = cpu.p;
      return nes.read(address);
    },
    write() { assert.fail('unexpected write'); },
  }, true);
  cpu.pc = 0x2001;
  cpu.step();
  assert.equal(flagsDuringRead, 0x24);
  assert.equal(cpu.p, 0x25);
  assert.equal(nes.read(0x2002) & 128, 0);
});
