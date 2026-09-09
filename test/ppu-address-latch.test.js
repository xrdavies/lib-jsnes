import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Nes, WasmCore, PPU_STATE_SIZE } from '../dist/index.js';

function rom(code = []) {
  const bytes = new Uint8Array(16 + 16384); bytes.set([78, 69, 83, 26, 1, 0, 8]);
  bytes.set(code, 16); bytes.set([0, 0x80], 16 + 16384 - 4); return bytes;
}
function address(ppu, at) { ppu.readRegister(2); ppu.writeRegister(6, at >>> 8); ppu.writeRegister(6, at & 255); }

test('first PPUADDR write leaves active VRAM address intact and snapshots retain the pending high byte', () => {
  const nes = new Nes(rom()); nes.reset(); const ppu = nes.ppu;
  address(ppu, 0x2300); ppu.writeRegister(6, 0x24);
  ppu.writeRegister(7, 0x55); assert.equal(ppu.vram[0x2300], 0x55);
  assert.equal(ppu.vram[0x2400], 0);
  const saved = nes.saveState();
  ppu.writeRegister(6, 0x10); ppu.writeRegister(7, 0x79);
  assert.equal(ppu.vram[0x2410], 0x79);
  const expected = nes.saveState(); nes.reset(); nes.loadState(saved);
  ppu.writeRegister(6, 0x10); ppu.writeRegister(7, 0x79);
  assert.deepEqual(nes.saveState(), expected);
  const invalid = ppu.saveState(); invalid[PPU_STATE_SIZE - 3] = 0x80;
  assert.throws(() => ppu.loadState(invalid), /Invalid PPU state/);
});

test('PPUCTRL and PPUSCROLL update temporary address fields and share the PPUADDR toggle', () => {
  const ppu = new Nes(rom()).ppu;
  const temporary = () => new DataView(ppu.saveState().buffer).getUint16(PPU_STATE_SIZE - 4, true);
  ppu.writeRegister(0, 3); assert.equal(temporary(), 0x0c00);
  ppu.writeRegister(5, 0xa7); assert.equal(temporary(), 0x0c14);
  ppu.writeRegister(5, 0xb3); assert.equal(temporary(), 0x3ed4);
  ppu.writeRegister(6, 0xff); assert.equal(temporary(), 0x3fd4, 'first address write masks the top two data bits');
  ppu.readRegister(2); // Resets toggle, retaining temporary address.
  assert.equal(temporary(), 0x3fd4);
  ppu.writeRegister(6, 0x20);
  ppu.writeRegister(0, 2); assert.equal(temporary(), 0x28d4);
  ppu.writeRegister(6, 0x55); ppu.writeRegister(7, 0x63);
  assert.equal(ppu.vram[0x2855], 0x63);
  assert.equal(temporary(), 0x2855, 'PPUDATA increments only the active address');
  ppu.writeRegister(5, 24); // First scroll write, followed by second address write.
  ppu.writeRegister(6, 0x66); ppu.writeRegister(7, 0x72);
  assert.equal(ppu.vram[0x2866], 0x72);
});

test('CPU-driven interleaved address writes have matching data-port results in WASM', async () => {
  const code = [], expected = [];
  const write = (a, v) => code.push(0xa9, v, 0x8d, a & 255, a >>> 8);
  const addr = a => { code.push(0xad, 2, 0x20); write(0x2006, a >>> 8); write(0x2006, a & 255); };
  const check = (a, value) => {
    addr(a); code.push(0xad, 7, 0x20, 0xad, 7, 0x20, 0x85, expected.length); expected.push(value);
  };
  addr(0x2300); write(0x3ffe, 0x24); write(0x2007, 0x55);
  write(0x2006, 0x10); write(0x2007, 0x79);
  check(0x2300, 0x55); check(0x2400, 0); check(0x2410, 0x79);
  write(0x2006, 0x20); write(0x2000, 3); write(0x2006, 0x55); write(0x2007, 0x63);
  check(0x2c55, 0x63);
  write(0x2005, 24); write(0x2006, 0x66); write(0x2007, 0x72);
  check(0x2c66, 0x72);
  const end = 0x8000 + code.length; code.push(0x4c, end & 255, end >>> 8);
  const bytes = rom(code), js = new Nes(bytes), wasm = await WasmCore.from(await readFile('dist-wasm/lib-jsnes.wasm'));
  js.reset(); wasm.loadRom(bytes); wasm.reset(); js.step(1000); wasm.step(1000);
  assert.deepEqual(expected.map((_, i) => js.read(i)), expected);
  assert.deepEqual(expected.map((_, i) => wasm.exports.ramRead(i)), expected);
  assert.equal(wasm.cycleCount, js.cycleCount); assert.equal(wasm.programCounter, js.cpu.pc);
});
