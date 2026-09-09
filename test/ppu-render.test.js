import assert from 'node:assert/strict';
import test from 'node:test';
import { Nes, NES_PALETTE } from '../dist/index.js';

function scene() {
  const bytes = new Uint8Array(16 + 0x4000);
  bytes.set([78, 69, 83, 26, 1, 0]);
  const nes = new Nes(bytes);
  nes.reset();
  nes.ppu.oam.fill(255);
  // Solid color-1 sprite tile, transparent background tile 0.
  for (let y = 0; y < 8; y++) nes.cartridge.writeChr(16 + y, 255);
  nes.ppu.palette[0] = 0x16;
  nes.ppu.palette[1] = 0x0f;
  nes.ppu.palette[17] = 0x2a;
  nes.ppu.palette[21] = 0x12;
  return nes;
}
function sprite(nes, id, x, y, tile = 1, attr = 0) {
  nes.ppu.oam.set([y - 1, tile, attr, x], id * 4);
}
function render(nes, mask = 0x1e) {
  nes.ppu.writeRegister(1, mask);
  nes.ppu.step(262 * 341);
}
const rgb = index => (0xff000000 | NES_PALETTE[index]) >>> 0;
const pixel = (nes, x, y) => nes.frame[y * 256 + x];

test('lower OAM index wins before the background priority bit is applied', () => {
  const nes = scene();
  sprite(nes, 0, 20, 20, 1, 0x20);
  sprite(nes, 1, 20, 20, 1, 1);
  render(nes);
  assert.equal(pixel(nes, 20, 20), rgb(0x2a), 'transparent colored background cannot occlude');
  for (let y = 0; y < 8; y++) nes.cartridge.writeChr(y, 255);
  render(nes);
  assert.equal(pixel(nes, 20, 20), rgb(0x0f), 'opaque black background hides first sprite and blocks later sprites');
  nes.ppu.oam[2] = 0;
  render(nes);
  assert.equal(pixel(nes, 20, 20), rgb(0x2a));
});

test('eight transparent in-range sprites exclude the ninth sprite from rendering', () => {
  const nes = scene();
  for (let i = 0; i < 8; i++) sprite(nes, i, 20, 20, 0);
  sprite(nes, 8, 20, 20);
  render(nes);
  assert.equal(pixel(nes, 20, 20), rgb(0x16));
  assert.equal(nes.ppu.readRegister(2) & 0x20, 0x20);
  nes.ppu.oam[0] = 255;
  render(nes);
  assert.equal(pixel(nes, 20, 20), rgb(0x2a));
  assert.equal(nes.ppu.readRegister(2) & 0x20, 0);
});

test('sprite zero hit excludes x=255 and respects each left-column mask', () => {
  const nes = scene();
  for (let y = 0; y < 8; y++) nes.cartridge.writeChr(y, 255);
  sprite(nes, 0, 255, 20);
  render(nes);
  assert.equal(nes.ppu.readRegister(2) & 0x40, 0);
  sprite(nes, 0, 254, 20);
  render(nes);
  assert.equal(nes.ppu.readRegister(2) & 0x40, 0x40);
  assert.equal(nes.ppu.readRegister(2) & 0x40, 0x40);
  sprite(nes, 0, 0, 20);
  for (const mask of [0x18, 0x1a, 0x1c, 0x08, 0x10]) {
    render(nes, mask);
    assert.equal(nes.ppu.readRegister(2) & 0x40, 0);
  }
  render(nes);
  assert.equal(nes.ppu.readRegister(2) & 0x40, 0x40);
});

test('8x16 sprites select the tile low-bit table and flip the entire height', () => {
  const nes = scene();
  nes.ppu.writeRegister(0, 0x20);
  // Tile 3 chooses table $1000 and the pair 2/3, independent of PPUCTRL bit 3.
  for (let y = 0; y < 8; y++) {
    nes.cartridge.writeChr(0x1020 + y, 0x80);
    nes.cartridge.writeChr(0x1038 + y, 0x80);
  }
  nes.ppu.palette[18] = 0x30;
  sprite(nes, 0, 20, 20, 3);
  render(nes, 0x14);
  assert.equal(pixel(nes, 20, 20), rgb(0x2a));
  assert.equal(pixel(nes, 20, 28), rgb(0x30));
  nes.ppu.oam[2] = 0xc0;
  render(nes, 0x14);
  assert.equal(pixel(nes, 27, 20), rgb(0x30));
  assert.equal(pixel(nes, 27, 28), rgb(0x2a));
});

test('transparent, disabled, and left-clipped backgrounds use the universal backdrop', () => {
  const nes = scene();
  nes.ppu.vram[0x23c0] = 3; // Palette 3 in the top-left quadrant.
  nes.ppu.palette[12] = 0x30;
  render(nes, 0x0a);
  assert.equal(pixel(nes, 0, 0), rgb(0x16));
  for (let y = 0; y < 8; y++) nes.cartridge.writeChr(y, 255);
  nes.ppu.palette[13] = 0x2a;
  render(nes, 0x08);
  assert.equal(pixel(nes, 7, 0), rgb(0x16));
  assert.equal(pixel(nes, 8, 0), rgb(0x2a));
  render(nes, 0x0a);
  assert.equal(pixel(nes, 7, 0), rgb(0x2a));
  render(nes, 0);
  assert.ok(nes.frame.every(value => value === rgb(0x16)));
});

test('horizontal and vertical nametable crossings toggle independent base bits', () => {
  const bytes = new Uint8Array(16 + 0x4000);
  bytes.set([78, 69, 83, 26, 1, 0, 8]); // Four-screen mapping keeps all tables distinct.
  const nes = new Nes(bytes);
  nes.reset();
  const colors = [0x16, 0x21, 0x2a, 0x30];
  for (let id = 0; id < 4; id++) {
    for (let row = 0; row < 8; row++) {
      nes.cartridge.writeChr(id * 16 + row, id & 1 ? 255 : 0);
      nes.cartridge.writeChr(id * 16 + row + 8, id & 2 ? 255 : 0);
    }
    nes.ppu.vram.fill(id, 0x2000 + id * 0x400, 0x2000 + id * 0x400 + 960);
    nes.ppu.palette[id] = colors[id];
  }
  for (let base = 0; base < 4; base++) {
    nes.ppu.writeRegister(0, base);
    nes.ppu.readRegister(2);
    nes.ppu.writeRegister(5, 255);
    nes.ppu.writeRegister(5, 239);
    render(nes, 0x0a);
    assert.equal(pixel(nes, 0, 0), rgb(colors[base]));
    assert.equal(pixel(nes, 1, 0), rgb(colors[base ^ 1]));
    assert.equal(pixel(nes, 0, 1), rgb(colors[base ^ 2]));
    assert.equal(pixel(nes, 1, 1), rgb(colors[base ^ 3]));
  }
});
