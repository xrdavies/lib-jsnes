import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Nes, WasmCore, PPU_STATE_SIZE, NES_PALETTE } from '../dist/index.js';

function rom() {
  const bytes = new Uint8Array(16 + 16384); bytes.set([78, 69, 83, 26, 1, 0]);
  bytes.set([0x4c, 0, 0x80], 16); bytes.set([0, 0x80], 16 + 0x3ffc); return bytes;
}
function scene() {
  const nes = new Nes(rom()); nes.reset(); nes.ppu.oam.fill(255);
  nes.ppu.palette.set([0x0f]); nes.ppu.palette[17] = 0x16; nes.ppu.palette[18] = 0x2a;
  nes.write(0x2001, 0x1e); return nes;
}
const rgb = code => (0xff000000 | NES_PALETTE[code]) >>> 0;

test('eight sprite slots read low/high planes separately and retain selected OAM data', () => {
  const nes = scene(), reads = [], ppu = nes.ppu;
  ppu.oam.set([20, 3, 0, 20]); ppu.step(19 * 341 + 256);
  const read = nes.cartridge.readChr.bind(nes.cartridge);
  nes.cartridge.readChr = a => { reads.push([ppu.dot, a]); return read(a); };
  ppu.step(1); ppu.oam.set([255, 9, 0, 50]); // Selection already captured tile 3 at X=20.
  nes.cartridge.writeChr(0x30, 0x80); ppu.step(4);
  nes.cartridge.writeChr(0x30, 0); nes.cartridge.writeChr(0x38, 0x40); ppu.step(2);
  assert.deepEqual(reads, [[261, 0x30], [263, 0x38]]);
  ppu.step(57);
  assert.equal(reads.length, 16, 'empty slots still fetch both planes');
  assert.deepEqual(reads.slice(2).map(([dot]) => dot), [269, 271, 277, 279, 285, 287, 293, 295, 301, 303, 309, 311, 317, 319]);
  ppu.step(341 - 320 + 22);
  assert.equal(nes.frame[20 * 256 + 20], rgb(0x16));
  assert.equal(nes.frame[20 * 256 + 21], rgb(0x2a));
});

test('first selected sprite retains its original OAM identity; flipped 8x16 sprites fetch the correct pair', () => {
  const nes = scene(), ppu = nes.ppu;
  ppu.oam.set([20, 3, 0xc0, 20], 4); nes.write(0x2000, 0x20);
  for (let i = 0; i < 8; i++) nes.cartridge.writeChr(i, 255);
  nes.cartridge.writeChr(0x1037, 0x80);
  ppu.step(20 * 341 + 28);
  assert.equal(nes.frame[20 * 256 + 27], rgb(0x16));
  assert.equal(ppu.readRegister(2) & 64, 0, 'OAM sprite 1 cannot cause sprite-zero hit');
});

test('snapshots resume each sprite fetch phase in JS and WASM without re-reading the low plane', async () => {
  const binary = await readFile('dist-wasm/lib-jsnes.wasm');
  for (const dot of [257, 260, 261, 262, 263, 279, 319, 320]) {
    const nes = scene(); nes.ppu.oam.set([20, 1, 0, 20]);
    nes.cartridge.writeChr(16, 0xff); nes.ppu.step(19 * 341 + dot);
    nes.cartridge.writeChr(16, 0); nes.cartridge.writeChr(24, 0xff);
    const saved = nes.saveState(), wasm = await WasmCore.from(binary);
    wasm.loadRom(rom()); wasm.loadState(saved); nes.loadState(saved);
    nes.step(160); wasm.step(160);
    assert.deepEqual(wasm.saveState(), nes.saveState());
    assert.deepEqual(wasm.audioSamples(), nes.audioSamples());
    const invalid = nes.saveState();
    const ppuOffset = 16 + nes.cartridge.stateSize;
    invalid[ppuOffset + PPU_STATE_SIZE - 283] = 9;
    const before = wasm.saveState(); assert.throws(() => wasm.loadState(invalid));
    assert.deepEqual(wasm.saveState(), before);
  }
});
