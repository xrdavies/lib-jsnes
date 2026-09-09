import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Cartridge, Cpu6502, parseRom, WasmCore } from '../dist/index.js';

const [romPath, logPath] = process.argv.slice(2);
if (!romPath || !logPath) throw new Error('Usage: node scripts/check-cpu-trace.mjs ROM LOG');
const lines = (await readFile(logPath, 'utf8')).trim().split(/\r?\n/);
const trace = lines.map((line, index) => {
  const fields = line.match(/^([0-9A-F]{4}).*A:([0-9A-F]{2}) X:([0-9A-F]{2}) Y:([0-9A-F]{2}) P:([0-9A-F]{2}) SP:([0-9A-F]{2}).*CYC:(\d+)/);
  if (!fields) throw new Error(`Invalid trace line ${index + 1}`);
  return { registers: [2, 3, 4, 6, 5, 1].map(i => parseInt(fields[i], 16)), cycles: Number(fields[7]) };
});
const rom = new Uint8Array(await readFile(romPath));
const image = parseRom(rom);
assert.equal(image.mapper, 0, 'Trace runner requires NROM');
// Start at the trace's first PC without modifying the input file. Reset cycles
// are excluded by both cores; normalize the log to the same time origin.
const vector = 16 + (image.trainer?.length ?? 0) + image.prgRom.length - 4;
rom.set([trace[0].registers[5] & 255, trace[0].registers[5] >>> 8], vector);
const cart = new Cartridge(parseRom(rom)), ram = new Uint8Array(0x800);
const cpu = new Cpu6502({
  read: address => address < 0x2000 ? ram[address & 0x7ff] : cart.readCpu(address),
  write: (address, value) => { if (address < 0x2000) ram[address & 0x7ff] = value; else cart.writeCpu(address, value); },
}, true);
const wasm = await WasmCore.from(await readFile(new URL('../dist-wasm/lib-jsnes.wasm', import.meta.url)));
wasm.loadRom(rom); cpu.reset(); wasm.reset();
for (const [index, expected] of trace.entries()) {
  const where = `trace line ${index + 1}`;
  assert.deepEqual([cpu.a, cpu.x, cpu.y, cpu.sp, cpu.p, cpu.pc], expected.registers, `TypeScript ${where}`);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(i => wasm.exports.cpuRegister(i)), expected.registers, `WASM ${where}`);
  assert.equal(cpu.cycles, expected.cycles - trace[0].cycles, `TypeScript cycles ${where}`);
  assert.equal(wasm.cycleCount, cpu.cycles, `WASM cycles ${where}`);
  if (index + 1 < trace.length) { cpu.step(); wasm.step(1); }
}
assert.equal(wasm.exports.unknownOpcodeCount(), 0);
assert.deepEqual(Uint8Array.from({ length: ram.length }, (_, i) => wasm.exports.ramRead(i)), ram, 'Final CPU RAM differs');
console.log(`Matched ${trace.length} CPU trace states in TypeScript and WASM.`);
