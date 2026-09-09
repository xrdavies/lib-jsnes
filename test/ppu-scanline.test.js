import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Nes, WasmCore, NES_PALETTE } from '../dist/index.js';

const rgb = index => (0xff000000 | NES_PALETTE[index]) >>> 0;
function image() {
  const bytes = new Uint8Array(16 + 16384 + 16384);
  bytes.set([78, 69, 83, 26, 1, 2, 0x30]);
  bytes.set([0x4c, 0, 0x80], 16); bytes.set([0, 0x80], 16 + 16384 - 4);
  // Bank 0 tile 0 = color 1, tile 1 = color 2; bank 1 tile 0 = color 3.
  bytes.fill(255, 16 + 16384, 16 + 16384 + 8);
  bytes.fill(255, 16 + 16384 + 24, 16 + 16384 + 32);
  bytes.fill(255, 16 + 16384 + 8192, 16 + 16384 + 8192 + 16);
  return bytes;
}
function scene() {
  const nes = new Nes(image()); nes.reset(); nes.ppu.oam.fill(255);
  nes.ppu.palette.set([0x0f, 0x16, 0x2a, 0x21]);
  nes.write(0x2001, 10);
  return nes;
}

test('palette, scroll, mask and CHR changes affect subsequent lines without repainting earlier lines', () => {
  for (const change of ['palette', 'scroll', 'mask', 'bank']) {
    const nes = scene();
    for (let row = 0; row < 30; row++) nes.ppu.vram[0x2000 + row * 32 + 1] = 1;
    nes.ppu.step(120 * 341);
    assert.equal(nes.frame[0], rgb(0x16));
    assert.equal(nes.frame[120 * 256], 0xff000000, 'future line has not been rendered');
    const completed = nes.frame.slice(0, 120 * 256);
    if (change === 'palette') nes.ppu.palette[1] = 0x30;
    if (change === 'scroll') { nes.write(0x2005, 8); nes.write(0x2005, 0); }
    if (change === 'mask') nes.write(0x2001, 0);
    if (change === 'bank') nes.write(0x8000, 1);
    const state = nes.saveState();
    nes.ppu.step(120 * 341);
    const expected = rgb({ palette: 0x30, scroll: 0x2a, mask: 0x0f, bank: 0x21 }[change]);
    assert.deepEqual(nes.frame.subarray(0, 120 * 256), completed);
    assert.equal(nes.frame[120 * 256], expected);
    assert.equal(nes.frame[239 * 256], expected);
    const frame = nes.frame.slice();
    nes.reset(); nes.loadState(state); nes.ppu.step(120 * 341);
    assert.deepEqual(nes.frame, frame, 'mid-frame snapshot resumes only unfinished lines');
  }
});

test('visible line completion precedes VBlank and sprite status clears on pre-render', () => {
  const nes = scene(); nes.ppu.oam.set([19, 0, 0, 20]); nes.write(0x2001, 30);
  nes.ppu.step(20 * 341 + 255);
  assert.equal(nes.read(0x2002) & 64, 0);
  nes.ppu.step(1); assert.equal(nes.read(0x2002) & 64, 64);
  nes.ppu.step(241 * 341 + 1 - (20 * 341 + 256));
  assert.equal(nes.frame[239 * 256], rgb(0x16));
  assert.equal(nes.read(0x2002) & 0xc0, 0xc0);
  nes.ppu.step(20 * 341); assert.equal(nes.read(0x2002) & 0xe0, 0);
});

test('CPU-driven CHR and palette changes produce matching split frames in WASM', async () => {
  const rom = image(), code = [];
  const write = (a, v) => code.push(0xa9, v, 0x8d, a & 255, a >>> 8);
  write(0x2006, 0x3f); write(0x2006, 0);
  for (const color of [0x0f, 0x16, 0x2a, 0x21]) write(0x2007, color);
  write(0x2001, 10);
  const wait = 0x8000 + code.length; code.push(0x4c, wait & 255, wait >>> 8);
  rom.set(code, 16);
  // Swap the waiting JMP destination at a host boundary; all actual PPU/mapper writes run on CPU.
  rom.set([0xa9, 1, 0x8d, 0, 0x80, 0x4c, 5, 0x82], 16 + 0x200);
  const js = new Nes(rom), wasm = await WasmCore.from(await readFile('dist-wasm/lib-jsnes.wasm'));
  js.reset(); wasm.loadRom(rom); wasm.reset();
  js.step(13000); wasm.step(13000);
  const before = js.frame.slice(20 * 256, 80 * 256);
  const operand = wait - 0x8000 + 1;
  js.rom.prgRom.set([0, 0x82], operand);
  wasm.exports.romWrite(16 + operand, 0); wasm.exports.romWrite(17 + operand, 0x82);
  js.step(15000); wasm.step(15000);
  assert.equal(js.frame[30 * 256], rgb(0x16));
  assert.equal(js.frame[200 * 256], rgb(0x21));
  assert.deepEqual(js.frame.subarray(20 * 256, 80 * 256), before);
  assert.deepEqual(wasm.frame(), js.frame);
  assert.deepEqual(wasm.audioSamples(), js.audioSamples());
  assert.equal(wasm.cycleCount, js.cycleCount);
});
