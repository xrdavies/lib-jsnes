import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Nes, WasmCore, Cpu6502, PPU_STATE_SIZE, Apu } from '../dist/index.js';
import { workload } from '../scripts/benchmark-core.mjs';

const binary = await readFile('dist-wasm/lib-jsnes.wasm');
function rom(mapper, chrRom) {
  const bytes = new Uint8Array(16 + 0x8000 + (chrRom ? 0x4000 : 0));
  bytes.set([78, 69, 83, 26, 2, chrRom ? 2 : 0, (mapper & 15) << 4, mapper & 0xf0]);
  for (let bank = 0; bank < 4; bank++) {
    bytes.fill(bank, 16 + bank * 8192, 16 + (bank + 1) * 8192);
    bytes.set([0x4c, 0, 2], 16 + bank * 8192);
  }
  bytes.set([0, 0x80], 16 + 0x7ffc);
  for (let i = 16 + 0x8000; i < bytes.length; i++) bytes[i] = (i ^ (i >>> 7)) & 255;
  return bytes;
}
function configure(js, mapper) {
  const serial = (address, value) => { for (let i = 0; i < 5; i++) js.write(address, (value >>> i) & 1); };
  if (mapper === 1) {
    serial(0x8000, 0x1f); serial(0xa000, 3); serial(0xc000, 2); serial(0xe000, 1);
    js.write(0x8000, 1); js.write(0x8000, 0); // Pending serial transfer.
  } else if (mapper === 4) {
    for (let i = 0; i < 8; i++) { js.write(0x8000, 0xc0 | i); js.write(0x8001, 7 + i); }
    js.write(0xa000, 1); js.write(0xa001, 0x40); js.write(0xc000, 2); js.write(0xe001, 0);
    js.cartridge.clockScanline();
  } else if (mapper === 225) { js.write(0xdcab, 0); js.write(0x5803, 13); }
  else js.write(mapper === 79 || mapper === 113 ? 0x4100 : mapper === 87 || mapper === 140 ? 0x6000 : 0x8003, 0xff);
}

test('full snapshots cross JS/WASM for every supported mapper, including raw bank latches and CHR RAM', async () => {
  for (const mapper of [0, 1, 2, 3, 4, 7, 11, 15, 34, 66, 79, 87, 113, 140, 177, 225, 241]) for (const chrRom of [false, true]) {
    const bytes = rom(mapper, chrRom), js = new Nes(bytes), wasm = await WasmCore.from(binary);
    js.reset(); wasm.loadRom(bytes); wasm.reset();
    // Execute from RAM while mapper windows change. Update banks through CPU writes
    // after restoring, so matching state cannot conceal a wrong decoded bank.
    const code = [0xa9, 0x55, 0x8d, 0, 0x80, 0xad, 1, 0x80, 0x85, 0x10, 0x4c, 0, 2];
    code.forEach((v, i) => js.write(0x200 + i, v)); js.cpu.pc = 0x200;
    js.loadBatteryRam(Uint8Array.from({ length: 8192 }, (_, i) => (i * 19) & 255));
    for (let i = 0; i < 8192; i++) js.cartridge.writeChr(i, (i * 71) & 255);
    configure(js, mapper);
    js.setController(1, 0xa5); js.setController(2, 0x69); js.write(0x4016, 1); js.write(0x4016, 0); js.read(0x4016);
    js.write(0x2001, 0x1e); js.ppu.step(120 * 341 + 173);
    const saved = js.saveState(); wasm.loadState(saved);
    assert.deepEqual(wasm.saveState(), saved, `mapper ${mapper} CHR ROM ${chrRom}`);
    for (let i = 0; i < 8192; i++) assert.equal(wasm.exports.chrRead(i), js.cartridge.readChr(i));
    for (const cycles of [1, 300, 30000]) {
      js.step(cycles); wasm.step(cycles);
      assert.deepEqual(wasm.saveState(), js.saveState(), `continuation ${mapper}:${cycles}`);
      assert.deepEqual(wasm.audioSamples(), js.audioSamples());
    }
    const restored = new Nes(bytes); restored.loadState(wasm.saveState());
    restored.step(1000); wasm.step(1000);
    assert.deepEqual(wasm.saveState(), restored.saveState());
  }
});

