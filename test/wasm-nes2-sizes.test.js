import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Nes, WasmCore } from '../dist/index.js';

const binary = await readFile(new URL('../dist-wasm/lib-jsnes.wasm', import.meta.url));
function image(mapper, prgSize, chrSize, prgByte, chrByte, extension) {
  const bytes = new Uint8Array(16 + 512 + prgSize + chrSize);
  bytes.set([78, 69, 83, 26, prgByte, chrByte, (mapper << 4) | 4, 8, 0, extension]);
  bytes.fill(0x79, 16, 528);
  for (let i = 0; i < prgSize; i++) bytes[528 + i] = Math.floor(i / 16384);
  bytes.fill(0x5a, 528 + prgSize);
  return bytes;
}

test('native WASM rejects all truncated exponent headers, including sizes that overflow i32', async () => {
  const core = await WasmCore.from(binary);
  for (const region of ['prg', 'chr']) for (let encoded = 0; encoded < 256; encoded++) {
    const header = Uint8Array.of(78, 69, 83, 26, 1, 0, 0x20, 8, 0, 0, 0, 0, 0, 0, 0, 0);
    header[region === 'prg' ? 4 : 5] = encoded;
    header[9] = region === 'prg' ? 15 : 240;
    header.forEach((value, i) => core.exports.romWrite(i, value));
    assert.throws(() => core.exports.loadRom(16), `${region} encoding ${encoded}`);
  }
});

test('all NES 2.0 exponent multipliers load their actual PRG/CHR bytes with a trainer', async () => {
  const core = await WasmCore.from(binary);
  for (let multiplierBits = 0; multiplierBits < 4; multiplierBits++) {
    const banks = multiplierBits * 2 + 1;
    const bytes = image(2, banks * 16384, banks * 8192, 56 + multiplierBits, 52 + multiplierBits, 255);
    const code = [0xa9, 2, 0x8d, 0, 0x80, 0xad, 0, 0x80, 0x85, 0,
      0xad, 0, 0xc0, 0x85, 1, 0xad, 0, 0x70, 0x85, 2, 0x4c, 0x14, 0xc1];
    bytes.set(code, 528 + (banks - 1) * 16384 + 0x100);
    bytes.set([0, 0xc1], 528 + banks * 16384 - 4);
    const js = new Nes(bytes); js.reset(); core.loadRom(bytes); core.reset();
    js.step(1000); core.step(1000);
    assert.deepEqual([0, 1, 2].map(i => core.exports.ramRead(i)), [2 % banks, banks - 1, 0x79]);
    assert.equal(core.exports.chrRead(8191), 0x5a);
    assert.equal(core.programCounter, js.cpu.pc);
    assert.equal(core.cycleCount, js.cycleCount);
    assert.deepEqual(core.audioSamples(), js.audioSamples());
    assert.equal(core.exports.unknownOpcodeCount(), 0);
  }
});

test('unsupported partial banks are rejected before the wrapper replaces a running cartridge', async () => {
  const core = await WasmCore.from(binary);
  const valid = image(0, 16384, 8192, 1, 1, 0);
  valid.set([0xa9, 0x37, 0x85, 0], 528); valid.set([0, 0x80], 528 + 16384 - 4);
  core.loadRom(valid); core.reset();
  const invalid = [image(2, 8192, 0, 52, 0, 15),
    ...[0, 1, 3, 4].map(mapper => image(mapper, 16384, 512, 1, 36, 240))];
  for (const bytes of invalid) {
    assert.throws(() => core.loadRom(bytes), /PRG size|CHR bank size/);
    assert.equal(core.programCounter, 0x8000);
    assert.equal(core.exports.chrRead(0), 0x5a);
    const native = await WasmCore.from(binary);
    bytes.forEach((value, i) => native.exports.romWrite(i, value));
    assert.throws(() => native.exports.loadRom(bytes.length));
  }
  core.step(5); assert.equal(core.exports.ramRead(0), 0x37);
});
