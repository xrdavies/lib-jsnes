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
  // Inspect the completed visible frame during VBlank, before pre-render clears flags.
  const position = nes.ppu.scanline * 341 + nes.ppu.dot;
  const untilVblank = (241 * 341 + 1 - position + 262 * 341) % (262 * 341);
  nes.ppu.step(untilVblank || 262 * 341);
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

test('sprite zero hits at the first opaque overlap dot, including flips and snapshot replay', () => {
  for (const tall of [false, true]) for (const flip of [false, true]) {
    const nes = scene();
    // Only background column 5 is opaque. An earlier sprite pixel alone must
    // not trigger the flag; flipping maps sprite column 2 onto column 5.
    nes.cartridge.writeChr(4, 0x04);
    for (let y = 0; y < 8; y++) nes.cartridge.writeChr(16 + y, 0);
    const row = flip ? (tall ? 15 : 7) : 0;
    const base = tall ? 0x1020 + (row >>> 3) * 16 : 16;
    nes.cartridge.writeChr(base + (row & 7) + 8, flip ? 0x20 : 0x24);
    sprite(nes, 0, 16, 20, tall ? 3 : 1, 0x20 | (flip ? 0xc0 : 0));
    nes.ppu.writeRegister(0, tall ? 0x20 : 0);
    nes.ppu.writeRegister(1, 0x1e);
    const initial = nes.saveState();
    nes.ppu.step(20 * 341 + 21);
    assert.equal(nes.ppu.readRegister(2) & 0x40, 0);
    const before = nes.saveState();
    nes.ppu.step(1);
    assert.equal(nes.ppu.readRegister(2) & 0x40, 0x40);
    const after = nes.saveState();
    nes.loadState(initial);
    for (let dot = 0; dot < 20 * 341 + 22; dot++) nes.ppu.step(1);
    assert.equal(nes.ppu.readRegister(2) & 0x40, 0x40);
    assert.deepEqual(nes.saveState(), after, 'batched and single-dot stepping agree');
    nes.loadState(before);
    nes.ppu.step(1);
    assert.equal(nes.ppu.readRegister(2) & 0x40, 0x40);
    assert.deepEqual(nes.saveState(), after);
    nes.loadState(after);
    nes.ppu.writeRegister(1, 0);
    assert.equal(nes.ppu.readRegister(2) & 0x40, 0x40, 'hit stays latched when rendering stops');
  }
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

test('background tile-row reuse preserves fine scrolling, clipping, and nametable crossings', () => {
  const image = new Uint8Array(16 + 0x4000); image.set([78, 69, 83, 26, 1, 0, 8]);
  const nes = new Nes(image); nes.reset();
  nes.ppu.palette.set([0x0f, 0x11, 0x22, 0x33]);
  for (let tile = 0; tile < 4; tile++) {
    nes.ppu.vram.fill(tile, 0x2000 + tile * 0x400, 0x23c0 + tile * 0x400);
    for (let row = 0; row < 8; row++) {
      let lo = 0, hi = 0;
      for (let col = 0; col < 8; col++) {
        const color = (tile + row + col) % 4;
        lo |= (color & 1) << (7 - col); hi |= (color >>> 1) << (7 - col);
      }
      nes.cartridge.writeChr(tile * 16 + row, lo); nes.cartridge.writeChr(tile * 16 + row + 8, hi);
    }
  }
  let reads = 0;
  const readChr = nes.cartridge.readChr.bind(nes.cartridge);
  nes.cartridge.readChr = a => { reads++; return readChr(a); };
  for (const scroll of [0, 1, 2, 3, 4, 5, 6, 7, 252, 255]) for (const clip of [false, true]) {
    nes.ppu.writeRegister(5, scroll); nes.ppu.writeRegister(5, 239);
    reads = 0; render(nes, clip ? 8 : 10);
    assert.ok(reads <= 2 * 33 * 240, 'pattern data should be fetched once per tile row');
    for (let y = 0; y < 240; y++) for (let x = 0; x < 256; x++) {
      const wx = x + scroll, wy = y + 239, nt = (wx >= 256 ? 1 : 0) + (wy >= 240 ? 2 : 0);
      const color = clip && x < 8 ? 0 : (nt + ((wy % 240) % 8) + (wx % 8)) % 4;
      assert.equal(pixel(nes, x, y), rgb([0x0f, 0x11, 0x22, 0x33][color]));
      assert.equal(nes.ppu.backgroundOpaque[y * 256 + x], color ? 1 : 0);
    }
  }
});
