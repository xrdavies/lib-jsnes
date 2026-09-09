import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Nes, WasmCore } from '../dist/index.js';

const binary = await readFile(new URL('../dist-wasm/lib-jsnes.wasm', import.meta.url));
const windows = [0x8000, 0xa000, 0xc000, 0xe000];
function rom(program = [], banks = 16) {
  const bytes = new Uint8Array(16 + banks * 0x4000);
  bytes.set([78, 69, 83, 26, banks, 0, 0xf0, 0]);
  for (let bank = 0; bank < banks * 2; bank++) {
    const start = 16 + bank * 0x2000;
    bytes.fill(bank, start, start + 0x2000);
    // Identical code in each bank keeps execution valid after a mapper write.
    bytes.set(program, start + 0x100);
    bytes.set([0, 0x81], start + 0x1ffc);
  }
  return bytes;
}

test('mapper 15 CPU reads all four PRG windows for every register byte in both cores', async () => {
  const core = await WasmCore.from(binary);
  for (const banks of [1, 16]) for (const register of [0x8000, 0x8001, 0x8002, 0x8003, 0xfffe, 0xffff]) {
    // X sweeps all register values; each window's marker is stored in PRG RAM.
    const program = [0xa2, 0, 0x8a, 0x8d, register & 255, register >>> 8];
    for (let slot = 0; slot < 4; slot++) program.push(0xad, 0, windows[slot] >>> 8, 0x9d, 0, 0x60 + slot);
    program.push(0xe8, 0xd0, (2 - (program.length + 3)) & 255);
    const stop = 0x8100 + program.length;
    program.push(0x4c, stop & 255, stop >>> 8);
    const bytes = rom(program, banks), js = new Nes(bytes);
    js.reset(); core.loadRom(bytes); core.reset();
    js.step(14000); core.step(14000);
    assert.equal(js.cpu.pc, stop); assert.equal(core.programCounter, stop);
    const output = core.saveBatteryRam();
    for (let value = 0; value < 256; value++) {
      const bank = value & 63;
      // Independent per-mode window tables; values are 8 KiB bank signatures.
      const expected = [
        [2 * bank, 2 * bank + 1, 2 * bank + 2, 2 * bank + 3],
        [2 * bank, 2 * bank + 1, 2 * (bank | 7), 2 * (bank | 7) + 1],
        Array(4).fill(2 * bank + (value >>> 7)),
        [2 * bank, 2 * bank + 1, 2 * bank, 2 * bank + 1],
      ][register & 3].map(b => b % (banks * 2));
      for (let slot = 0; slot < 4; slot++) {
        const at = slot * 256 + value;
        assert.equal(js.cartridge.prgRam[at], expected[slot], `TS ${register.toString(16)}:${value}:${slot}`);
        assert.equal(output[at], expected[slot], `WASM ${register.toString(16)}:${value}:${slot}`);
      }
    }
    assert.equal(core.exports.unknownOpcodeCount(), 0);
  }
});

test('mapper 15 snapshots retain mode, mirroring and CHR write protection; reset retains RAM', () => {
  const nes = new Nes(rom());
  for (const mode of [0, 1, 2, 3]) {
    nes.write(0x8001, 0);
    nes.cartridge.writeChr(0, 0x42);
    nes.write(0x8000 + mode, 0xc1);
    nes.write(0x6000, 0x37);
    const state = nes.saveState(), mapped = windows.map(a => nes.read(a));
    nes.write(0x8002, 4); nes.cartridge.writeChr(0, 0);
    nes.loadState(state);
    assert.deepEqual(windows.map(a => nes.read(a)), mapped);
    assert.equal(nes.cartridge.mirroring, 'horizontal');
    nes.cartridge.writeChr(0, 0x68);
    assert.equal(nes.cartridge.readChr(0), mode === 3 ? 0x42 : 0x68);
    const legacy = nes.cartridge.saveState(); legacy[23] = 13;
    assert.throws(() => nes.cartridge.loadState(legacy), /Invalid cartridge state/);
    nes.reset();
    assert.deepEqual(windows.map(a => nes.read(a)), [0, 1, 2, 3]);
    assert.equal(nes.cartridge.mirroring, 'vertical');
    assert.equal(nes.read(0x6000), 0x37);
    nes.cartridge.writeChr(0, 0x79);
    assert.equal(nes.cartridge.readChr(0), 0x79);
  }
});

test('mapper 15 CPU-driven PPU writes honor nametable mirroring and CHR protection in WASM', async () => {
  const core = await WasmCore.from(binary);
  for (const mode of [0, 1, 2, 3]) for (const horizontal of [false, true]) {
    const program = [];
    const write = (address, value) => program.push(0xa9, value, 0x8d, address & 255, address >>> 8);
    const address = at => { write(0x2006, at >>> 8); write(0x2006, at & 255); };
    const ppuWrite = (at, value) => { address(at); write(0x2007, value); };
    write(0x8001, 0); ppuWrite(0, 0x42);
    write(0x8000 + mode, horizontal ? 0x40 : 0);
    ppuWrite(0, 0x68);
    ppuWrite(0x2000, 1); ppuWrite(0x2400, 2); ppuWrite(0x2800, 3); ppuWrite(0x2c00, 4);
    for (let slot = 0; slot < 4; slot++) {
      address(0x2000 + slot * 0x400);
      program.push(0xad, 7, 0x20, 0xad, 7, 0x20, 0x85, slot);
    }
    const stop = 0x8100 + program.length;
    program.push(0x4c, stop & 255, stop >>> 8);
    const bytes = rom(program), js = new Nes(bytes);
    js.reset(); core.loadRom(bytes); core.reset();
    js.step(2000); core.step(2000);
    const expected = horizontal ? [2, 2, 4, 4] : [3, 4, 3, 4];
    assert.deepEqual(expected.map((_, i) => js.read(i)), expected);
    assert.deepEqual(expected.map((_, i) => core.exports.ramRead(i)), expected);
    assert.equal(core.exports.chrRead(0), mode === 3 ? 0x42 : 0x68);
    core.reset();
    assert.equal(core.exports.chrRead(0), mode === 3 ? 0x42 : 0x68);
  }
});
