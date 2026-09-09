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

test('palette/mask changes apply immediately while coarse scroll and CHR preserve prefetched pixels', () => {
  for (const change of ['palette', 'scroll', 'mask', 'bank']) {
    const nes = scene();
    for (let row = 0; row < 30; row++) nes.ppu.vram[0x2000 + row * 32 + 1] = 1;
    nes.ppu.step(120 * 341);
    assert.equal(nes.frame[32], rgb(0x16));
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
    assert.equal(nes.frame[120 * 256], change === 'scroll' || change === 'bank' ? rgb(0x16) : expected);
    assert.equal(nes.frame[121 * 256], expected);
    assert.equal(nes.frame[239 * 256], expected);
    const frame = nes.frame.slice();
    nes.reset(); nes.loadState(state); nes.ppu.step(120 * 341);
    assert.deepEqual(nes.frame, frame, 'mid-frame snapshot resumes only unfinished lines');
  }
});

test('visible line completion precedes VBlank and sprite status clears on pre-render', () => {
  const nes = scene(); nes.ppu.oam.set([20, 0, 0, 20]); nes.write(0x2001, 30);
  nes.ppu.step(20 * 341 + 20);
  assert.equal(nes.read(0x2002) & 64, 0);
  nes.ppu.step(1); assert.equal(nes.read(0x2002) & 64, 64);
  nes.ppu.step(241 * 341 + 1 - (20 * 341 + 21));
  assert.equal(nes.frame[239 * 256], rgb(0x16));
  assert.equal(nes.read(0x2002) & 0xc0, 0xc0);
  nes.ppu.step(20 * 341); assert.equal(nes.read(0x2002) & 0xe0, 0);
});

test('pixels commit at x+1 and palette/mask writes affect only subsequent pixels', async () => {
  const bytes = image(), nes = scene();
  nes.ppu.step(20 * 341 + 100);
  assert.equal(nes.frame[20 * 256 + 99], rgb(0x16));
  assert.equal(nes.frame[20 * 256 + 100], 0xff000000);
  const prefix = nes.frame.slice(20 * 256, 20 * 256 + 100);
  // Change palette through PPUDATA, then save while partway across a line.
  nes.write(0x2006, 0x3f); nes.write(0x2006, 1); nes.write(0x2007, 0x30);
  const saved = nes.saveState(), wasm = await WasmCore.from(await readFile('dist-wasm/lib-jsnes.wasm'));
  wasm.loadRom(bytes); wasm.loadState(saved);
  nes.ppu.step(20);
  assert.deepEqual(nes.frame.subarray(20 * 256, 20 * 256 + 100), prefix);
  assert.ok(nes.frame.subarray(20 * 256 + 100, 20 * 256 + 120).every(v => v === rgb(0x30)));
  // Disable output, then select a forced-blank palette entry explicitly.
  nes.write(0x2001, 0); nes.write(0x2006, 0x3f); nes.write(0x2006, 2); nes.ppu.step(136);
  assert.ok(nes.frame.subarray(20 * 256 + 120, 21 * 256).every(v => v === rgb(0x2a)));
  nes.loadState(saved); nes.step(52); wasm.step(52);
  assert.deepEqual(wasm.frame(), nes.frame);
  assert.deepEqual(wasm.saveState(), nes.saveState());
  assert.deepEqual(nes.frame.subarray(20 * 256, 20 * 256 + 100), prefix);
});

test('pixel composition applies sprite priority, left clipping and grayscale at output time', () => {
  const nes = scene(); nes.ppu.oam.set([20, 0, 0, 0]);
  nes.ppu.palette[17] = 0x2a; nes.write(0x2001, 0x1e);
  nes.ppu.step(20 * 341 + 3);
  assert.equal(nes.frame[20 * 256 + 2], rgb(0x2a));
  nes.write(0x2001, 0x1a); // Clip sprites at the left edge.
  nes.ppu.step(2); assert.equal(nes.frame[20 * 256 + 4], rgb(0x16));
  nes.write(0x2001, 0x1f); // Enable sprites and grayscale.
  nes.ppu.step(3); assert.equal(nes.frame[20 * 256 + 7], rgb(0x20));
  assert.equal(nes.frame[20 * 256 + 2], rgb(0x2a));
});

