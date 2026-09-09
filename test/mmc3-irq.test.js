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
function ppuAddress(ppu, address) {
  ppu.readRegister(2); ppu.writeRegister(6, address >>> 8); ppu.writeRegister(6, address & 255);
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
  const state = nes.cartridge.saveState();
  for (const [index, value] of [[25, 8], [22, 4]]) {
    const corrupt = state.slice(); corrupt[index] = value;
    assert.throws(() => nes.cartridge.loadState(corrupt), /Invalid cartridge state/);
    assert.deepEqual(nes.cartridge.saveState(), state);
  }
});

test('PPU clocks MMC3 on filtered A12 rises, for either enabled layer', () => {
  const nes = machine();
  for (const mask of [0, 8, 16, 24]) for (let line = 0; line < 262; line++) {
    nes.ppu.reset(); nes.ppu.scanline = line; nes.write(0x2000, 0x10); nes.write(0x2001, mask);
    nes.write(0xe000, 0); nes.write(0xc000, 0); nes.write(0xc001, 0); nes.write(0xe001, 0);
    nes.ppu.step(4);
    assert.equal(nes.cartridge.irqPending, false, `${mask}:${line} early edge`);
    nes.ppu.step(1);
    assert.equal(nes.cartridge.irqPending, !!mask && (line < 240 || line === 261), `${mask}:${line}`);
  }
});

test('PPUDATA pattern reads and writes clock the MMC3 A12 filter', () => {
  const nes = machine();
  nes.write(0xc000, 0); nes.write(0xc001, 0); nes.write(0xe001, 0);
  nes.ppu.step(4); // Establish the required low period while rendering is off.
  ppuAddress(nes.ppu, 0x1000); nes.ppu.readRegister(7);
  assert.equal(nes.cartridge.irqPending, true, 'pattern reads must expose A12');
  nes.write(0xe000, 0); nes.write(0xe001, 0); nes.ppu.step(3);
  ppuAddress(nes.ppu, 0x0000); nes.ppu.writeRegister(7, 0x5a);
  nes.ppu.step(3); ppuAddress(nes.ppu, 0x1000); nes.ppu.writeRegister(7, 0xa5);
  assert.equal(nes.cartridge.irqPending, true, 'pattern writes must expose A12');
});

test('batched PPU steps and snapshot replay preserve the qualified MMC3 count', () => {
  const batch = machine(), single = machine();
  for (const nes of [batch, single]) {
    nes.write(0x2000, 0x10); nes.write(0x2001, 0x18); nes.write(0xc000, 250); nes.write(0xc001, 0);
  }
  batch.ppu.step(262 * 341);
  for (let i = 0; i < 262 * 341; i++) single.ppu.step(1);
  assert.deepEqual(batch.cartridge.saveState(), single.cartridge.saveState());
  batch.ppu.step(279);
  const saved = batch.saveState();
  batch.ppu.step(1); const expected = batch.cartridge.saveState();
  batch.loadState(saved); batch.ppu.step(1);
  assert.deepEqual(batch.cartridge.saveState(), expected);
  batch.write(0x2001, 0); batch.ppu.step(341 * 5);
  assert.deepEqual(batch.cartridge.saveState(), expected, 'disabled rendering keeps the counter phase');
  batch.write(0x2001, 8); batch.ppu.step(341);
  assert.ok(batch.cartridge.saveState()[20] < expected[20], 'filtered A12 rises advance the counter');
});

test('MMC3 asserts during DMA before the CPU resumes, including after snapshot restoration', () => {
  const nes = machine(); nes.write(0x2000, 0x18); nes.write(0x2001, 8);
  nes.write(0xc000, 0); nes.write(0xe001, 0);
  nes.ppu.step(270); nes.write(0xe000, 0); nes.write(0xe001, 0); nes.write(0x4014, 2);
  const saved = nes.saveState(), restored = machine(); restored.loadState(saved);
  for (const core of [nes, restored]) {
    core.step(2); assert.equal(core.cartridge.irqPending, false);
    core.step(1); assert.equal(core.cartridge.irqPending, true);
    assert.equal(core.cpu.pc, 0x8000, 'CPU remains stalled');
    assert.equal(core.cycleCount, 3);
  }
  assert.deepEqual(nes.saveState(), restored.saveState());
});
