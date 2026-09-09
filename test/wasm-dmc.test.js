import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Nes, WasmCore } from '../dist/index.js';
const binary = await readFile(new URL('../dist-wasm/lib-jsnes.wasm', import.meta.url));
function rom({ loop = false, irq = false, rate = 15, oam = false } = {}) {
  const code = [], write = (a, v) => code.push(0xa9, v, 0x8d, a & 255, a >>> 8);
  write(0x4017, 0x40); write(0x4010, rate | (loop ? 0x40 : 0) | (irq ? 0x80 : 0));
  write(0x4011, 64); write(0x4012, 0); write(0x4013, 4); write(0x4015, 16);
  if (irq) code.push(0x58);
  const target = 0x8000 + code.length;
  if (oam) write(0x4014, 2);
  code.push(0x4c, target & 255, target >>> 8);
  const bytes = new Uint8Array(16 + 0x8000); bytes.set([78, 69, 83, 26, 2, 0]); bytes.set(code, 16);
  for (let i = 0; i < 65; i++) bytes[16 + 0x4000 + i] = (i * 37) & 255;
  bytes.set([0xad, 0x15, 0x40, 0x85, 0x10, 0xe6, 0x11, 0xa9, 0, 0x8d, 0x15, 0x40, 0x40], 16 + 0x100);
  bytes.set([0, 0x81, 0, 0x80, 0, 0x81], 16 + 0x7ffa);
  return bytes;
}

test('DMC PCM and CPU stalls agree across JS/WASM for all rates, looping and OAM overlap', async () => {
  for (let rate = 0; rate < 16; rate++) {
    const image = rom({ rate, loop: true, oam: !!(rate & 1) });
    const js = new Nes(image), wasm = await WasmCore.from(binary); js.reset(); wasm.loadRom(image); wasm.reset();
    for (const budget of [1000, 30000, 70000]) {
      js.step(budget); wasm.step(budget);
      assert.equal(wasm.cycleCount, js.cycleCount); assert.equal(wasm.programCounter, js.cpu.pc);
      assert.deepEqual(wasm.frame(), js.frame);
      const pcm = js.audioSamples(); assert.deepEqual(wasm.audioSamples(), pcm);
      if (budget === 70000) assert.ok(new Set(pcm).size > 1);
    }
    assert.equal(wasm.exports.unknownOpcodeCount(), 0);
  }
});

test('DMC completion enters CPU IRQ once and $4015 acknowledges it in both cores', async () => {
  const image = rom({ irq: true }), js = new Nes(image), wasm = await WasmCore.from(binary);
  js.reset(); wasm.loadRom(image); wasm.reset(); js.step(40000); wasm.step(40000);
  assert.equal(js.read(0x10) & 0x90, 0x80); assert.equal(wasm.exports.ramRead(0x10) & 0x90, 0x80);
  assert.equal(js.read(0x11), 1); assert.equal(wasm.exports.ramRead(0x11), 1);
  assert.equal(js.cpu.sp, 0xfd); assert.equal(wasm.exports.cpuRegister(3), 0xfd);
  assert.deepEqual(wasm.audioSamples(), js.audioSamples());
});

test('each DMC fetch adds four CPU stall cycles and snapshots preserve a pending fetch stall', () => {
  const bytes = rom(); const js = new Nes(bytes); js.reset();
  // Enable a one-byte sample via host writes before the first instruction.
  js.write(0x4010, 15); js.write(0x4012, 0); js.write(0x4013, 0); js.write(0x4015, 16);
  js.step(1); assert.equal(js.cycleCount, 2); const pc = js.cpu.pc;
  const snapshot = js.saveState(); js.audioSamples();
  js.step(4); assert.equal(js.cpu.pc, pc); assert.equal(js.cycleCount, 6);
  js.step(1); assert.equal(js.cycleCount, 10); // STA absolute, four cycles.
  const target = new Nes(bytes); target.reset(); target.loadState(snapshot); target.step(5);
  assert.equal(target.cycleCount, js.cycleCount); assert.equal(target.cpu.pc, js.cpu.pc);
  assert.deepEqual(target.audioSamples(), js.audioSamples());
});

test('Nes DMC snapshots reproduce active sample output and mapper state', () => {
  const bytes = rom({ loop: true }), js = new Nes(bytes); js.reset(); js.step(7319); js.audioSamples();
  const state = js.saveState(); js.step(90000); const pcm = js.audioSamples(), final = js.saveState();
  js.reset(); js.loadState(state); js.step(90000);
  assert.deepEqual(js.audioSamples(), pcm); assert.equal(Buffer.compare(js.saveState(), final), 0);
});

test('DMC reads current mapper banks after address wrap in both builds', async () => {
  const bytes = new Uint8Array(16 + 0x10000); bytes.set([78,69,83,26,4,0,0x20]);
  for (let i=0;i<4;i++) bytes.fill(0x40+i,16+i*0x4000,16+(i+1)*0x4000);
  const code=[],write=(a,v)=>code.push(0xa9,v,0x8d,a&255,a>>>8);
  write(0x8000,2);write(0x4017,0x40);write(0x4010,15);write(0x4011,64);
  write(0x4012,255);write(0x4013,4);write(0x4015,16);
  const loop=0xc100+code.length;code.push(0x4c,loop&255,loop>>>8);
  bytes.set(code,16+0xc100);bytes.set([0,0xc1],16+0xfffc);
  const js=new Nes(bytes),wasm=await WasmCore.from(binary);js.reset();wasm.loadRom(bytes);wasm.reset();
  const reads=[],read=js.readDmc.bind(js);js.readDmc=a=>{const v=read(a);reads.push([a,v]);return v;};
  js.step(40000);wasm.step(40000);
  assert.equal(reads.length,65);assert.deepEqual(reads[0],[0xffc0,0x43]);assert.deepEqual(reads[64],[0x8000,0x42]);
  assert.deepEqual(wasm.audioSamples(),js.audioSamples());assert.equal(wasm.cycleCount,js.cycleCount);
  assert.equal(wasm.programCounter,js.cpu.pc);
});
