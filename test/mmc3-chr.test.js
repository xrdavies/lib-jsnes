import assert from 'node:assert/strict';
import test from 'node:test';
import { Nes, NES_PALETTE } from '../dist/index.js';

function machine(chrBanks = 4) {
  const rom = new Uint8Array(16 + 0x8000 + chrBanks * 0x2000);
  rom.set([78, 69, 83, 26, 2, chrBanks, 0x40]);
  for (let bank = 0; bank < chrBanks * 8; bank++) rom.fill(bank, 16 + 0x8000 + bank * 1024, 16 + 0x8000 + (bank + 1) * 1024);
  return new Nes(rom);
}
function select(nes, register, bank, mode = 0) {
  nes.write(0x8000, mode | register); nes.write(0x8001, bank);
}
function address(nes, value) {
  nes.read(0x2002); nes.write(0x2006, value >>> 8); nes.write(0x2006, value & 255);
}
function read(nes, value) {
  address(nes, value); nes.read(0x2007); return nes.read(0x2007);
}

test('MMC3 maps every 1KB CHR slot in both inversion modes, including odd 2KB selectors', () => {
  const nes = machine();
  for (const [i, bank] of [5, 11, 17, 20, 23, 26].entries()) select(nes, i, bank);
  for (const [mode, banks] of [[0, [4, 5, 10, 11, 17, 20, 23, 26]], [0x80, [17, 20, 23, 26, 4, 5, 10, 11]]]) {
    nes.write(0x8000, mode);
    for (let slot = 0; slot < 8; slot++) for (const offset of [0, 1, 511, 1023]) {
      assert.equal(nes.cartridge.readChr(slot * 1024 + offset), banks[slot]);
      assert.equal(read(nes, slot * 1024 + offset), banks[slot]);
    }
    // PRG mode changes must leave CHR mode intact.
    nes.write(0x8000, mode | 0x40);
    assert.deepEqual(Array.from({ length: 8 }, (_, i) => read(nes, i * 1024)), banks);
  }
});

test('MMC3 applies all eight CHR register bits and mirrors absent address lines', () => {
  const nes = machine();
  for (let value = 0; value < 256; value++) {
    for (let register = 0; register < 6; register++) select(nes, register, value);
    for (const mode of [0, 0x80]) {
      nes.write(0x8000, mode);
      const pair = [(value & 0xfe) % 32, (value | 1) % 32], single = value % 32;
      const expected = mode ? [single, single, single, single, ...pair, ...pair] : [...pair, ...pair, single, single, single, single];
      assert.deepEqual(Array.from({ length: 8 }, (_, i) => nes.cartridge.readChr(i * 1024 + 1023)), expected);
    }
  }
});

test('MMC3 CHR RAM writes follow the same bank mapping as reads', () => {
  const nes = machine(0);
  select(nes, 0, 3); select(nes, 1, 5);
  for (let i = 2; i < 6; i++) select(nes, i, i + 2);
  address(nes, 0x400); nes.write(0x2007, 0x5a); // Odd half of R0: physical bank 3.
  select(nes, 2, 3);
  assert.equal(read(nes, 0x1000), 0x5a);
  nes.write(0x8000, 0x80);
  assert.equal(read(nes, 0), 0x5a);
  assert.equal(read(nes, 0x1400), 0x5a);
  address(nes, 0); nes.write(0x2007, 0xa5);
  assert.equal(read(nes, 0x1400), 0xa5);
});

test('MMC3 restores CHR selectors and inversion after a snapshot', () => {
  const nes = machine();
  for (const [i, bank] of [5, 11, 17, 20, 23, 26].entries()) select(nes, i, bank, 0x80);
  const saved = nes.saveState();
  nes.reset(); select(nes, 0, 0); nes.loadState(saved);
  assert.deepEqual(Array.from({ length: 8 }, (_, i) => read(nes, i * 1024)), [17, 20, 23, 26, 4, 5, 10, 11]);
});

test('MMC3 inversion changes rendered tile data and preserves CHR ROM', () => {
  const rom = new Uint8Array(16 + 0x8000 + 0x2000);
  rom.set([78, 69, 83, 26, 2, 1, 0x40]);
  const start = 16 + 0x8000;
  rom.fill(255, start + 1024, start + 1024 + 8); // Bank 1: color 1.
  rom.fill(255, start + 4096 + 8, start + 4096 + 16); // Bank 4: color 2.
  const nes = new Nes(rom);
  select(nes, 0, 0); select(nes, 2, 4);
  nes.ppu.palette.set([0x0f, 0x2a, 0x16]); nes.ppu.writeRegister(1, 10);
  nes.ppu.vram.fill(64, 0x2000, 0x23c0); // Tile 64 starts at $0400 (R0 odd half).
  nes.ppu.step(262 * 341);
  assert.equal(nes.frame[8], (0xff000000 | NES_PALETTE[0x2a]) >>> 0);
  nes.ppu.vram.fill(0, 0x2000, 0x23c0); nes.write(0x8000, 0x80);
  address(nes, 8); nes.write(0x2007, 0); // Must not modify CHR ROM.
  nes.ppu.step(262 * 341);
  assert.equal(nes.frame[8], (0xff000000 | NES_PALETTE[0x16]) >>> 0);
});