test('CPU PPUMASK writes split a visible row at the actual bus access in both cores', async () => {
  const nes = scene();
  [0xa9, 0, 0x8d, 1, 0x20, 0x02].forEach((v, i) => nes.write(0x200 + i, v));
  nes.cpu.pc = 0x200; nes.ppu.step(20 * 341 + 100);
  const wasm = await WasmCore.from(await readFile('dist-wasm/lib-jsnes.wasm'));
  wasm.loadRom(image()); wasm.loadState(nes.saveState());
  nes.step(52); wasm.step(52);
  // LDA (2) + STA (4): the write follows 17 PPU dots; the last dot sees the new mask.
  assert.ok(nes.frame.subarray(20 * 256, 20 * 256 + 117).every(v => v === rgb(0x16)));
  assert.ok(nes.frame.subarray(20 * 256 + 117, 21 * 256).every(v => v === rgb(0x0f)));
  assert.deepEqual(wasm.frame(), nes.frame); assert.deepEqual(wasm.saveState(), nes.saveState());
});

test('mid-line snapshots retain fetched pattern bytes while later fetches see CHR changes', async () => {
  const bytes = new Uint8Array(16 + 16384); bytes.set([78, 69, 83, 26, 1, 0]);
  bytes.set([0x4c, 0, 0x80], 16); bytes.set([0, 0x80], 16 + 0x3ffc);
  const nes = new Nes(bytes); nes.reset(); nes.ppu.oam.fill(255);
  for (let i = 0; i < 8; i++) nes.cartridge.writeChr(i, 255);
  nes.ppu.palette.set([0x0f, 0x16]); nes.write(0x2001, 10);
  nes.ppu.step(20 * 341 + 100);
  for (let i = 0; i < 8; i++) nes.cartridge.writeChr(i, 0);
  const state = nes.saveState(), wasm = await WasmCore.from(await readFile('dist-wasm/lib-jsnes.wasm'));
  wasm.loadRom(bytes); wasm.loadState(state); nes.loadState(state);
  nes.step(180); wasm.step(180);
  assert.ok(nes.frame.subarray(20 * 256, 20 * 256 + 112).every(v => v === rgb(0x16)));
  assert.ok(nes.frame.subarray(20 * 256 + 112, 22 * 256).every(v => v === rgb(0x0f)));
  assert.deepEqual(wasm.saveState(), nes.saveState());
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

test('CPU polling observes sprite zero before line completion in JS and WASM', async () => {
  const rom = image(), code = [];
  const write = (a, v) => code.push(0xa9, v, 0x8d, a & 255, a >>> 8);
  write(0x2003, 0);
  for (const value of [40, 0, 0x20, 20]) write(0x2004, value);
  write(0x2001, 0x1e);
  code.push(0x2c, 0x02, 0x20, 0x50, 0xfb); // BIT $2002; BVC back to BIT.
  write(0, 1);
  code.push(0x02); // JAM after recording the hit.
  rom.set(code, 16);
  const js = new Nes(rom), wasm = await WasmCore.from(await readFile('dist-wasm/lib-jsnes.wasm'));
  js.reset(); wasm.loadRom(rom); wasm.reset();
  const before = Math.floor((40 * 341 + 20) / 3);
  js.step(before); wasm.step(before);
  assert.equal(js.read(0), 0);
  assert.equal(wasm.exports.ramRead(0), 0);
  js.step(25); wasm.step(25);
  assert.equal(js.read(0), 1, 'polling finishes before dot 256');
  assert.equal(wasm.exports.ramRead(0), 1);
  assert.equal(wasm.cycleCount, js.cycleCount);
  assert.equal(wasm.programCounter, js.cpu.pc);
});
