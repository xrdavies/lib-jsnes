import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Nes, WasmCore, NTSC_FRAME_RATE } from '../dist/index.js';

function rom(mask) {
  const bytes = new Uint8Array(16 + 16384); bytes.set([78, 69, 83, 26, 1, 0]);
  bytes.set([0xa9, mask, 0x8d, 1, 0x20, 0xa9, 0x80, 0x8d, 0, 0x20, 0x4c, 10, 0x80], 16);
  bytes.set([0xe6, 0x10, 0x40], 16 + 256);
  bytes.set([0, 0x81, 0, 0x80, 0, 0x81], 16 + 16384 - 6); return bytes;
}

test('default runFrame completes exactly one PPU frame per call, including odd-frame skips', async () => {
  const binary = await readFile(new URL('../dist-wasm/lib-jsnes.wasm', import.meta.url));
  for (const mask of [0, 24]) {
    const bytes = rom(mask), js = new Nes(bytes), wasm = await WasmCore.from(binary);
    js.reset(); wasm.loadRom(bytes); wasm.reset();
    // Starting partway through a frame must finish that frame, not add a full fixed budget.
    js.step(5000); wasm.step(5000);
    for (let frame = 1; frame <= 200; frame++) {
      const result = js.runFrame(), pixels = wasm.runFrame();
      assert.equal(result.pixels, js.frame);
      assert.equal(js.ppu.scanline, 0);
      const clocks = frame * 89342 - (mask ? Math.floor(frame / 2) : 0);
      assert.equal(js.cycleCount * 3 - clocks, js.ppu.dot);
      assert.ok(js.ppu.dot < 45, 'only instruction and interrupt overshoot may reach the next frame');
      assert.equal(js.read(0x10), frame); assert.equal(wasm.exports.ramRead(0x10), frame);
      assert.equal(wasm.cycleCount, js.cycleCount);
      assert.deepEqual(pixels, js.frame); assert.deepEqual(wasm.audioSamples(), js.audioSamples());
    }
  }
  assert.ok(NTSC_FRAME_RATE > 60.09 && NTSC_FRAME_RATE < 60.10);
});

test('default frame execution resumes snapshots, and explicit budgets retain their original meaning', () => {
  const js = new Nes(rom(24)); js.reset(); js.runFrame(); js.step(1000); js.audioSamples();
  const saved = js.saveState();
  js.runFrame(); const final = js.saveState(), audio = js.audioSamples();
  js.loadState(saved); js.runFrame();
  assert.deepEqual(js.saveState(), final); assert.deepEqual(js.audioSamples(), audio);
  const before = js.cycleCount;
  js.runFrame(1000);
  assert.ok(js.cycleCount >= before + 1000 && js.cycleCount <= before + 1014);
  assert.notEqual(js.ppu.scanline, 0);
});
