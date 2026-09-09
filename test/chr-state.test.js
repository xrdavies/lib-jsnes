import assert from 'node:assert/strict';
import test from 'node:test';
import { Nes, Cartridge } from '../dist/index.js';

function machine(mapper, chrRom = false) {
  const rom = new Uint8Array(16 + 0x8000 + (chrRom ? 0x2000 : 0));
  rom.set([78, 69, 83, 26, 2, +chrRom, mapper << 4]);
  rom.set([0x4c, 0, 0x80], 16); rom.set([0, 0x80], 16 + 0x7ffc);
  const nes = new Nes(rom); nes.reset(); return nes;
}
function serial(nes, address, value) {
  for (let bit = 0; bit < 5; bit++) nes.write(address, (value >>> bit) & 1);
}
function mapping(nes, swapped = false) {
  if (nes.rom.mapper === 1) {
    serial(nes, 0x8000, 0x1c); serial(nes, 0xa000, swapped ? 1 : 0); serial(nes, 0xc000, swapped ? 0 : 1);
  }
  if (nes.rom.mapper === 4) {
    for (const [i, bank] of [0, 2, 4, 5, 6, 7].entries()) {
      nes.write(0x8000, i | (swapped ? 0x80 : 0)); nes.write(0x8001, bank);
    }
  }
}
function address(nes, value) {
  nes.ppu.step(6); // Allow the preceding PPUDATA read to recover.

  nes.read(0x2002); nes.write(0x2006, value >>> 8); nes.write(0x2006, value & 255);
}
function fill(nes, data) {
  address(nes, 0);
  for (const byte of data) nes.write(0x2007, byte);
}
function read(nes) {
  address(nes, 0); nes.read(0x2007);
  return Uint8Array.from({ length: 8192 }, () => { nes.ppu.step(6); return nes.read(0x2007); });
}

for (const mapper of [0, 1, 2, 4, 7]) test(`mapper ${mapper} snapshots restore all CHR RAM through PPU reads`, () => {
  const nes = machine(mapper); mapping(nes);
  const data = Uint8Array.from({ length: 8192 }, (_, i) => ((i >>> 8) * 17 + i) & 255);
  fill(nes, data); nes.write(0x6000, 0x5a); nes.write(0x7fff, 0xa5);
  mapping(nes, true);
  const expected = read(nes), snapshot = nes.saveState();
  fill(nes, new Uint8Array(8192)); mapping(nes);
  nes.write(0x6000, 0); nes.write(0x7fff, 0);
  for (const target of [nes, machine(mapper)]) {
    target.loadState(snapshot);
    assert.deepEqual(read(target), expected);
    assert.equal(target.read(0x6000), 0x5a); assert.equal(target.read(0x7fff), 0xa5);
    mapping(target); assert.deepEqual(read(target), data);
  }
});

test('restored CHR RAM redraws the saved picture on subsequent frames', () => {
  const nes = machine(2);
  fill(nes, Uint8Array.from({ length: 16 }, (_, i) => i < 8 ? 255 : 0));
  nes.ppu.palette.set([0x0f, 0x2a]); nes.write(0x2001, 10);
  nes.runFrame(); nes.runFrame();
  const expected = nes.frame.slice(), snapshot = nes.saveState();
  fill(nes, new Uint8Array(16)); nes.runFrame(); nes.runFrame();
  assert.notDeepEqual(nes.frame, expected);
  nes.loadState(snapshot); nes.runFrame(); nes.runFrame();
  assert.deepEqual(nes.frame, expected, 'must redraw from restored tiles, not merely the saved framebuffer');
});

test('cartridge snapshot views preserve PRG/CHR boundaries and reject missing CHR before mutation', () => {
  const nes = machine(2), cart = nes.cartridge;
  cart.prgRam.fill(0x33); cart.writeChr(0, 0x44); cart.writeChr(8191, 0x55);
  const saved = cart.saveState();
  assert.equal(saved.length, Cartridge.STATE_SIZE + 8192);
  assert.equal(saved.length, cart.stateSize);
  cart.writeChr(0, 0x66); cart.prgRam.fill(0x77);
  assert.equal(saved[Cartridge.STATE_SIZE], 0x44, 'snapshot owns the pattern bytes');
  const before = cart.saveState();
  assert.throws(() => cart.loadState(saved.subarray(0, Cartridge.STATE_SIZE)), /cartridge state/);
  assert.deepEqual(cart.saveState(), before);
  const storage = new Uint8Array(saved.length + 7); storage.set(saved, 3);
  cart.loadState(storage.subarray(3, 3 + saved.length));
  assert.equal(cart.prgRam[0], 0x33); assert.equal(cart.prgRam[8191], 0x33);
  assert.equal(cart.readChr(0), 0x44); assert.equal(cart.readChr(8191), 0x55);
  storage.fill(0); assert.equal(cart.readChr(0), 0x44, 'restored memory does not alias input');
});

test('CHR ROM snapshots retain their existing size and never include immutable pattern bytes', () => {
  const nes = machine(0, true), cart = nes.cartridge;
  assert.equal(cart.stateSize, Cartridge.STATE_SIZE);
  const saved = cart.saveState(); cart.prgRam[0] = 0x5a; cart.loadState(saved);
  assert.equal(cart.prgRam[0], 0); assert.equal(cart.readChr(0), 0);
  assert.equal(saved.length, Cartridge.STATE_SIZE);
});
