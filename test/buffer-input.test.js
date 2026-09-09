import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Nes, WasmCore, parseRom } from '../dist/index.js';

function rom() {
  const bytes = Buffer.alloc(16 + 512 + 16384 + 8192);
  bytes.set([78, 69, 83, 26, 1, 1, 4]);
  bytes.fill(0x79, 16, 528); bytes.fill(0x5a, 528 + 16384);
  bytes.set([0xa9, 0x37, 0x85, 0, 0x4c, 4, 0x80], 528);
  bytes.set([0, 0x80], 528 + 16384 - 4);
  return bytes;
}

test('ROM sections own their bytes when parsed from a Buffer with a nonzero offset', () => {
  const bytes = rom(), storage = Buffer.alloc(bytes.length + 13, 0xcc);
  bytes.copy(storage, 7);
  const input = storage.subarray(7, 7 + bytes.length), parsed = parseRom(input), nes = new Nes(input);
  input.fill(0);
  assert.equal(parsed.trainer[0], 0x79);
  assert.equal(parsed.prgRom[0], 0xa9);
  assert.equal(parsed.chrRom[8191], 0x5a);
  nes.reset(); nes.step(5); assert.equal(nes.read(0), 0x37);
  assert.equal(nes.read(0x7000), 0x79);
  assert.equal(nes.cartridge.readChr(0), 0x5a);
  parsed.prgRom[0] = 0;
  assert.equal(nes.rom.prgRom[0], 0xa9, 'independent parses must not share ROM data');
});

test('full and direct PPU snapshots restore Buffer subviews without reading the backing allocation', () => {
  const source = new Nes(rom()); source.reset(); source.step(12000);
  source.ppu.frame[0] = 0xff123456; source.ppu.frame[61439] = 0xffabcdef;
  for (const component of ['ppu', 'system']) {
    const saved = component === 'ppu' ? source.ppu.saveState() : source.saveState();
    const storage = Buffer.alloc(saved.length + 17, 0xcc); storage.set(saved, 3);
    const input = storage.subarray(3, 3 + saved.length), target = new Nes(rom()); target.reset();
    if (component === 'ppu') target.ppu.loadState(input); else target.loadState(input);
    assert.deepEqual(component === 'ppu' ? target.ppu.saveState() : target.saveState(), saved);
    storage.fill(0);
    assert.deepEqual(component === 'ppu' ? target.ppu.saveState() : target.saveState(), saved);
  }
});

test('WASM ROM loading copies a Buffer backed by its current linear memory before allocation', async () => {
  const core = await WasmCore.from(await readFile('dist-wasm/lib-jsnes.wasm'));
  const bytes = rom(), pointer = core.exports.romAllocate(bytes.length);
  const buffer = Buffer.from(core.exports.memory.buffer, pointer, bytes.length);
  buffer.set(bytes);
  core.loadRom(buffer); core.reset(); core.step(5);
  assert.equal(core.exports.ramRead(0), 0x37);
  assert.equal(core.exports.chrRead(0), 0x5a);
});
