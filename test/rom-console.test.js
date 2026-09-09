import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { parseRom, Nes, Cartridge, WasmCore } from '../dist/index.js';

function rom() {
  const bytes = new Uint8Array(16 + 16384); bytes.set([78, 69, 83, 26, 1, 0]);
  bytes.set([0xa9, 0x37, 0x85, 0], 16); bytes.set([0, 0x80], 16 + 16384 - 4); return bytes;
}

test('parser distinguishes console types while both cores reject unsupported hardware before loading', async () => {
  const binary = await readFile('dist-wasm/lib-jsnes.wasm');
  const wasm = await WasmCore.from(binary); wasm.loadRom(rom()); wasm.reset();
  for (const format of [0, 8]) for (const [bits, type] of ['nes', 'vs', 'playchoice', 'extended'].entries()) {
    const bytes = rom(); bytes[7] = format | bits;
    const parsed = parseRom(bytes);
    assert.equal(parsed.consoleType, type);
    assert.equal(parsed.format, format ? 'nes2' : 'ines');
    assert.equal(parsed.prgRom.length, 16384);
    const native = await WasmCore.from(binary);
    bytes.forEach((value, i) => native.exports.romWrite(i, value));
    if (!bits) {
      assert.doesNotThrow(() => new Nes(bytes));
      wasm.loadRom(bytes); wasm.reset(); native.exports.loadRom(bytes.length);
    } else {
      assert.throws(() => new Nes(bytes), /Unsupported console type/);
      assert.throws(() => new Cartridge(parsed), /Unsupported console type/);
      assert.throws(() => wasm.loadRom(bytes), /Unsupported console type/);
      assert.throws(() => native.exports.loadRom(bytes.length));
      assert.equal(wasm.programCounter, 0x8000);
    }
  }
  wasm.step(5); assert.equal(wasm.exports.ramRead(0), 0x37);
});

test('reserved format markers are rejected by the shared parser and system constructors', () => {
  for (const format of [4, 12]) for (let consoleType = 0; consoleType < 4; consoleType++) {
    const bytes = rom(); bytes[7] = format | consoleType;
    assert.throws(() => parseRom(bytes), /Unsupported ROM format/);
    assert.throws(() => new Nes(bytes), /Unsupported ROM format/);
  }
  // Programmatically built legacy images may omit console metadata.
  const image = parseRom(rom()); delete image.consoleType;
  assert.doesNotThrow(() => new Cartridge(image));
});
