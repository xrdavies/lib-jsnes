import assert from 'node:assert/strict';
import test from 'node:test';
import { Nes } from '../dist/index.js';

function machine() {
  const rom = new Uint8Array(16 + 0x8000);
  rom.set([78, 69, 83, 26, 2, 0, 0x40]);
  rom.set([0xea, 0x4c, 0, 0x80], 16); // NOP; JMP $8000.
  rom.set([0xe6, 0x10, 0x8d, 0, 0xe0, 0x40], 16 + 0x6100); // IRQ: count, acknowledge, RTI.
  rom.set([0xe6, 0x11, 0x8d, 0, 0xe0, 0x40], 16 + 0x6200); // NMI: count, acknowledge IRQ, RTI.
  rom.set([0, 0xe2, 0, 0x80, 0, 0xe1], 16 + 0x7ffa);
  const nes = new Nes(rom); nes.reset(); nes.write(0x4017, 0x40); // Inhibit APU IRQ.
  return nes;
}
function pending(nes) {
  nes.write(0xc000, 1); nes.write(0xc001, 0); nes.write(0xe001, 0);
  nes.cartridge.clockScanline(); nes.cartridge.clockScanline();
}

test('MMC3 counter runs with interrupts disabled and enable preserves its phase', () => {
  const nes = machine(); nes.write(0xc000, 2); nes.write(0xc001, 0);
  assert.equal(nes.cartridge.clockScanline(), false); // Load 2 while disabled.
  assert.equal(nes.cartridge.clockScanline(), false); // 2 -> 1.
  nes.write(0xe001, 0);
  assert.equal(nes.cartridge.clockScanline(), true); // 1 -> 0, no restart on enable.
});

test('MMC3 IRQ remains asserted across counter reloads until $e000 acknowledges it', () => {
  const nes = machine(); pending(nes);
  assert.equal(nes.cartridge.irqPending, true);
  nes.write(0xc000, 5); nes.write(0xc001, 0);
  assert.equal(nes.cartridge.clockScanline(), true);
  assert.equal(nes.cartridge.irqPending, true);
  nes.write(0xe000, 0);
  assert.equal(nes.cartridge.irqPending, false);
  assert.equal(nes.cartridge.clockScanline(), false);
});

test('MMC3 snapshot preserves pending IRQ and disabled counter phase', () => {
  const nes = machine(); pending(nes);
  const saved = nes.saveState(); nes.write(0xe000, 0); nes.loadState(saved);
  assert.equal(nes.cartridge.irqPending, true);
  const other = machine(); other.loadState(saved);
  assert.equal(other.cartridge.irqPending, true);
  other.write(0xe000, 0); other.write(0xc000, 3); other.write(0xc001, 0);
  other.cartridge.clockScanline(); other.cartridge.clockScanline(); // Counter 2.
  const phase = other.saveState(); nes.loadState(phase); nes.write(0xe001, 0);
  assert.equal(nes.cartridge.clockScanline(), false);
  assert.equal(nes.cartridge.clockScanline(), true);
});

test('CPU masking does not lose MMC3 IRQs between scanline clocks', () => {
  const nes = machine(); pending(nes);
  nes.step(10); assert.equal(nes.read(0x10), 0); // I still set.
  nes.cpu.p &= ~4; nes.step(50);
  assert.equal(nes.read(0x10), 1);
  assert.equal(nes.cartridge.irqPending, false);
  assert.equal(nes.cpu.sp, 0xfd);
  nes.step(10); assert.equal(nes.read(0x10), 1);
});

test('NMI takes priority over a simultaneously pending mapper IRQ', () => {
  const nes = machine(); pending(nes); nes.cpu.p &= ~4;
  nes.ppu.step(241 * 341 + 1); nes.write(0x2000, 0x80);
  nes.step(50);
  assert.equal(nes.read(0x11), 1);
  assert.equal(nes.read(0x10), 0, 'NMI acknowledged mapper IRQ before it could run');
  assert.equal(nes.cpu.sp, 0xfd);
});

test('MMC3 reload waits for a clock and CPU interrupt entry does not acknowledge the source', () => {
  const nes = machine(); nes.write(0xc000, 0); nes.write(0xc001, 0); nes.write(0xe001, 0);
  assert.equal(nes.cartridge.irqPending, false);
  assert.equal(nes.cartridge.clockScanline(), true);
  nes.cpu.p &= ~4;
  nes.step(1); // Execute NOP and enter IRQ; handler has not acknowledged yet.
  assert.equal(nes.cpu.pc, 0xe100);
  assert.equal(nes.cartridge.irqPending, true);
  nes.read(0x4015); assert.equal(nes.cartridge.irqPending, true, 'APU status cannot clear mapper IRQ');
  nes.step(20); assert.equal(nes.read(0x10), 1); assert.equal(nes.cartridge.irqPending, false);
  pending(nes); nes.reset(); assert.equal(nes.cartridge.irqPending, false);
});

test('corrupt pending IRQ snapshot flag is rejected before changing the cartridge', () => {
  const nes = machine(); pending(nes);
  const state = nes.cartridge.saveState(), corrupt = state.slice(); corrupt[25] = 8;
  assert.throws(() => nes.cartridge.loadState(corrupt), /Invalid cartridge state/);
  assert.deepEqual(nes.cartridge.saveState(), state);
});
