import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Nes, WasmCore } from '../dist/index.js';

const binary = await readFile(new URL('../dist-wasm/lib-jsnes.wasm', import.meta.url));
function image(code, banks = 128, chr = 128) {
  const bytes = new Uint8Array(16 + banks * 0x4000 + chr * 0x2000);
  bytes.set([78, 69, 83, 26, banks, chr, 0x10, 0xe0]);
  for (let i = 0; i < banks; i++) {
    const start = 16 + i * 0x4000;
    bytes.fill(i, start, start + 0x4000);
    bytes.set(code, start + 0x100);
    bytes.set([0, 0x81], start + 0x3ffc);
  }
  for (let i = 0; i < chr; i++) bytes.fill(0x80 + i, 16 + banks * 0x4000 + i * 8192, 16 + banks * 0x4000 + (i + 1) * 8192);
  return bytes;
}

test('mapper 225 CPU writes cover every selector address in both PRG modes and outer banks', async () => {
  // Execute from RAM so changing the full cartridge window cannot change the probe.
  // Its STA operand increments after each probe, sweeping $8000 through $FFFF.
  const probe = [0xa9, 0, 0x8d, 0, 0x80, 0xad, 0, 0x80, 0x85, 0,
    0xad, 0, 0xc0, 0x85, 1, 0xee, 3, 2, 0xd0, 3, 0xee, 4, 2, 0x4c, 0, 2];
  const boot = [0xad, 0, 0x80, 0x85, 2, 0xad, 0, 0xc0, 0x85, 3,
    0xa2, 25, 0xbd, 0, 0x82, 0x9d, 0, 2, 0xca, 0x10, 0xf7, 0x4c, 0, 2];
  const code = new Uint8Array(256 + probe.length); code.set(boot); code.set(probe, 256);
  const wasm = await WasmCore.from(binary);
  for (const [banks, chr] of [[128, 128], [1, 0]]) {
    const bytes = image(code, banks, chr), js = new Nes(bytes);
    js.reset(); wasm.loadRom(bytes); wasm.reset(); js.step(382); wasm.step(382);
    assert.equal(wasm.programCounter, 0x200);
    assert.deepEqual([2, 3].map(i => wasm.exports.ramRead(i)), [0, 1 % banks]);
    for (let address = 0x8000; address <= 0xffff; address++) {
      const cycles = (address & 255) === 255 ? 37 : 32;
      js.step(cycles); wasm.step(cycles);
      const prg = (address >>> 6) & 63 | (address & 0x4000 ? 64 : 0);
      const expected = address & 0x1000 ? [prg, prg] : [prg - prg % 2, prg - prg % 2 + 1];
      for (let slot = 0; slot < 2; slot++) {
        assert.equal(js.read(slot), expected[slot] % banks, `TS ${address.toString(16)}:${slot}`);
        assert.equal(wasm.exports.ramRead(slot), expected[slot] % banks, `WASM ${address.toString(16)}:${slot}`);
      }
      const pattern = chr ? 0x80 + (address & 63) + (address & 0x4000 ? 64 : 0) : 0;
      assert.equal(wasm.exports.chrRead(0x1fff), pattern);
      assert.equal(js.cartridge.readChr(0x1fff), pattern);
      assert.equal(js.cartridge.mirroring, address & 0x2000 ? 'horizontal' : 'vertical');
    }
    assert.equal(wasm.programCounter, js.cpu.pc);
    assert.equal(wasm.cycleCount, js.cycleCount);
    assert.deepEqual(wasm.audioSamples(), js.audioSamples());
    assert.equal(wasm.exports.unknownOpcodeCount(), 0);
  }
});

test('mapper 225 nibble registers alias across $5800–$5FFF and survive reset', async () => {
  const code = [];
  for (let value = 0; value < 256; value++) for (let slot = 0; slot < 4; slot++) {
    code.push(0xa9, value, 0x8d, slot, 0x58, 0xad, 0xfc + slot, 0x5f, 0x85, slot);
  }
  const bytes = image(code, 2, 0), js = new Nes(bytes), wasm = await WasmCore.from(binary);
  js.reset(); wasm.loadRom(bytes); wasm.reset();
  for (let value = 0; value < 256; value++) for (let slot = 0; slot < 4; slot++) {
    js.step(13); wasm.step(13);
    assert.equal(js.read(slot), value & 15);
    assert.equal(wasm.exports.ramRead(slot), value & 15);
  }
  js.cartridge.writeChr(123, 0x73);
  const state = js.saveState(); js.write(0x5800, 0); js.cartridge.writeChr(123, 0);
  js.loadState(state);
  assert.equal(js.read(0x5ffc), 15); assert.equal(js.cartridge.readChr(123), 0x73);
  const invalid = js.cartridge.saveState(); invalid[invalid.length - 1] = 16;
  assert.throws(() => js.cartridge.loadState(invalid), /Invalid cartridge state/);
  assert.throws(() => js.loadState(state.subarray(0, state.length - 4)), /Invalid state size/);
  // Replace the boot instructions with a read-only probe, then reset without reloading.
  const read = [0xad, 0xff, 0x5f, 0x85, 4, 0xad, 0, 0x50, 0x85, 5];
  for (let i = 0; i < read.length; i++) wasm.exports.romWrite(16 + 0x100 + i, read[i]);
  wasm.reset(); wasm.step(14);
  assert.equal(wasm.exports.ramRead(4), 15);
  assert.equal(wasm.exports.ramRead(5), 0);
  wasm.loadRom(bytes); wasm.reset();
  for (let i = 0; i < read.length; i++) wasm.exports.romWrite(16 + 0x100 + i, read[i]);
  wasm.step(14); assert.equal(wasm.exports.ramRead(4), 0);
});

test('mapper 225 snapshots restore both aligned and repeated windows; write data does not select banks', () => {
  const nes = new Nes(image([], 128, 128));
  for (const address of [0x8041, 0x9041, 0xc041, 0xd041, 0xffff]) {
    nes.write(address, 0);
    const state = nes.saveState(), pair = [nes.read(0x8000), nes.read(0xc000)];
    nes.write(address, 255);
    assert.deepEqual(nes.saveState(), state);
    nes.write(0x8000, 0); nes.loadState(state);
    assert.deepEqual([nes.read(0x8000), nes.read(0xc000)], pair);
    assert.equal(nes.cartridge.readChr(0), 0x80 + (address & 63) + (address & 0x4000 ? 64 : 0));
  }
  nes.write(0x5800, 0xab); nes.reset();
  assert.deepEqual([nes.read(0x8000), nes.read(0xc000)], [0, 1]);
  assert.equal(nes.read(0x5800), 11);
});