test('WASM snapshots restore partial DMA, frame and audio states across fresh instances and memory growth', async () => {
  const bytes = workload(), js = new Nes(bytes), wasm = await WasmCore.from(binary);
  js.reset(); wasm.loadRom(bytes); wasm.reset();
  js.step(137); // CPU instructions can leave OAM DMA pending later; force a partial transfer.
  js.write(0x4014, 2); js.write(0x4010, 0xcf); js.write(0x4015, 31); js.step(37);
  wasm.loadState(js.saveState());
  const saved = wasm.saveState(), copy = saved.slice();
  wasm.step(40000); const pixels = wasm.frame().slice(), pcm = wasm.audioSamples(), final = wasm.saveState();
  wasm.exports.memory.grow(1);
  const view = Buffer.alloc(saved.length + 13); view.set(saved, 7);
  wasm.loadState(view.subarray(7, 7 + saved.length)); assert.equal(wasm.audioSamples().length, 0);
  wasm.step(40000);
  assert.deepEqual(wasm.frame(), pixels); assert.deepEqual(wasm.audioSamples(), pcm); assert.deepEqual(wasm.saveState(), final);
  assert.deepEqual(saved, copy, 'saved bytes are host-owned');
  // The wrapper must copy an input backed by WASM memory before allocating scratch space.
  const pointer = wasm.exports.stateAllocate(); new Uint8Array(wasm.exports.memory.buffer, pointer, saved.length).set(saved);
  wasm.loadState(new Uint8Array(wasm.exports.memory.buffer, pointer, saved.length));
  assert.deepEqual(wasm.saveState(), saved);
  const fresh = await WasmCore.from(binary); fresh.loadRom(bytes); fresh.loadState(saved);
  fresh.step(40000); assert.deepEqual(fresh.saveState(), final); assert.deepEqual(fresh.audioSamples(), pcm);
});

test('WASM rejects corrupt snapshot sections without changing live state or queued PCM', async () => {
  const bytes = workload(), source = new Nes(bytes); source.reset(); source.step(17000);
  const saved = source.saveState(), ppu = Cpu6502.STATE_SIZE + source.cartridge.stateSize, apu = ppu + PPU_STATE_SIZE;
  const positions = [15, Cpu6502.STATE_SIZE + 25, ppu + 0x4129, ppu + PPU_STATE_SIZE - 12,
    apu + 59, apu + Apu.STATE_SIZE + 2, apu + Apu.STATE_SIZE + 7, saved.length - 5, saved.length - 1];
  for (const offset of positions) {
    const wasm = await WasmCore.from(binary); wasm.loadRom(bytes); wasm.loadState(saved); wasm.step(2000);
    const reference = new Nes(bytes); reference.loadState(saved); reference.step(2000);
    const before = wasm.saveState(), invalid = saved.slice(); invalid[offset] = 255;
    assert.throws(() => wasm.loadState(invalid));
    assert.deepEqual(wasm.saveState(), before); assert.deepEqual(wasm.audioSamples(), reference.audioSamples());
    assert.throws(() => wasm.loadState(saved.subarray(1)), /Invalid state size/);
    assert.deepEqual(wasm.saveState(), before);
  }
  const empty = await WasmCore.from(binary);
  assert.throws(() => empty.saveState());
});

test('repeated WASM save/restore reclaims temporary buffers and preserves owned snapshots', async () => {
  const wasm = await WasmCore.from(binary); wasm.loadRom(workload()); wasm.reset(); wasm.step(25000);
  const original = wasm.saveState(), copy = original.slice();
  for (let i = 0; i < 20; i++) { wasm.saveState(); wasm.loadState(original); }
  const capacity = wasm.exports.memory.buffer.byteLength;
  for (let i = 0; i < 100; i++) { wasm.saveState(); wasm.loadState(original); }
  assert.equal(wasm.exports.memory.buffer.byteLength, capacity);
  assert.deepEqual(original, copy); assert.deepEqual(wasm.saveState(), original);
});

test('full WASM snapshots preserve long cycle counts and independent CPU JAM/NMI flags', async () => {
  const bytes = workload(), js = new Nes(bytes), wasm = await WasmCore.from(binary);
  js.reset(); wasm.loadRom(bytes); wasm.reset();
  for (const cycles of [2 ** 32 + 3, 2 ** 40 + 1]) for (const flags of [0, 1, 2, 3]) {
    js.reset(); js.cpu.cycles = cycles;
    const saved = js.saveState(); saved[15] = flags; js.loadState(saved); wasm.loadState(saved);
    assert.deepEqual(wasm.saveState(), saved);
    js.step(30); wasm.step(30);
    assert.deepEqual(wasm.saveState(), js.saveState()); assert.deepEqual(wasm.audioSamples(), js.audioSamples());
  }
});
