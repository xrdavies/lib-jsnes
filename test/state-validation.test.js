import assert from 'node:assert/strict';
import test from 'node:test';
import { Nes, Apu, Controller } from '../dist/index.js';

function machine() {
  const bytes = new Uint8Array(16 + 0x8000);
  bytes.set([78, 69, 83, 26, 2, 0, 0x40]);
  bytes.set([0x4c, 0, 0x80], 16); bytes.set([0, 0x80], 16 + 0x7ffc);
  const nes = new Nes(bytes); nes.reset();
  nes.write(0x4015, 1); nes.write(0x4000, 0x7f); nes.write(0x4002, 99); nes.write(0x4003, 8);
  nes.setController(1, 0xa5); nes.write(0x4016, 1); nes.write(0x4016, 0); nes.read(0x4016);
  return nes;
}

test('invalid snapshot sections leave all live state and pending PCM intact', () => {
  for (const field of ['cart', 'ppuAddress', 'ppuLine', 'ppuDot', 'ppuLatch', 'ppuNmi', 'ppuHit', 'ppuOverflow', 'apu', 'controller1', 'controller2', 'dma']) {
    const nes = machine(), reference = machine();
    const invalid = nes.saveState();
    const ppu = 11 + nes.cartridge.stateSize;
    const ppuSize = nes.ppu.saveState().length;
    const apu = ppu + ppuSize, controllers = apu + Apu.STATE_SIZE;
    const offsets = { cart: 11 + 25, ppuAddress: ppu + 0x4125, ppuLine: ppu + 0x4129,
      ppuDot: ppu + 0x412b, ppuLatch: ppu + 0x4126, ppuNmi: ppu + 0x412c,
      ppuHit: ppu + 0x412f, ppuOverflow: ppu + 0x4130, apu: apu + 59,
      controller1: controllers + 2, controller2: controllers + 7 };
    if (field === 'dma') new DataView(invalid.buffer).setFloat64(invalid.length - 8, NaN, true);
    else invalid[offsets[field]] = 255;
    for (const core of [nes, reference]) {
      core.step(12000);
      core.write(0x6000, 0x5a); core.cartridge.writeChr(1, 0x7b);
      core.ppu.palette[0] = 0x2a;
      core.read(0x4016);
      core.write(0x4014, 2); // A pending stall must also survive rejection.
    }
    const before = nes.saveState(), pixels = nes.frame, cartRam = nes.cartridge.prgRam;
    assert.throws(() => nes.loadState(invalid), /Invalid/, field);
    assert.deepEqual(nes.saveState(), before, field);
    assert.equal(nes.frame, pixels); assert.equal(nes.cartridge.prgRam, cartRam);
    const queued = nes.audioSamples();
    assert.ok(queued.length > 0);
    assert.deepEqual(queued, reference.audioSamples(), `${field} queued audio`);
    nes.step(1000); reference.step(1000);
    assert.deepEqual(nes.saveState(), reference.saveState(), `${field} continuation`);
    assert.deepEqual(nes.audioSamples(), reference.audioSamples());
  }
});

test('direct PPU and controller restore reject invalid timing and flags before mutation', () => {
  const { ppu } = machine(); ppu.step(12000);
  const before = ppu.saveState();
  for (const offset of [0x4125, 0x4126, 0x4129, 0x412b, 0x412c, 0x412f, 0x4130]) {
    const invalid = before.slice(); invalid[0] = 123; invalid[offset] = 255;
    assert.throws(() => ppu.loadState(invalid), /Invalid PPU state/);
    assert.deepEqual(ppu.saveState(), before);
  }
  const controller = new Controller(); controller.setButtons(0x5a); controller.write(1); controller.write(0); controller.read();
  const state = controller.saveState();
  for (const invalid of [Uint8Array.of(0, 0, 9, 0), Uint8Array.of(0, 0, 0, 2)]) {
    assert.throws(() => controller.loadState(invalid), /Invalid controller state/);
    assert.deepEqual(controller.saveState(), state);
  }
});

test('validated snapshots restore from offset views and discard audio only on success', () => {
  const nes = machine(); nes.step(7456);
  const saved = nes.saveState(), view = new Uint8Array(saved.length + 7);
  view.set(saved, 3);
  nes.step(25000); nes.loadState(view.subarray(3, 3 + saved.length));
  assert.deepEqual(nes.saveState(), saved);
  assert.equal(nes.audioSamples().length, 0);
  nes.step(1); assert.ok(nes.cycleCount > 7456);
});
