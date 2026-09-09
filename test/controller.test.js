import assert from 'node:assert/strict';
import test from 'node:test';
import { Controller } from '../dist/index.js';

const bits = mask => Array.from({ length: 8 }, (_, i) => (mask >>> i) & 1);

test('controller serializes all button masks in A/B/Select/Start/Up/Down/Left/Right order', () => {
  const controller = new Controller();
  for (let mask = 0; mask < 256; mask++) {
    controller.setButtons(mask); controller.write(1); controller.write(0);
    assert.deepEqual(Array.from({ length: 8 }, () => controller.read()), bits(mask));
    assert.equal(controller.read(), 1);
  }
});

test('strobe exposes live A while low strobe holds the captured buttons', () => {
  const controller = new Controller();
  controller.setButtons(0xaa); controller.write(1);
  assert.equal(controller.read(), 0);
  controller.setButtons(0x55);
  assert.equal(controller.read(), 1);
  assert.equal(controller.read(), 1);
  controller.write(0); controller.setButtons(0);
  assert.deepEqual(Array.from({ length: 8 }, () => controller.read()), bits(0x55));
  controller.write(0); assert.equal(controller.read(), 1, 'repeated low writes do not relatch');
  controller.write(1); controller.write(0);
  assert.deepEqual(Array.from({ length: 8 }, () => controller.read()), bits(0));
});

test('controller snapshots preserve partial reads and saturated reads beyond eight bits', () => {
  for (const reads of [3, 8, 256, 1024]) {
    const controller = new Controller(); controller.setButtons(0x5a); controller.write(1); controller.write(0);
    for (let i = 0; i < reads; i++) controller.read();
    const state = controller.saveState();
    const restored = new Controller(); restored.loadState(state);
    assert.deepEqual(Array.from({ length: 12 }, () => restored.read()), Array.from({ length: 12 }, () => controller.read()));
    assert.equal(state[2], Math.min(reads, 8));
  }
});
