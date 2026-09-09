import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Nes, WasmCore } from '../dist/index.js';

function rom(code = []) {
  const bytes = new Uint8Array(16 + 16384);
  bytes.set([78, 69, 83, 26, 1, 0]); bytes.set(code, 16);
  bytes.set([0, 0x80], 16 + 0x3ffc);
  return bytes;
}

test('undriven CPU reads retain bus data while PPU and APU ports use their own driven bits', () => {
  const nes = new Nes(rom()); nes.reset();
  assert.equal(nes.read(0x5000), 0x80, 'reset vector read drives the bus');
  for (const value of [0, 0xa5, 0xff]) {
    nes.write(0x5000, value);
    for (const address of [0x4000, 0x4014, 0x4018, 0x401f, 0x4020, 0x5000]) {
      assert.equal(nes.read(address), value);
    }
    assert.equal(nes.read(0x4015), value & 0x20);
    assert.equal(nes.read(0x5000), value, '$4015 does not drive the external bus');
  }
  nes.write(0x2000, 0x1b); nes.write(0, 0xe7);
  assert.equal(nes.read(0x2000), 0x1b, 'PPU I/O latch is separate from CPU open bus');
  assert.equal(nes.read(0x5000), 0x1b);
  assert.equal(nes.read(0), 0xe7);
  assert.equal(nes.read(0x5000), 0xe7);
  nes.setController(1, 1); nes.write(0x4016, 1); nes.write(0x4016, 0);
  nes.write(0x5000, 0xff);
  assert.equal(nes.read(0x4016), 0xe1, 'standard NES port retains D5-D7, drives D1-D4 low');
  nes.reset(); assert.equal(nes.read(0x5000), 0x80);
});

test('CPU operand and page-crossing dummy reads determine open bus in both cores', async () => {
  // Keep the controller strobe high so both reads sample the live A button.
  const code = [0xa9, 1, 0x8d, 0x16, 0x40, 0xa9, 0xa5, 0x8d, 0, 0x20, 0xa2, 0x20];
  const probes = [[0xad, 0x4016], [0xad, 0x4017], [0xad, 0x4000], [0xad, 0x5000],
    [0xbd, 0x3fe0], [0xbd, 0x3ff5], [0xbd, 0x3ff6], [0xbd, 0x3ff7], [0xad, 0x2000]];
  probes.forEach(([opcode, address], i) => code.push(opcode, address & 255, address >>> 8, 0x85, i));
  code.push(0x02);
  const bytes = rom(code), js = new Nes(bytes);
  const wasm = await WasmCore.from(await readFile('dist-wasm/lib-jsnes.wasm'));
  js.reset(); wasm.loadRom(bytes); wasm.reset();
  for (const core of [js, wasm]) { core.setController(1, 1); core.setController(2, 0); }
  js.step(200); wasm.step(200);
  // The last indexed read's dummy address mirrors PPUDATA: its empty read
  // buffer drives zero and replaces the PPU I/O latch before reading port 2.
  const expected = [0x41, 0x40, 0x40, 0x50, 0xa5, 0x20, 0xa1, 0, 0];
  assert.deepEqual(expected.map((_, i) => js.read(i)), expected);
  assert.deepEqual(expected.map((_, i) => wasm.exports.ramRead(i)), expected);
  assert.equal(wasm.cycleCount, js.cycleCount);
  assert.equal(wasm.programCounter, js.cpu.pc);
});

test('snapshots restore CPU open bus and pending OAM DMA drives its buffered byte', () => {
  const nes = new Nes(rom()); nes.reset();
  nes.write(0x200, 0xe6); nes.write(0x4014, 2); nes.step(2);
  assert.equal(nes.read(0x5000), 0xe6, 'DMA read drives the bus');
  const saved = nes.saveState();
  nes.write(0x5000, 0x11); nes.step(1);
  assert.equal(nes.read(0x5000), 0xe6, 'DMA write drives its previously buffered byte');
  const after = nes.saveState();
  nes.loadState(saved); assert.equal(nes.read(0x5000), 0xe6);
  nes.step(1); assert.deepEqual(nes.saveState(), after);
  assert.throws(() => nes.loadState(saved.subarray(0, saved.length - 1)), /Invalid state size/);
  assert.deepEqual(nes.saveState(), after);
});
