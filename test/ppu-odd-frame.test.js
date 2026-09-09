import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Nes, WasmCore } from '../dist/index.js';

function rom() {
  const bytes = new Uint8Array(16 + 16384); bytes.set([78, 69, 83, 26, 1, 0]);
  bytes.set([0xa9, 0x18, 0x8d, 1, 0x20, 0xa9, 0x80, 0x8d, 0, 0x20, 0x4c, 10, 0x80], 16);
  bytes.set([0xe6, 0x10, 0x40], 16 + 256);
  bytes.set([0, 0x81, 0, 0x80], 16 + 16384 - 6);
  return bytes;
}
function ppu() { const core = new Nes(rom()); core.reset(); core.ppu.oam.fill(255); return core.ppu; }

test('NTSC frames alternate 89342/89341 dots only while either rendering layer is enabled', () => {
  for (const mask of [0, 1, 8, 16, 24]) {
    const unit = ppu(); unit.writeRegister(1, mask);
    for (let frame = 0; frame < 6; frame++) {
      const dots = 89342 - ((frame & 1) && (mask & 24) ? 1 : 0);
      assert.equal(unit.step(dots - 1), false);
      assert.equal(unit.scanline, 261);
      assert.equal(unit.step(1), true);
      assert.equal(unit.scanline, 0); assert.equal(unit.dot, 0);
      assert.equal(unit.consumeScanlines(), 262);
    }
  }
});

test('odd-frame skip samples the mask on entering dot 339 and preserves parity while blanked', () => {
  for (const enable of [false, true]) {
    const unit = ppu(); unit.step(89342); // Odd frame, despite rendering being disabled.
    unit.writeRegister(1, enable ? 0 : 24);
    unit.step(261 * 341 + 337);
    unit.writeRegister(1, enable ? 24 : 0);
    assert.equal(unit.step(2), false); // The rendering gate settles after one PPU dot.
    assert.equal(unit.dot, enable ? 340 : 339);
    unit.writeRegister(1, enable ? 0 : 24); // Changes after sampling cannot undo the decision.
    assert.equal(unit.step(1), enable);
    if (!enable) {
      assert.equal(unit.dot, 340);
      unit.writeRegister(1, 24); // Too late to skip; must finish the last dot normally.
      assert.equal(unit.step(1), true);
    }
    assert.equal(unit.dot, 0);
  }
});

test('snapshot restoration and batched stepping retain frame parity at the shortened boundary', () => {
  const unit = ppu(); unit.writeRegister(1, 24); unit.step(89342 + 261 * 341 + 339);
  const saved = unit.saveState();
  assert.equal(unit.step(1), true);
  const expected = unit.saveState();
  unit.reset(); unit.loadState(saved); assert.equal(unit.step(1), true);
  assert.deepEqual(unit.saveState(), expected);
  const invalid = saved.slice(); invalid[invalid.length - 1] = 2;
  assert.throws(() => unit.loadState(invalid), /Invalid PPU state/);
  assert.deepEqual(unit.saveState(), expected);
  assert.throws(() => unit.loadState(saved.subarray(0, saved.length - 1)), /Invalid PPU state/);
  const batch = ppu(), single = ppu(); batch.writeRegister(1, 8); single.writeRegister(1, 8);
  batch.step(2 * 89342 - 1);
  for (let i = 0; i < 2 * 89342 - 1; i++) single.step(1);
  assert.deepEqual(batch.saveState(), single.saveState());
  assert.equal(batch.dot, 0); assert.equal(batch.scanline, 0);
});

test('WASM reaches the 200th VBlank at the shortened NTSC deadline', async () => {
  const bytes = rom(), js = new Nes(bytes);
  const wasm = await WasmCore.from(await readFile('dist-wasm/lib-jsnes.wasm'));
  js.reset(); wasm.loadRom(bytes); wasm.reset();
  const vblankDots = 241 * 341 + 1 + 199 * 89342 - 99;
  // Allow the instruction boundary, NMI entry and INC, but fewer than the
  // 33 CPU cycles by which an implementation without odd-frame skipping drifts.
  const cycles = Math.ceil(vblankDots / 3) + 15;
  js.step(cycles); wasm.step(cycles);
  assert.equal(js.read(0x10), 200);
  assert.equal(wasm.exports.ramRead(0x10), 200);
  assert.equal(wasm.cycleCount, js.cycleCount);
  assert.deepEqual(wasm.frame(), js.frame);
  assert.deepEqual(wasm.audioSamples(), js.audioSamples());
});
