import assert from 'node:assert/strict';
import test from 'node:test';
import { Cpu6502, Nes } from '../dist/index.js';

function machine(code) {
  const rom = new Uint8Array(16 + 16384);
  rom.set([78, 69, 83, 26, 1, 0]); rom.set(code, 16);
  rom.set([0, 0x90, 0, 0x80], 16 + 0x3ffa);
  const nes = new Nes(rom); nes.reset(); return nes;
}

test('implemented instructions clock one bus access per cycle, while reset-vector reads remain untimed', () => {
  for (let opcode = 0; opcode < 256; opcode++) for (const flags of [0x24, 0xeb]) {
    const memory = new Uint8Array(65536); memory.set([opcode, 0xff, 0xff], 0x8000);
    memory[0xfffd] = 0x80;
    const clocks = [], bus = { read(a, tick) { clocks.push(tick); return memory[a]; },
      write(a, v, consecutive, odd, tick) { clocks.push(tick); memory[a] = v; } };
    const cpu = new Cpu6502(bus); cpu.reset();
    assert.deepEqual(clocks, [false, false]); clocks.length = 0;
    cpu.x = cpu.y = 1; cpu.p = flags;
    const cycles = cpu.step();
    if (cpu.unknownOpcodes) continue;
    assert.equal(cpu.busCycles, cycles, opcode.toString(16));
    assert.deepEqual(clocks, Array(cycles).fill(true));
    if (!cpu.jammed) {
      clocks.length = 0; cpu.nmi();
      assert.equal(cpu.busCycles, 7); assert.deepEqual(clocks, Array(7).fill(true));
    }
  }
});

test('CPU register accesses occur after two PPU dots of their bus cycle; host accesses do not advance clocks', () => {
  const nes = machine([0xa9, 0x40, 0x8d, 5, 0x20, 0xad, 2, 0x20, 0x8d, 0x17, 0x40]);
  const events = [], writePpu = nes.ppu.writeRegister.bind(nes.ppu), readPpu = nes.ppu.readRegister.bind(nes.ppu);
  const writeApu = nes.apu.write.bind(nes.apu);
  nes.ppu.writeRegister = (a, v) => { events.push(['ppu write', nes.ppu.dot]); writePpu(a, v); };
  nes.ppu.readRegister = a => { events.push(['ppu read', nes.ppu.dot]); return readPpu(a); };
  nes.apu.write = (a, v) => { events.push(['apu write', nes.ppu.dot]); writeApu(a, v); };
  nes.write(0x2001, 0); nes.read(0x2000);
  assert.deepEqual(events, [['ppu write', 0], ['ppu read', 0]]); events.length = 0;
  nes.step(14);
  assert.deepEqual(events, [['ppu write', 17], ['ppu read', 29], ['apu write', 41]]);
  assert.equal(nes.ppu.dot, 42); assert.equal(nes.cycleCount, 14);
});

test('NMI enabled on the final write cycle waits for the next instruction and survives a snapshot', () => {
  const nes = machine([0xa9, 0x80, 0x8d, 0, 0x20, 0xe6, 0x10]);
  nes.ppu.step(241 * 341 + 1); nes.step(6);
  assert.equal(nes.cpu.pc, 0x8005);
  const saved = nes.saveState();
  for (let replay = 0; replay < 2; replay++) {
    if (replay) nes.loadState(saved);
    nes.read(0x2002); // Clearing the PPU flag cannot cancel an edge already latched by the CPU.
    nes.step(1);
    assert.equal(nes.read(0x10), 1);
    assert.equal(nes.cpu.pc, 0x9000); assert.equal(nes.cycleCount, 18);
  }
  const before = nes.saveState(), invalid = saved.slice(); invalid[15] = 4;
  assert.throws(() => nes.loadState(invalid), /Invalid CPU state/);
  assert.deepEqual(nes.saveState(), before);
});
