import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Cpu6502, Nes, WasmCore } from '../dist/index.js';

const kil = [0x02, 0x12, 0x22, 0x32, 0x42, 0x52, 0x62, 0x72, 0x92, 0xb2, 0xd2, 0xf2];
const binary = await readFile(new URL('../dist-wasm/lib-jsnes.wasm', import.meta.url));

test('every KIL opcode jams even in strict mode and ignores both interrupt types until reset', () => {
  for (const opcode of kil) for (const start of [0x8000, 0xffff]) {
    const memory = new Uint8Array(65536);
    memory[0xfffc] = 0; memory[0xfffd] = 0x90; memory[0x9000] = 0xea; memory[start] = opcode;
    const cpu = new Cpu6502({ read: a => memory[a], write() { assert.fail('jam must not push the stack'); } }, true);
    cpu.pc = start; cpu.p = 0x20; cpu.a = 0x72; cpu.x = 0x19; cpu.y = 0x37;
    assert.equal(cpu.step(), 2); assert.equal(cpu.jammed, true);
    const pc = (start + 1) & 65535;
    for (let i = 0; i < 20; i++) {
      assert.equal(cpu.irq(), false); assert.equal(cpu.irqAfterInstruction(), false); assert.equal(cpu.nmi(), false);
      assert.equal(cpu.step(), 1);
      assert.deepEqual([cpu.pc, cpu.a, cpu.x, cpu.y, cpu.sp, cpu.p], [pc, 0x72, 0x19, 0x37, 0xfd, 0x20]);
    }
    assert.equal(cpu.cycles, 22); assert.equal(cpu.unknownOpcodes, 0);
    cpu.reset(); assert.equal(cpu.jammed, false); assert.equal(cpu.step(), 2); assert.equal(cpu.pc, 0x9001);
  }
});

function image(opcode) {
  const rom = new Uint8Array(16 + 16384); rom.set([78, 69, 83, 26, 1, 0]);
  rom.set([0xa9, 0x80, 0x8d, 0, 0x20, 0x58, opcode, 0xe6, 0x10, 0x4c, 9, 0x80], 16);
  rom.set([0xe6, 0x11, 0x40], 16 + 256);
  rom.set([0, 0x81, 0, 0x80, 0, 0x81], 16 + 16384 - 6);
  return rom;
}

test('JS and WASM keep devices clocking during JAM without executing code or interrupt handlers', async () => {
  const wasm = await WasmCore.from(binary);
  for (const opcode of kil) {
    const bytes = image(opcode), js = new Nes(bytes); js.reset(); wasm.loadRom(bytes); wasm.reset();
    js.step(90000); wasm.step(90000);
    assert.equal(js.cpu.jammed, true); assert.equal(wasm.jammed, true);
    assert.equal(js.cpu.pc, 0x8007); assert.equal(wasm.programCounter, 0x8007);
    assert.equal(js.cycleCount, 90000); assert.equal(wasm.cycleCount, 90000, 'ignored NMI adds no interrupt cycles');
    for (const address of [0x10, 0x11]) { assert.equal(js.read(address), 0); assert.equal(wasm.exports.ramRead(address), 0); }
    assert.equal(js.apu.irqPending, true, 'frame sequencer continues despite jammed CPU');
    const pcm = js.audioSamples(); assert.ok(pcm.length > 2000); assert.deepEqual(wasm.audioSamples(), pcm);
    assert.ok(js.frame.some(pixel => pixel !== 0xff000000)); assert.deepEqual(wasm.frame(), js.frame);
    assert.equal(wasm.exports.unknownOpcodeCount(), 0);
    // A reset starts executing the replacement instruction normally.
    js.rom.prgRom[6] = 0xea; wasm.exports.romWrite(22, 0xea);
    js.reset(); wasm.reset(); assert.equal(js.cpu.jammed, false); assert.equal(wasm.jammed, false);
    js.step(15); wasm.step(15);
    assert.equal(js.read(0x10), 1); assert.equal(wasm.exports.ramRead(0x10), 1);
  }
});

test('full snapshots retain JAM and reject legacy or invalid CPU state before mutation', () => {
  const bytes = image(0x02), source = new Nes(bytes); source.reset(); source.step(100);
  const saved = source.saveState(), target = new Nes(bytes); target.reset(); target.loadState(saved);
  assert.equal(target.cpu.jammed, true);
  source.step(30000); target.step(30000);
  assert.deepEqual(target.saveState(), source.saveState());
  const before = target.saveState(), invalid = saved.slice(); invalid[15] = 4;
  assert.throws(() => target.loadState(invalid), /Invalid CPU state/);
  assert.deepEqual(target.saveState(), before);
  assert.throws(() => target.cpu.load(target.cpu.save().slice(0, 15)), /Invalid CPU state/);
  assert.equal(target.cpu.jammed, true);
  source.reset(); target.loadState(source.saveState()); assert.equal(target.cpu.jammed, false);
});
