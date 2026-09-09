import assert from 'node:assert/strict';
import test from 'node:test';
import { Cpu6502 } from '../dist/index.js';
test('6502 executes indexed memory, ALU, flags, and branches', () => {
  const mem = new Uint8Array(65536); const bus={read:a=>mem[a&65535],write:(a,v)=>{mem[a&65535]=v&255;}};
  mem.set([0xa2,2,0xa9,3,0x95,0x10,0xa9,4,0x69,2,0x35,0x10,0x85,0x20,0xc9,9,0xd0,2,0xa9,0xff,0x00],0x8000); mem[0xfffc]=0; mem[0xfffd]=0x80;
  const cpu=new Cpu6502(bus); cpu.reset(); for(let i=0;i<9;i++)cpu.step(); assert.equal(mem[0x12],3); assert.equal(mem[0x20],2); assert.equal(cpu.a,2); assert.ok(!(cpu.p&2));
});
test('6502 shifts and rotates carry through accumulator and memory', () => {
  const mem = new Uint8Array(65536); const bus={read:a=>mem[a&65535],write:(a,v)=>{mem[a&65535]=v&255;}};
  mem.set([0xa9,0x81,0x0a,0x2a,0x69,1,0x85,0x10,0x46,0x10,0x66,0x10,0x00],0x8000); mem[0xfffc]=0; mem[0xfffd]=0x80;
  const cpu=new Cpu6502(bus); cpu.reset(); for(let i=0;i<7;i++) cpu.step(); assert.equal(cpu.a,6); assert.equal(mem[0x10],1); assert.ok(cpu.p&1);
});
test('6502 exposes unknown opcode diagnostics without breaking stepping', () => {
  const mem = new Uint8Array(65536); const bus={read:a=>mem[a&65535],write:(a,v)=>{mem[a&65535]=v&255;}}; mem[0xfffc]=0; mem[0xfffd]=0x80; mem[0x8000]=0x02;
  const cpu=new Cpu6502(bus); cpu.reset(); cpu.step(); assert.equal(cpu.unknownOpcodes,1); assert.equal(cpu.lastUnknownOpcode,0x02);
});

test('6502 advances past a not-taken branch operand', () => {
  const mem=new Uint8Array(65536); const bus={read:a=>mem[a&65535],write:(a,v)=>{mem[a&65535]=v&255;}}; mem.set([0xf0,0x7f,0xa9,0x2a],0x8000); mem[0xfffc]=0; mem[0xfffd]=0x80; const cpu=new Cpu6502(bus); cpu.reset(); cpu.step(); cpu.step(); assert.equal(cpu.a,0x2a);
});

function machine(program = [], start = 0x8000) {
  const memory = new Uint8Array(0x10000);
  const writes = [];
  const cpu = new Cpu6502({
    read(address) { assert.ok(address >= 0 && address <= 0xffff); return memory[address]; },
    write(address, value) { assert.ok(address >= 0 && address <= 0xffff); writes.push([address, value & 255]); memory[address] = value; },
  });
  memory.set(program, start);
  cpu.pc = start;
  return { cpu, memory, writes };
}

test('all 151 official NMOS 6502 opcodes have an execution path', () => {
  const rows = [
    '00 01 05 06 08 09 0a 0d 0e', '10 11 15 16 18 19 1d 1e',
    '20 21 24 25 26 28 29 2a 2c 2d 2e', '30 31 35 36 38 39 3d 3e',
    '40 41 45 46 48 49 4a 4c 4d 4e', '50 51 55 56 58 59 5d 5e',
    '60 61 65 66 68 69 6a 6c 6d 6e', '70 71 75 76 78 79 7d 7e',
    '81 84 85 86 88 8a 8c 8d 8e', '90 91 94 95 96 98 99 9a 9d',
    'a0 a1 a2 a4 a5 a6 a8 a9 aa ac ad ae', 'b0 b1 b4 b5 b6 b8 b9 ba bc bd be',
    'c0 c1 c4 c5 c6 c8 c9 ca cc cd ce', 'd0 d1 d5 d6 d8 d9 dd de',
    'e0 e1 e4 e5 e6 e8 e9 ea ec ed ee', 'f0 f1 f5 f6 f8 f9 fd fe',
  ];
  const opcodes = rows.join(' ').split(' ').map(x => parseInt(x, 16));
  assert.equal(new Set(opcodes).size, 151);
  for (const opcode of opcodes) {
    const { cpu } = machine([opcode, 0, 0]);
    assert.ok(cpu.step() >= 2);
    assert.equal(cpu.unknownOpcodes, 0, `official opcode $${opcode.toString(16)}`);
  }
});

test('ADC and SBC match binary arithmetic for every operand and carry, with D set or clear', () => {
  const { cpu, memory } = machine();
  for (const opcode of [0x69, 0xe9]) {
    memory[0x8000] = opcode;
    for (let a = 0; a < 256; a++) for (let b = 0; b < 256; b++) for (let carry = 0; carry < 2; carry++) {
      const signedA = a < 128 ? a : a - 256, signedB = b < 128 ? b : b - 256;
      const value = opcode === 0x69 ? a + b + carry : a - b - (1 - carry);
      const signed = opcode === 0x69 ? signedA + signedB + carry : signedA - signedB - (1 - carry);
      const result = (value + 256) % 256;
      const flags = (result === 0 ? 2 : 0) | (result >= 128 ? 128 : 0)
        | (signed < -128 || signed > 127 ? 64 : 0)
        | (opcode === 0x69 ? (value > 255 ? 1 : 0) : (value >= 0 ? 1 : 0));
      for (const decimal of [0, 8]) {
        cpu.a = a; cpu.p = 0x24 | decimal | carry; cpu.pc = 0x8000;
        memory[0x8001] = b;
        assert.equal(cpu.step(), 2);
        assert.equal(cpu.a, result);
        assert.equal(cpu.p, 0x24 | decimal | flags);
      }
    }
  }
});

