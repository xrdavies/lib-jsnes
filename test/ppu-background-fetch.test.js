import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Nes, WasmCore, PPU_STATE_SIZE } from '../dist/index.js';

function rom() {
  const bytes = new Uint8Array(16 + 16384); bytes.set([78, 69, 83, 26, 1, 0, 8]);
  bytes.set([0x4c, 0, 0x80], 16); bytes.set([0, 0x80], 16 + 0x3ffc); return bytes;
}
function at(line, dot, address, temporary = 0) {
  const nes = new Nes(rom()); nes.reset(); nes.ppu.oam.fill(255);
  const state = nes.ppu.saveState(), view = new DataView(state.buffer);
  state[0x4120] = 0x10; state[0x4121] = 0x0a; state[PPU_STATE_SIZE - 11] = 2;
  view.setUint16(0x4128, line, true); view.setUint16(0x412a, dot, true);
  view.setUint16(0x4124, address, true); view.setUint16(PPU_STATE_SIZE - 4, temporary, true);
  nes.ppu.loadState(state); return nes;
}
const address = ppu => new DataView(ppu.saveState().buffer).getUint16(0x4124, true);

test('background fetches nametable, attribute and independent CHR planes at dots 1/3/5/7', () => {
  const { ppu, cartridge } = at(20, 0, 0x5000);
  ppu.vram[0x2000] = 3; ppu.vram[0x23c0] = 2;
  const reads = [], read = ppu.readMemory.bind(ppu);
  ppu.readMemory = a => { reads.push([ppu.dot, a]); return read(a); };
  ppu.step(4); assert.deepEqual(reads, [[1, 0x2000], [3, 0x23c0]]);
  cartridge.writeChr(0x1035, 0x80); ppu.step(1);
  cartridge.writeChr(0x1035, 0); cartridge.writeChr(0x103d, 0x40); ppu.step(3);
  assert.deepEqual(reads, [[1, 0x2000], [3, 0x23c0], [5, 0x1035], [7, 0x103d]]);
  assert.equal(address(ppu), 0x5001);
  const state = ppu.saveState(), view = new DataView(state.buffer);
  assert.equal(view.getUint16(PPU_STATE_SIZE - 281, true), 0x80);
  assert.equal(view.getUint16(PPU_STATE_SIZE - 279, true), 0x40);
  assert.equal(view.getUint16(PPU_STATE_SIZE - 275, true), 255);
});

test('scroll counters wrap coarse X and distinguish coarse Y 29 from 31', () => {
  for (const [v, expected] of [[0x001f, 0x0400], [0x041f, 0], [0x73a0, 0x0801], [0x73e0, 1], [0x63a0, 0x73a1]]) {
    const { ppu } = at(20, v >= 0x6000 ? 255 : 7, v);
    ppu.step(1); assert.equal(address(ppu), expected, v.toString(16));
  }
});

test('horizontal scroll copies at dot 257 and vertical scroll only at pre-render dots 280–304', () => {
  const { ppu } = at(20, 256, 0x73e0, 0x0415);
  ppu.step(1); assert.equal(address(ppu), 0x77f5);
  ppu.writeRegister(5, 0x18); ppu.writeRegister(5, 0x57);
  ppu.step(47); assert.equal(address(ppu), 0x77f5, 'visible lines do not copy Y');
  const unit = at(261, 279, 0x0415, 0x72a3).ppu;
  unit.step(1); assert.equal(address(unit), 0x76b5);
  unit.writeRegister(5, 0); unit.writeRegister(5, 0); unit.step(1);
  assert.equal(address(unit), 0x0415, 'Y copies every dot during the pre-render window');
  unit.step(23); unit.writeRegister(5, 0); unit.writeRegister(5, 8); unit.step(1);
  assert.equal(address(unit), 0x0415, 'copy window ends after dot 304');
});

test('PPUDATA accesses use rendering scroll increments and preserve the fifteenth address bit while blanked', () => {
  for (const read of [false, true]) {
    const { ppu } = at(20, 100, 0x73bf);
    if (read) ppu.readRegister(7); else ppu.writeRegister(7, 0x55);
    assert.equal(address(ppu), 0x0c00);
    ppu.writeRegister(1, 0); ppu.step(1);
    const saved = ppu.saveState(); new DataView(saved.buffer).setUint16(0x4124, 0x3fff, true); ppu.loadState(saved);
    ppu.writeRegister(7, 1); assert.equal(address(ppu), 0x4000);
  }
});

test('partly fetched background bytes and scroll addresses resume identically in JS/WASM', async () => {
  const binary = await readFile('dist-wasm/lib-jsnes.wasm');
  for (const dot of [1, 3, 5, 7, 255, 257, 280, 304, 323, 335]) {
    const js = at(dot >= 280 ? 261 : 20, 0, 0x2000, 0x123);
    for (let i = 0; i < 8192; i++) js.cartridge.writeChr(i, (i * 23) & 255);
    js.ppu.palette.set([0x0f, 0x16, 0x21, 0x30]); js.ppu.step(dot);
    const state = js.saveState(), wasm = await WasmCore.from(binary); wasm.loadRom(rom()); wasm.loadState(state);
    for (const budget of [1, 70, 1000]) {
      js.step(budget); wasm.step(budget);
      const actual = wasm.saveState(), expected = js.saveState();
      assert.deepEqual(actual, expected, `dot ${dot} budget ${budget}: ${Array.from(actual.keys()).filter(i => actual[i] !== expected[i]).map(i => `${i}:${actual[i]}/${expected[i]}`).slice(0, 12)}`);
      assert.deepEqual(wasm.audioSamples(), js.audioSamples());
    }
  }
});
