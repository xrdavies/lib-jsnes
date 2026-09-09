import assert from 'node:assert/strict';
import test from 'node:test';
import { Nes } from '../dist/index.js';

function consoleWithNmiHandler() {
  const bytes = new Uint8Array(16 + 0x4000);
  bytes.set([78, 69, 83, 26, 1, 0]);
  bytes.set([0x4c, 0x00, 0x80], 16); // JMP $8000
  bytes.set([0xe6, 0x10, 0x40], 16 + 0x100); // INC $10; RTI
  bytes.set([0x00, 0x81, 0x00, 0x80, 0x00, 0x81], 16 + 0x3ffa);
  const nes = new Nes(bytes);
  nes.reset();
  return nes;
}

test('NMI fires at scanline 241 dot 1 once, not on every scanline', () => {
  const { ppu } = consoleWithNmiHandler();
  ppu.writeRegister(0, 0x80);
  for (let line = 0; line < 241; line++) {
    ppu.step(341);
    assert.equal(ppu.consumeNmi(), false, `unexpected NMI on line ${line}`);
  }
  assert.equal(ppu.readRegister(2) & 0x80, 0);
  ppu.step(1);
  assert.equal(ppu.consumeNmi(), true);
  assert.equal(ppu.consumeNmi(), false);
  assert.equal(ppu.readRegister(2) & 0x80, 0x80);
  assert.equal(ppu.readRegister(2) & 0x80, 0);
  ppu.step(21 * 341 - 1);
  assert.equal(ppu.consumeNmi(), false);
  ppu.step(241 * 341 + 1);
  assert.equal(ppu.consumeNmi(), true);
});

test('NMI output reacts to a rising enable edge only while VBlank is set', () => {
  const { ppu } = consoleWithNmiHandler();
  ppu.step(241 * 341 + 1);
  assert.equal(ppu.consumeNmi(), false);
  ppu.writeRegister(0, 0x80);
  assert.equal(ppu.consumeNmi(), true);
  ppu.writeRegister(0, 0x80);
  assert.equal(ppu.consumeNmi(), false);
  ppu.writeRegister(0, 0);
  ppu.writeRegister(0, 0x80);
  assert.equal(ppu.consumeNmi(), true);
  ppu.readRegister(2); // Clear VBlank, then toggle again.
  ppu.writeRegister(0, 0);
  ppu.writeRegister(0, 0x80);
  assert.equal(ppu.consumeNmi(), false);
});

test('VBlank clears at pre-render dot 1 and reset clears pending NMI', () => {
  const { ppu } = consoleWithNmiHandler();
  ppu.writeRegister(0, 0x80);
  ppu.step(261 * 341);
  assert.equal(ppu.readRegister(2) & 0x80, 0x80);
  ppu.reset();
  ppu.writeRegister(0, 0x80);
  ppu.step(261 * 341 + 1);
  assert.equal(ppu.readRegister(2) & 0xe0, 0);
  ppu.reset();
  assert.equal(ppu.consumeNmi(), false);
  assert.equal(ppu.consumeScanlines(), 0);
});

test('Nes executes the NMI handler once per frame and RTI returns to the main loop', () => {
  const nes = consoleWithNmiHandler();
  nes.write(0x2000, 0x80);
  nes.step(28000);
  assert.equal(nes.read(0x10), 1);
  assert.equal(nes.cpu.sp, 0xfd);
  assert.equal(nes.cpu.pc, 0x8000);
  nes.step(29781);
  assert.equal(nes.read(0x10), 2);
  assert.equal(nes.cpu.sp, 0xfd);
});