test('DEC absolute-X decrements memory and preserves A/C/V', () => {
  const { cpu, memory, writes } = machine([0xde, 0xff, 0x20]);
  cpu.x = 1; cpu.a = 0x77; cpu.p = 0x65; memory[0x2100] = 0;
  assert.equal(cpu.step(), 7);
  assert.equal(cpu.a, 0x77);
  assert.equal(cpu.p, 0xe5);
  assert.deepEqual(writes, [[0x2100, 0], [0x2100, 255]]);
  assert.equal(cpu.pc, 0x8003);
});

test('LDY absolute loads Y and sets only N/Z', () => {
  const { cpu, memory } = machine([0xac, 0x34, 0x12]);
  memory[0x1234] = 0x80; cpu.p = 0x67;
  assert.equal(cpu.step(), 4);
  assert.equal(cpu.y, 0x80);
  assert.equal(cpu.p, 0xe5);
});

test('indexed reads add one cycle across pages, including 16-bit address wrap', () => {
  const cases = [
    [0x1d, 'x'], [0x3d, 'x'], [0x5d, 'x'], [0x7d, 'x'], [0xbd, 'x'], [0xdd, 'x'], [0xfd, 'x'], [0xbc, 'x'],
    [0x19, 'y'], [0x39, 'y'], [0x59, 'y'], [0x79, 'y'], [0xb9, 'y'], [0xd9, 'y'], [0xf9, 'y'], [0xbe, 'y'], [0xbf, 'y'],
    [0x11, 'ind'], [0x31, 'ind'], [0x51, 'ind'], [0x71, 'ind'], [0xb1, 'ind'], [0xd1, 'ind'], [0xf1, 'ind'],
  ];
  for (const [opcode, mode] of cases) for (const base of [0x2000, 0x20ff, 0xffff]) {
    const { cpu, memory } = machine([opcode, base & 255, base >>> 8]);
    cpu.x = cpu.y = 1;
    if (mode === 'ind') {
      memory[0x8001] = 0xff;
      memory[0xff] = base & 255; memory[0] = base >>> 8;
    }
    // Keep the indirect pointer intact when the result wraps to zero.
    const address = (base + 1) & 0xffff;
    if (!(mode === 'ind' && address === 0)) memory[address] = 0x42;
    const used = cpu.step();
    assert.equal(used, (mode === 'ind' ? 5 : 4) + (base & 255 ? 1 : 0), `$${opcode.toString(16)} at $${base.toString(16)}`);
    assert.equal(cpu.cycles, used);
    if (opcode === 0xbd || opcode === 0xb9 || opcode === 0xb1) assert.equal(cpu.a, memory[address]);
  }
});

test('indexed stores have fixed cycle counts on both sides of a page boundary', () => {
  for (const opcode of [0x9d, 0x99, 0x91]) for (const low of [0, 255]) {
    const { cpu, memory } = machine([opcode, low, 0x20]); cpu.x = cpu.y = 1; cpu.a = 0x42;
    if (opcode === 0x91) { memory[0x8001] = 0x10; memory[0x10] = low; memory[0x11] = 0x20; }
    assert.equal(cpu.step(), opcode === 0x91 ? 6 : 5);
    assert.equal(memory[0x2001 + low], 0x42);
  }
});

test('every branch consumes its operand and charges only taken/page-cross cycles', () => {
  for (const [opcode, bit, whenSet] of [[0x10,128,false],[0x30,128,true],[0x50,64,false],[0x70,64,true],[0x90,1,false],[0xb0,1,true],[0xd0,2,false],[0xf0,2,true]]) {
    for (const taken of [false, true]) for (const [start, offset] of [[0x80fc, 4], [0x8100, 0xfc], [0x8000, 4]]) {
      const { cpu } = machine([opcode, offset], start);
      cpu.p = 0x24 & ~bit;
      if (taken === whenSet) cpu.p |= bit;
      const afterOperand = start + 2;
      const target = taken ? (afterOperand + (offset < 128 ? offset : offset - 256)) & 0xffff : afterOperand;
      const expected = taken ? 3 + ((afterOperand >>> 8) !== (target >>> 8) ? 1 : 0) : 2;
      assert.equal(cpu.step(), expected);
      assert.equal(cpu.pc, target);
    }
  }
});

test('ANC takes carry from the AND result and preserves overflow', () => {
  for (const opcode of [0x0b, 0x2b]) {
    const { cpu } = machine([opcode, 0x80]); cpu.a = 0; cpu.p = 0x65;
    assert.equal(cpu.step(), 2);
    assert.equal(cpu.a, 0);
    assert.equal(cpu.p, 0x66);
  }
});

test('RTS wraps a return address of $ffff to $0000', () => {
  const { cpu, memory } = machine([0x60]); cpu.sp = 0xfd; memory[0x1fe] = memory[0x1ff] = 255;
  assert.equal(cpu.step(), 6);
  assert.equal(cpu.pc, 0);
});
