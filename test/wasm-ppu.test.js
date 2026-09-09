import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Nes, WasmCore } from '../dist/index.js';

const binary = await readFile(new URL('../dist-wasm/lib-jsnes.wasm', import.meta.url));
function scene({ chrRom = false, flags = 1, mask = 0x1e, scroll = 0, spriteControl = 0 } = {}) {
  const code = [];
  const write = (address, value) => code.push(0xa9, value, 0x8d, address & 255, address >>> 8);
  const ppu = (address, values) => {
    write(0x2006, address >>> 8); write(0x2006, address & 255);
    for (const value of values) write(0x2007, value);
  };
  ppu(0, [...Array(8).fill(255), ...Array(8).fill(0), ...Array(8).fill(255), ...Array(8).fill(0)]);
  ppu(0x2000, [0]); ppu(0x2400, [1]); ppu(0x2800, [0]); ppu(0x2c00, [1]);
  ppu(0x3f00, [0x0f, 0x2a]); ppu(0x3f11, [0x16]);
  // One sprite at (20,20); the remaining zero-filled sprites are outside that row.
  for (const [i, v] of [19, 1, 0, 20].entries()) write(0x200 + i, v);
  write(0x2003, 0); write(0x4014, 2);
  write(0x2005, scroll); write(0x2005, 0);
  write(0x2000, spriteControl); write(0x2001, mask);
  const loop = 0x8000 + code.length; code.push(0x4c, loop & 255, loop >>> 8);
  const rom = new Uint8Array(16 + 0x4000 + (chrRom ? 0x2000 : 0));
  rom.set([78, 69, 83, 26, 1, +chrRom, flags]); rom.set(code, 16);
  rom.set([0, 0x80], 16 + 0x3ffc);
  if (chrRom) {
    // Plane 1 makes color index 2; CPU writes of plane 0 must be ignored.
    rom.fill(255, 16 + 0x4000 + 8, 16 + 0x4000 + 16);
  }
  return rom;
}
async function compare(rom, cycles = 90000) {
  const js = new Nes(rom), wasm = await WasmCore.from(binary);
  js.reset(); wasm.loadRom(rom); wasm.reset();
  js.step(cycles); wasm.step(cycles);
  assert.equal(wasm.cycleCount, js.cycleCount);
  assert.equal(wasm.programCounter, js.cpu.pc);
  assert.equal(wasm.exports.unknownOpcodeCount(), 0);
  assert.deepEqual(wasm.frame(), js.frame);
  return { js, wasm };
}

test('WASM renders CHR RAM background and OAM DMA sprites through CPU register writes', async () => {
  const { wasm } = await compare(scene());
  assert.equal(wasm.frame()[8], 0xff5eea6f);
  assert.equal(wasm.frame()[20 * 256 + 20], 0xffb53120);
});

test('WASM PPU matches masking, scrolling, sprite size, and color controls', async () => {
  for (const options of [{ mask: 0 }, { mask: 0x18 }, { mask: 0xff },
    { scroll: 252 }, { spriteControl: 0x20 }, { flags: 0 }, { flags: 8 }, { chrRom: true }]) {
    await compare(scene(options));
  }
});

test('WASM NMI executes once per frame and RTI returns without leaking stack entries', async () => {
  const rom = new Uint8Array(16 + 0x4000);
  rom.set([78, 69, 83, 26, 1, 0]);
  rom.set([0xa9, 0x80, 0x8d, 0, 0x20, 0x4c, 5, 0x80], 16);
  rom.set([0xe6, 0x10, 0x40], 16 + 0x100);
  rom.set([0, 0x81, 0, 0x80], 16 + 0x3ffa);
  const { wasm } = await compare(rom, 60000);
  assert.equal(wasm.exports.ramRead(0x10), 2);
  assert.equal(wasm.exports.cpuRegister(3), 0xfd);
});

function registerRom(build) {
  const code = [];
  const write = (address, value) => code.push(0xa9, value, 0x8d, address & 255, address >>> 8);
  const read = (address, destination) => code.push(0xad, address & 255, address >>> 8, 0x85, destination);
  build(write, read);
  const loop = 0x8000 + code.length; code.push(0x4c, loop & 255, loop >>> 8);
  const rom = new Uint8Array(16 + 0x4000);
  rom.set([78, 69, 83, 26, 1, 0]); rom.set(code, 16); rom.set([0, 0x80], 16 + 0x3ffc);
  return rom;
}

test('OAMDATA wraps after $ff on both cores instead of indexing beyond OAM', async () => {
  const rom = registerRom((write, read) => {
    write(0x2003, 255); write(0x2004, 0x12); write(0x2004, 0x34);
    write(0x2003, 255); read(0x2004, 0);
    write(0x2003, 0); read(0x2004, 1);
  });
  const { wasm, js } = await compare(rom, 1000);
  assert.deepEqual([wasm.exports.ramRead(0), wasm.exports.ramRead(1)], [0x12, 0x34]);
  assert.deepEqual([js.read(0), js.read(1)], [0x12, 0x34]);
});

test('WASM nametable reads obey horizontal, vertical, and four-screen mirroring', async () => {
  for (const [flags, expected] of [[0, [22, 22, 44, 44]], [1, [33, 44, 33, 44]], [8, [11, 22, 33, 44]]]) {
    const rom = registerRom((write, read) => {
      for (let i = 0; i < 4; i++) { write(0x2006, 0x20 + i * 4); write(0x2006, 0); write(0x2007, 11 * (i + 1)); }
      for (let i = 0; i < 4; i++) {
        write(0x2006, 0x20 + i * 4); write(0x2006, 0);
        read(0x2007, 0x10); read(0x2007, i); // Discard the buffered read.
      }
    });
    rom[6] = flags;
    const { wasm } = await compare(rom, 1000);
    assert.deepEqual([0, 1, 2, 3].map(i => wasm.exports.ramRead(i)), expected);
  }
});

test('replacing a WASM cartridge clears the previous PPU memory', async () => {
  const { wasm } = await compare(scene());
  const replacement = registerRom((write, read) => {
    write(0x2006, 0x3f); write(0x2006, 1); read(0x2007, 0);
    write(0x2003, 0); read(0x2004, 1);
  });
  wasm.loadRom(replacement); wasm.reset(); wasm.step(1000);
  assert.equal(wasm.exports.ramRead(0), 0);
  assert.equal(wasm.exports.ramRead(1), 0);
});
