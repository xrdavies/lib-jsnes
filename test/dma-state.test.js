import assert from 'node:assert/strict';
import test from 'node:test';
import { Nes } from '../dist/index.js';

function machine() {
  const rom = new Uint8Array(16 + 0x4000);
  rom.set([78, 69, 83, 26, 1, 0]);
  rom.set([0xe6, 0x10, 0x4c, 0, 0x80], 16); // INC $10; JMP $8000.
  rom.set([0, 0x80], 16 + 0x3ffc);
  const nes = new Nes(rom); nes.reset();
  return nes;
}

for (const parity of [0, 1]) test(`snapshot retains remaining OAM DMA cycles with CPU parity ${parity}`, () => {
  const source = machine();
  if (parity) source.step(1); // INC takes five cycles.
  source.write(0x4015, 1); source.write(0x4000, 0xbf); source.write(0x4002, 99); source.write(0x4003, 8);
  for (let i = 0; i < 256; i++) source.write(0x200 + i, i);
  source.write(0x2003, 0xfe); source.write(0x4014, 2);
  source.step(100); source.audioSamples();
  const saved = source.saveState(), pc = source.cpu.pc, value = source.read(0x10), cycles = source.cycleCount;
  const target = machine(); target.loadState(saved);
  const remaining = 514 - parity - 100;
  for (const core of [source, target]) {
    core.step(remaining);
    assert.equal(core.cpu.pc, pc);
    assert.equal(core.read(0x10), value, 'CPU must stay halted until all restored DMA cycles elapse');
    assert.equal(core.cycleCount, cycles + remaining);
    assert.equal(core.ppu.oam[0xfe], 0); assert.equal(core.ppu.oam[0], 2);
    core.step(1); // The next instruction resumes once DMA finishes.
    assert.equal(core.read(0x10), value + (parity ? 0 : 1));
    assert.equal(core.cpu.pc, parity ? 0x8000 : 0x8002);
    assert.equal(core.cycleCount, cycles + remaining + (parity ? 3 : 5));
  }
  assert.deepEqual(target.audioSamples(), source.audioSamples());
  assert.deepEqual(target.cpu.save(), source.cpu.save());
  assert.equal(Buffer.compare(target.saveState(), source.saveState()), 0);
  // Restoring into an already-running machine must also reinstate the stall.
  target.loadState(saved); target.step(remaining - 1); assert.equal(target.cpu.pc, pc);
});

test('restoring during DMA reproduces subsequent audio and frames', () => {
  const nes = machine(); nes.write(0x4014, 0); nes.step(73); nes.audioSamples();
  const snapshot = nes.saveState();
  nes.step(60000); const expected = nes.saveState(), pcm = nes.audioSamples();
  nes.reset(); nes.loadState(snapshot); nes.step(60000);
  assert.equal(Buffer.compare(nes.saveState(), expected), 0);
  assert.deepEqual(nes.audioSamples(), pcm);
});

test('DMA snapshot metadata validates before mutation and accepts offset views', () => {
  const nes = machine(); nes.write(0x4014, 0); nes.step(100);
  const state = nes.saveState();
  assert.throws(() => nes.loadState(state.subarray(0, state.length - 8)), /Invalid state size/);
  for (const invalid of [[0, 0, 1], [0, 0, 3], [1, 0, 0], [0, 0x7f, 0], [0, 0x80, 0]]) {
    const corrupt = state.slice(); corrupt.set(invalid, corrupt.length - 3);
    assert.throws(() => nes.loadState(corrupt), /Invalid DMC DMA/);
    assert.equal(Buffer.compare(nes.saveState(), state), 0);
  }
  const storage = new Uint8Array(state.length + 11); storage.set(state, 7);
  const target = machine(); target.loadState(storage.subarray(7, 7 + state.length));
  assert.equal(Buffer.compare(target.saveState(), state), 0);
});

test('a later host DMA request replaces the pending source page', () => {
  const nes = machine(); nes.write(0x200, 0x79); nes.write(0x4014, 0); nes.write(0x4014, 2);
  const target = machine(); target.loadState(nes.saveState());
  target.step(514); assert.equal(target.cpu.pc, 0x8000); assert.equal(target.cycleCount, 514);
  assert.equal(target.ppu.oam[0], 0x79);
  target.step(1); assert.equal(target.read(0x10), 1);
});
