import assert from 'node:assert/strict';
import test from 'node:test';
import { Cpu6502 } from '../dist/index.js';
test('6502 executes indexed memory, ALU, flags, and branches', () => {
  const mem = new Uint8Array(65536); const bus={read:a=>mem[a&65535],write:(a,v)=>{mem[a&65535]=v&255;}};
  mem.set([0xa2,2,0xa9,3,0x95,0x10,0xa9,4,0x69,2,0x35,0x10,0x85,0x20,0xc9,9,0xd0,2,0xa9,0xff,0x00],0x8000); mem[0xfffc]=0; mem[0xfffd]=0x80;
  const cpu=new Cpu6502(bus); cpu.reset(); for(let i=0;i<9;i++)cpu.step(); assert.equal(mem[0x12],3); assert.equal(mem[0x20],2); assert.equal(cpu.a,2); assert.ok(!(cpu.p&2));
});
