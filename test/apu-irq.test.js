import assert from 'node:assert/strict';
import test from 'node:test';
import { Nes } from '../dist/index.js';

test('APU frame IRQ reaches the CPU and a status read clears the source', () => {
  const rom = new Uint8Array(16 + 0x4000);
  rom.set([78, 69, 83, 26, 1, 0]);
  rom.set([0x58, 0xad, 0x15, 0x40, 0x85, 0x10, 0x4c, 0, 0x80], 16); // CLI; poll $4015.
  rom.set([0xad, 0x15, 0x40, 0xe6, 0x11, 0x40, 0x40], 16 + 0x100); // IRQ: read status; INC $11; RTI.
  rom[16 + 0x3ffa] = 0; rom[16 + 0x3ffb] = 0x80;
  rom[16 + 0x3ffc] = 0; rom[16 + 0x3ffd] = 0x80;
  rom[16 + 0x3ffe] = 0; rom[16 + 0x3fff] = 0x81;
  const nes = new Nes(rom); nes.reset();
  const before = nes.read(0x11);
  nes.step(29840);
  assert.ok(nes.read(0x11) > before);
  assert.equal(nes.read(0x10) & 0x40, 0);
  assert.equal(nes.apu.irqPending, false);
  nes.step(29840);
  assert.ok(nes.read(0x11) > 0);
});
