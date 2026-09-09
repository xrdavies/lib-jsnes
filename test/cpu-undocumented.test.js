import assert from 'node:assert/strict';
import test from 'node:test';
import { Cpu6502 } from '../dist/index.js';

function machine(opcode, mode) {
  const ram = new Uint8Array(65536), writes = [];
  const cpu = new Cpu6502({ read: a => ram[a], write: (a, v) => { ram[a] = v; writes.push([a, v & 255]); } }, true);
  cpu.pc = 0x8000; cpu.a = 0x55; cpu.x = 3; cpu.y = 1; cpu.p = 0x65;
  let target = 0x600;
  let operands = [0, 6];
  if (mode === 'indX') { operands = [0xfc]; ram[0xff] = 0; ram[0] = 6; }
  if (mode === 'indY') { operands = [0xff]; ram[0xff] = 0xff; ram[0] = 5; }
  if (mode === 'absY') operands = [0xff, 5];
  if (mode === 'zp') { operands = [0x10]; target = 0x10; }
  if (mode === 'zpY') { operands = [0xff]; target = 0; }
  ram.set([opcode, ...operands], 0x8000);
  ram[target] = 0x81;
  return { cpu, ram, writes, target, nextPc: 0x8001 + operands.length };
}

test('stable LAX addressing modes load A/X, preserve C/V, and charge indexed page crossings', () => {
  for (const [opcode, mode, cycles] of [[0xa3, 'indX', 6], [0xa7, 'zp', 3], [0xaf, 'abs', 4],
    [0xb3, 'indY', 6], [0xb7, 'zpY', 4], [0xbf, 'absY', 5]]) {
    const { cpu, writes, nextPc } = machine(opcode, mode);
    assert.equal(cpu.step(), cycles);
    assert.deepEqual([cpu.a, cpu.x, cpu.p, cpu.pc], [0x81, 0x81, 0xe5, nextPc]);
    assert.deepEqual(writes, []);
  }
});

test('SAX stores A AND X without altering flags, including zero-page Y wrapping', () => {
  for (const [opcode, mode, cycles] of [[0x83, 'indX', 6], [0x87, 'zp', 3], [0x8f, 'abs', 4], [0x97, 'zpY', 4]]) {
    const { cpu, writes, target, nextPc } = machine(opcode, mode);
    assert.equal(cpu.step(), cycles);
    assert.deepEqual(writes, [[target, 1]]);
    assert.deepEqual([cpu.a, cpu.x, cpu.p, cpu.pc], [0x55, 3, 0x65, nextPc]);
  }
});

test('SHA and TAS use the high-byte mask and page-crossing address corruption', () => {
  for (const [opcode, indirect, cycles, nextPc] of [[0x93, true, 6, 0x8002], [0x9b, false, 5, 0x8003], [0x9f, false, 5, 0x8003]]) {
    const ram = new Uint8Array(65536), writes = [];
    const cpu = new Cpu6502({ read: address => ram[address], write: (address, value) => writes.push([address, value & 255]) }, true);
    cpu.pc = 0x8000; cpu.a = cpu.x = 1; cpu.y = 1; cpu.sp = 0xaa; cpu.p = 0x65;
    if (indirect) {
      ram.set([opcode, 0xff], 0x8000); ram[0xff] = 0xff; ram[0] = 0x12;
    } else ram.set([opcode, 0xff, 0x12], 0x8000);
    assert.equal(cpu.step(), cycles);
    assert.deepEqual(writes, [[0x0100, 1]]);
    assert.deepEqual([cpu.sp, cpu.p, cpu.pc], [opcode === 0x9b ? 1 : 0xaa, 0x65, nextPc]);
  }
});

test('indirect and absolute-Y RMW combinations preserve dummy writes and fixed cycles', () => {
  const operations = [
    [[0x03, 0x13, 0x1b], 0x02, 0x57, 0x65], // SLO: ASL then ORA.
    [[0x23, 0x33, 0x3b], 0x03, 0x01, 0x65], // RLA: ROL then AND.
    [[0x43, 0x53, 0x5b], 0x40, 0x15, 0x65], // SRE: LSR then EOR.
    [[0x63, 0x73, 0x7b], 0xc0, 0x16, 0x25], // RRA: ROR then ADC, with rotate carry.
    [[0xc3, 0xd3, 0xdb], 0x80, 0x55, 0xe4], // DCP: DEC then CMP.
    [[0xe3, 0xf3, 0xfb], 0x82, 0xd3, 0xe4], // ISC: INC then SBC.
  ];
  for (const [opcodes, result, a, p] of operations) for (const [i, mode] of ['indX', 'indY', 'absY'].entries()) {
    const { cpu, writes, target, nextPc } = machine(opcodes[i], mode);
    assert.equal(cpu.step(), i === 2 ? 7 : 8);
    assert.deepEqual(writes, [[target, 0x81], [target, result]]);
    assert.deepEqual([cpu.a, cpu.p, cpu.pc], [a, p, nextPc]);
  }
});
