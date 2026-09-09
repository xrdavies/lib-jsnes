import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Cpu6502, WasmCore } from '../dist/index.js';

const binary = await readFile(new URL('../dist-wasm/lib-jsnes.wasm', import.meta.url));
const nz = value => (value === 0 ? 2 : 0) + (value >= 128 ? 128 : 0);

for (const [opcode, name] of [[0x4b, 'ALR'], [0x6b, 'ARR'], [0xab, 'LAX'], [0xcb, 'AXS']]) {
  test(`${name} immediate matches all operand pairs and carry/decimal inputs in both cores`, async () => {
    const rom = new Uint8Array(16 + 0x4000);
    rom.set([78, 69, 83, 26, 1, 0]);
    // Set X and P, load A, execute the instruction and return to the next probe.
    rom.set([0xa2, 255, 0xa9, 0, 0x48, 0x28, 0xa9, 0, opcode, 0, 0x4c, 0, 0x80], 16);
    rom.set([0, 0x80], 16 + 0x3ffc);
    const core = await WasmCore.from(binary); core.loadRom(rom); core.reset();
    const cpu = new Cpu6502({ read: a => rom[16 + (a & 0x3fff)], write() { assert.fail('unexpected write'); } }, true);
    for (const decimal of [0, 8]) for (const carry of [0, 1]) {
      const control = 0x64 | decimal | carry;
      core.exports.romWrite(19, control);
      for (let a = 0; a < 256; a++) for (let operand = 0; operand < 256; operand++) {
        core.exports.romWrite(23, a); core.exports.romWrite(25, operand);
        rom[25] = operand;
        const flags = (control & ~0x82) | nz(a);
        cpu.pc = 0x8008; cpu.a = a; cpu.x = 255; cpu.p = flags; cpu.cycles = 0;
        assert.equal(cpu.step(), 2); assert.equal(cpu.pc, 0x800a);
        const before = core.cycleCount; core.step(18);
        assert.equal(core.cycleCount, before + 18); assert.equal(core.programCounter, 0x8000);
        let result, expectedA = a, expectedX = 255, expectedFlags;
        if (opcode === 0x4b) {
          const masked = a & operand; result = Math.floor(masked / 2); expectedA = result;
          expectedFlags = (flags & ~0x83) | nz(result) | (masked % 2);
        } else if (opcode === 0x6b) {
          result = Math.floor((a & operand) / 2) + carry * 128; expectedA = result;
          const bit6 = Math.floor(result / 64) % 2, bit5 = Math.floor(result / 32) % 2;
          expectedFlags = (flags & ~0xc3) | nz(result) | bit6 | (bit6 !== bit5 ? 64 : 0);
        } else if (opcode === 0xab) {
          expectedA = expectedX = operand;
          expectedFlags = (flags & ~0x82) | nz(operand);
        } else {
          const difference = a - operand; result = (difference + 256) % 256; expectedX = result;
          expectedFlags = (flags & ~0x83) | nz(result) | (difference >= 0 ? 1 : 0);
        }
        assert.equal(cpu.a, expectedA); assert.equal(cpu.x, expectedX); assert.equal(cpu.p, expectedFlags);
        assert.equal(core.exports.cpuRegister(0), expectedA);
        assert.equal(core.exports.cpuRegister(1), expectedX);
        assert.equal(core.exports.cpuRegister(4), expectedFlags);
      }
    }
    assert.equal(cpu.unknownOpcodes, 0); assert.equal(core.exports.unknownOpcodeCount(), 0);
  });
}

test('AXS masks A and X before subtracting, preserves A/V, and ignores incoming carry', () => {
  const memory = Uint8Array.of(0xcb, 0);
  const cpu = new Cpu6502({ read: a => memory[a], write() { assert.fail('unexpected write'); } }, true);
  for (let a = 0; a < 256; a++) for (let x = 0; x < 256; x++) {
    const operand = (a * 13 + x * 17) & 255; memory[1] = operand;
    cpu.pc = 0; cpu.a = a; cpu.x = x; cpu.p = 0x6d;
    cpu.step();
    const difference = (a & x) - operand, result = (difference + 256) % 256;
    assert.equal(cpu.a, a); assert.equal(cpu.x, result);
    assert.equal(cpu.p, 0x6c | nz(result) | (difference >= 0 ? 1 : 0));
  }
});
