import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Nes, WasmCore } from '../dist/index.js';
const binary = await readFile(new URL('../dist-wasm/lib-jsnes.wasm', import.meta.url));
function program() {
  const code = [];
  const write = (a, v) => code.push(0xa9, v, 0x8d, a & 255, a >>> 8);
  const read = (a, dest) => code.push(0xad, a & 255, a >>> 8, 0x85, dest);
  const select = (r, v, mode = 0) => { write(0x8000, r | mode); write(0x8001, v); };
  const addr = a => { write(0x2006, a >>> 8); write(0x2006, a & 255); };
  const ppuRead = (a, dest) => { addr(a); read(0x2007, 255); read(0x2007, dest); };
  return { code, write, read, select, addr, ppuRead };
}
function image(p, chr = 4, flags = 0) {
  const rom = new Uint8Array(16 + 0x20000 + chr * 0x2000);
  rom.set([78, 69, 83, 26, 8, chr, 0x40 | flags]);
  for (let bank = 0; bank < 16; bank++) rom.fill(0x30 + bank, 16 + bank * 8192, 16 + (bank + 1) * 8192);
  for (let bank = 0; bank < chr * 8; bank++) rom.fill(bank, 16 + 0x20000 + bank * 1024, 16 + 0x20000 + (bank + 1) * 1024);
  const loop = 0xe000 + p.code.length;
  assert.ok(p.code.length < 0x1000);
  rom.set([...p.code, 0x4c, loop & 255, loop >>> 8], 16 + 0x1e000);
  rom.set([0xe6, 0x10, 0x8d, 0, 0xe0, 0x40], 16 + 0x1f100); // IRQ count/ack/RTI.
  rom.set([0, 0xf1, 0, 0xe0, 0, 0xf1], 16 + 0x1fffa);
  return rom;
}
async function pair(bytes) {
  const js = new Nes(bytes), wasm = await WasmCore.from(binary);
  js.reset(); wasm.loadRom(bytes); wasm.reset();
  assert.equal(wasm.programCounter, 0xe000);
  return { js, wasm, step(cycles) {
    js.step(cycles); wasm.step(cycles);
    assert.equal(wasm.programCounter, js.cpu.pc); assert.equal(wasm.cycleCount, js.cycleCount);
    assert.equal(wasm.exports.unknownOpcodeCount(), 0);
    assert.deepEqual(wasm.audioSamples(), js.audioSamples());
    assert.deepEqual(wasm.frame(), js.frame);
  }, ram(expected) {
    for (const [slot, value] of expected.entries()) {
      assert.equal(js.read(slot), value, `JS byte ${slot}`); assert.equal(wasm.exports.ramRead(slot), value, `WASM byte ${slot}`);
    }
  } };
}

test('WASM MMC3 selects all PRG slots in both modes including wrapped selectors', async () => {
  for (const value of [0, 3, 15, 16, 63, 255]) {
    const p = program(); p.select(6, value); p.select(7, value + 1);
    for (const [mode, dest] of [[0, 0], [0x40, 4]]) {
      p.write(0x8000, mode);
      for (let slot = 0; slot < 4; slot++) p.read(0x9000 + slot * 0x2000, dest + slot);
    }
    const run = await pair(image(p)); run.step(1000);
    const a = 0x30 + value % 16, b = 0x30 + (value + 1) % 16;
    run.ram([a, b, 0x3e, 0x3f, 0x3e, b, a, 0x3f]);
  }
});

test('WASM MMC3 maps eight CHR slots and ignores odd pair bits in both inversion modes', async () => {
  for (const values of [[5, 11, 17, 20, 23, 26], [255, 254, 253, 252, 251, 250]]) {
    const p = program(); values.forEach((v, r) => p.select(r, v));
    for (const [mode, dest] of [[0, 0], [0x80, 8]]) {
      p.write(0x8000, mode);
      for (let i = 0; i < 8; i++) p.ppuRead(i * 1024 + 1023, dest + i);
    }
    const run = await pair(image(p)); run.step(3000);
    const [a, b, ...rest] = values;
    const banks = [a & 254, a | 1, b & 254, b | 1, ...rest].map(v => v % 32);
    run.ram([...banks, ...banks.slice(4), ...banks.slice(0, 4)]);
  }
});

test('WASM MMC3 CHR RAM writes alias through bank selection', async () => {
  const p = program(); p.select(0, 3); p.select(2, 3);
  p.addr(0x400); p.write(0x2007, 0x5a); p.ppuRead(0x1000, 0);
  p.write(0x8000, 0x80); p.ppuRead(0, 1); p.ppuRead(0x1400, 2);
  const run = await pair(image(p, 0)); run.step(1000); run.ram([0x5a, 0x5a, 0x5a]);
});

