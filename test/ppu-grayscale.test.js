import assert from 'node:assert/strict';
import test from 'node:test';
import { Nes, NES_PALETTE } from '../dist/index.js';
function scene() {
  const rom = new Uint8Array(16 + 0x4000); rom.set([78, 69, 83, 26, 1, 0]);
  const nes = new Nes(rom); nes.reset(); return nes;
}
function address(nes, value) {
  nes.read(0x2002); nes.write(0x2006, value >>> 8); nes.write(0x2006, value & 255);
}

test('PPUMASK grayscale selects the palette column for all 64 backdrop colors', () => {
  const nes = scene();
  for (let color = 0; color < 64; color++) {
    nes.ppu.palette[0] = color; nes.write(0x2001, 1); nes.ppu.step(341 * 262);
    assert.equal(nes.frame[0], (0xff000000 | NES_PALETTE[color & 0x30]) >>> 0, `palette ${color}`);
    assert.equal(nes.ppu.palette[0], color, 'grayscale must not rewrite palette memory');
  }
  nes.write(0x2001, 0); nes.ppu.step(341 * 262);
  assert.equal(nes.frame[0], (0xff000000 | NES_PALETTE[63]) >>> 0);
});

test('PPUDATA palette reads apply grayscale without corrupting stored colors or the read buffer', () => {
  const nes = scene();
  address(nes, 0x2f10); nes.write(0x2007, 0x5a);
  for (let color = 0; color < 64; color++) {
    nes.write(0x2001, 0); address(nes, 0x3f00); nes.write(0x2007, color);
    nes.write(0x2001, 1); address(nes, 0x3f10); assert.equal(nes.read(0x2007), color & 0x30);
    address(nes, 0x2000); assert.equal(nes.read(0x2007), 0x5a, 'palette read refreshes buffer from underlying nametable');
    nes.write(0x2001, 0); address(nes, 0x3f00); assert.equal(nes.read(0x2007), color);
  }
});

test('grayscale applies to both background and sprite colors and survives snapshots', () => {
  const nes = scene(); nes.ppu.oam.fill(255);
  for (let row = 0; row < 8; row++) nes.cartridge.writeChr(row, 255);
  nes.ppu.palette[1] = 0x2a; nes.ppu.palette[17] = 0x16;
  nes.ppu.oam.set([19, 0, 0, 20]); nes.write(0x2001, 0x1f);
  const state = nes.saveState();
  nes.write(0x2001, 0x1e); nes.loadState(state); nes.ppu.step(341 * 262);
  assert.equal(nes.frame[8], 0xffffffff);
  assert.equal(nes.frame[20 * 256 + 20], 0xffaaaaaa);
});
