import assert from 'node:assert/strict';
import test from 'node:test';
import { Apu, Nes } from '../dist/index.js';

function machine(program, nmiHandler = [0x48, 0xa9, 0xb7, 0x8d, 0, 0x40, 0x68, 0x40]) {
  const rom = new Uint8Array(16 + 0x4000);
  rom.set([78, 69, 83, 26, 1, 0]);
  rom.set(program, 16);
  rom.set(nmiHandler, 16 + 0x100); // Default: PHA; change volume; PLA; RTI.
  rom.set([0, 0x81, 0, 0x80, 0, 0x81], 16 + 0x3ffa);
  const nes = new Nes(rom); nes.reset();
  nes.write(0x4015, 1); nes.write(0x4000, 0xbf);
  nes.write(0x4002, 99); nes.write(0x4003, 8);
  return nes;
}

test('PCM and APU state do not depend on host step size during register writes, DMA, or NMI', () => {
  const program = [
    0xa9, 0xbf, 0x8d, 0, 0x40, // LDA #$bf; STA $4000.
    0xa2, 255, 0xca, 0xd0, 0xfd, // Delay using DEX/BNE.
    0xa9, 0xb3, 0x8d, 0, 0x40,
    0xa2, 255, 0xca, 0xd0, 0xfd,
    0xa9, 2, 0x8d, 0x14, 0x40, // OAM DMA.
    0x4c, 0, 0x80,
  ];
  const bulk = machine(program), single = machine(program);
  bulk.write(0x2000, 0x80); single.write(0x2000, 0x80);
  bulk.step(60000);
  while (single.cycleCount < bulk.cycleCount) single.step(1);
  assert.equal(single.cycleCount, bulk.cycleCount);
  const expected = single.audioSamples();
  assert.ok(new Set(expected).size >= 3, 'exercise multiple volume levels');
  assert.deepEqual(bulk.audioSamples(), expected);
  assert.deepEqual(bulk.apu.saveState(), single.apu.saveState());
});

test('CPU status reads observe length expiry inside a large host step', () => {
  const nes = machine([0xad, 0x15, 0x40, 0x85, 0x10, 0x4c, 0, 0x80]); // Poll $4015 into RAM.
  nes.write(0x4000, 0x1f); nes.write(0x4003, 0x18); // Length 2, no halt.
  nes.step(100); assert.equal(nes.read(0x10), 1);
  nes.step(30000); assert.equal(nes.read(0x10), 0);
});

test('APU advances exactly once for instruction, DMA, and interrupt cycles', () => {
  const nes = machine([0x4c, 0, 0x80], [0xe6, 0x11, 0x40]); // NMI: INC $11; RTI.
  const reference = new Apu(); reference.loadState(nes.apu.saveState());
  nes.write(0x2000, 0x80);
  nes.write(0x4014, 2); nes.step(100); // Stop partway through DMA.
  reference.step(nes.cycleCount);
  assert.deepEqual(nes.apu.saveState(), reference.saveState());
  const before = nes.cycleCount;
  nes.step(30000); reference.step(nes.cycleCount - before);
  assert.equal(nes.read(0x11), 1);
  assert.deepEqual(nes.apu.saveState(), reference.saveState());
});
