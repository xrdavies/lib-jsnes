import assert from 'node:assert/strict';
import test from 'node:test';
import { Cpu6502 } from '../dist/index.js';

function machine(code, start = 0x8000) {
  const memory = new Uint8Array(65536), accesses = [];
  code.forEach((v, i) => { memory[(start + i) & 65535] = v; });
  const cpu = new Cpu6502({ read(a) { accesses.push(['r', a]); return memory[a]; },
    write(a, v) { accesses.push(['w', a, v]); memory[a] = v; } }, true);
  cpu.pc = start;
  return { cpu, memory, accesses };
}

test('JSR reads the high target byte after pushing its return address, including stack overlap', () => {
  const { cpu, accesses } = machine([0x20, 0x34, 0x92]);
  assert.equal(cpu.step(), 6); assert.equal(cpu.pc, 0x9234);
  assert.deepEqual(accesses, [['r', 0x8000], ['r', 0x8001], ['r', 0x1fd],
    ['w', 0x1fd, 0x80], ['w', 0x1fc, 2], ['r', 0x8002]]);
  const overlap = machine([0x20, 0x34, 0x92], 0x1fb);
  overlap.cpu.step();
  assert.equal(overlap.cpu.pc, 0x0134, 'stack write replaces target high byte before it is fetched');
});

test('RTS and RTI discard instruction/stack reads and wrap the stack pointer', () => {
  for (const sp of [0xfc, 0xff]) for (const opcode of [0x60, 0x40]) {
    const { cpu, memory, accesses } = machine([opcode, 0xea]); cpu.sp = sp;
    const stack = i => 0x100 | ((sp + i) & 255);
    const data = opcode === 0x60 ? [0xff, 0xff] : [0xff, 0x34, 0x92];
    data.forEach((v, i) => { memory[stack(i + 1)] = v; });
    assert.equal(cpu.step(), 6);
    assert.deepEqual(accesses, [['r', 0x8000], ['r', 0x8001], ['r', stack(0)],
      ...data.map((_, i) => ['r', stack(i + 1)]), ...(opcode === 0x60 ? [['r', 0xffff]] : [])]);
    assert.equal(cpu.pc, opcode === 0x60 ? 0 : 0x9234);
    assert.equal(cpu.sp, (sp + data.length) & 255);
    if (opcode === 0x40) assert.equal(cpu.p, 0xef);
  }
});

test('stack pushes and pulls preserve dummy reads and status flag semantics', () => {
  for (const opcode of [0x48, 0x08, 0x68, 0x28]) {
    const { cpu, memory, accesses } = machine([opcode, 0xea]);
    cpu.sp = 0xff; cpu.a = 0x81; cpu.p = 0x25; memory[0x100] = 0xc3;
    const pull = opcode === 0x68 || opcode === 0x28;
    assert.equal(cpu.step(), pull ? 4 : 3);
    assert.deepEqual(accesses, [['r', 0x8000], ['r', 0x8001], ...(pull
      ? [['r', 0x1ff], ['r', 0x100]] : [['w', 0x1ff, opcode === 0x48 ? 0x81 : 0x35]])]);
    assert.equal(cpu.sp, pull ? 0 : 0xfe);
    if (opcode === 0x68) assert.equal(cpu.a, 0xc3);
    if (opcode === 0x28) assert.equal(cpu.p, 0xe3);
  }
});

test('BRK reads its padding byte while IRQ/NMI discard two reads without advancing PC', () => {
  for (const kind of ['brk', 'irq', 'nmi']) {
    const { cpu, memory, accesses } = machine([0, 0xea], 0xfffe);
    cpu.p = 0x21;
    const vector = kind === 'nmi' ? 0xfffa : 0xfffe;
    memory[vector] = 0; memory[vector + 1] = 0x90;
    if (kind === 'brk') assert.equal(cpu.step(), 7);
    else assert.equal(cpu[kind](), true);
    const returnedPc = kind === 'brk' ? 0 : 0xfffe;
    assert.deepEqual(accesses, [['r', 0xfffe], ['r', kind === 'brk' ? 0xffff : 0xfffe],
      ['w', 0x1fd, returnedPc >>> 8], ['w', 0x1fc, returnedPc & 255],
      ['w', 0x1fb, kind === 'brk' ? 0x31 : 0x21], ['r', vector], ['r', vector + 1]]);
    assert.equal(cpu.pc, 0x9000); assert.equal(cpu.p, 0x25);
  }
  const masked = machine([0xea]);
  assert.equal(masked.cpu.irq(), false); assert.deepEqual(masked.accesses, []);
});