test('WASM MMC3 mirroring honors four-screen boards and mapper-controlled layouts', async () => {
  for (const flags of [0, 8]) {
    const p = program(); p.write(0xa000, 0);
    for (let i = 0; i < 4; i++) { p.addr(0x2000 + i * 1024); p.write(0x2007, 11 * (i + 1)); }
    for (const [mode, dest] of [[0, 0], [1, 4]]) {
      p.write(0xa000, mode);
      for (let i = 0; i < 4; i++) p.ppuRead(0x2000 + i * 1024, dest + i);
    }
    const run = await pair(image(p, 0, flags)); run.step(2000);
    run.ram(flags ? [11,22,33,44,11,22,33,44] : [33,44,33,44,33,33,44,44]);
  }
});

test('WASM delivers MMC3 IRQ after CPU unmasking and acknowledges via $e000', async () => {
  const p = program(); p.write(0x4017, 0x40); p.write(0xc000, 1); p.write(0xc001, 0); p.write(0xe001, 0);
  // Keep I set for ~25K cycles while scanline clocks assert the IRQ.
  p.code.push(0xa0,20,0xa2,255,0xca,0xd0,0xfd,0x88,0xd0,0xf8,0x58);
  const run = await pair(image(p, 0)); run.step(1000);
  assert.equal(run.wasm.exports.ramRead(0x10), 0);
  run.step(30000); assert.equal(run.wasm.exports.ramRead(0x10), 1);
  run.step(30000); assert.equal(run.wasm.exports.ramRead(0x10), 1);
  assert.equal(run.wasm.exports.cpuRegister(3), 0xfd);
});

test('WASM MMC3 CHR inversion reaches background rendering and leaves ROM immutable', async () => {
  for (const mode of [0, 0x80]) {
    const p = program(); p.select(0, 1); p.select(2, 4); p.write(0x8000, mode);
    p.addr(8); p.write(0x2007, 0); // CHR ROM writes must be ignored.
    p.addr(0x3f00); for (const color of [0x0f, 0x2a, 0x16]) p.write(0x2007, color);
    p.write(0x2001, 10);
    const bytes = image(p, 1), chr = 16 + 0x20000;
    bytes.fill(0, chr); bytes.fill(255, chr, chr + 8); // R0 pair: color 1.
    bytes.fill(255, chr + 0x1008, chr + 0x1010); // R2: color 2.
    const run = await pair(bytes); run.step(60000);
    assert.equal(run.wasm.frame()[8], mode ? 0xffb53120 : 0xff5eea6f);
    run.wasm.reset();
    assert.equal(run.wasm.exports.chrRead(0), 255, 'reset restores CHR selectors');
    assert.equal(run.wasm.programCounter, 0xe000);
  }
});

test('MMC3 $A001 gates RAM reads and writes for every control byte in both builds', async () => {
  for (let control = 0; control < 256; control++) {
    const p = program(); p.read(0x6000, 6); p.write(0xa001, 0x80);
    p.write(0x6000, 0x12); p.write(0x7fff, 0x34);
    p.write(0xbfff, control); // Mirrored odd address selects RAM control.
    p.read(0x6000, 0); p.read(0x7fff, 1);
    p.write(0x6000, 0x56); p.write(0x7fff, 0x78);
    p.read(0x6000, 2); p.read(0x7fff, 3);
    p.write(0xa001, 0x80); p.read(0x6000, 4); p.read(0x7fff, 5);
    const run = await pair(image(p, 0)); run.step(1000);
    const enabled = !!(control & 0x80), writable = enabled && !(control & 0x40);
    run.ram([enabled ? 0x12 : 0, enabled ? 0x34 : 0,
      enabled ? (writable ? 0x56 : 0x12) : 0, enabled ? (writable ? 0x78 : 0x34) : 0,
      writable ? 0x56 : 0x12, writable ? 0x78 : 0x34]);
    run.js.write(0xa001, 0); // Re-disable only the JS side before reset.
    run.js.reset(); run.wasm.reset(); run.step(7);
    assert.equal(run.wasm.exports.ramRead(6), writable ? 0x56 : 0x12);
    assert.equal(run.js.read(6), writable ? 0x56 : 0x12);
  }
});

test('MMC3 snapshot restores RAM protection independently of IRQ state', () => {
  for (const control of [0, 0x40, 0x80, 0xc0]) for (const pending of [false, true]) {
    const nes = new Nes(image(program(), 0)); nes.reset();
    nes.write(0xa001, 0x80); nes.write(0x6000, 0x5a);
    nes.write(0xa001, control);
    if (pending) {
      nes.write(0xc000, 0); nes.write(0xe001, 0); nes.cartridge.clockScanline();
    }
    const saved = nes.saveState();
    nes.write(0xa001, 0x80); nes.write(0x6000, 0xff); nes.write(0xe000, 0);
    nes.loadState(saved);
    assert.equal(nes.cartridge.irqPending, pending);
    assert.equal(nes.read(0x6000), control & 0x80 ? 0x5a : 0);
    nes.write(0x6000, 0x33); nes.write(0xa001, 0x80);
    assert.equal(nes.read(0x6000), control === 0x80 ? 0x33 : 0x5a);
    nes.write(0xa001, 0); nes.reset();
    assert.equal(nes.read(0x6000), control === 0x80 ? 0x33 : 0x5a, 'reset preserves RAM and restores default access');
  }
});
