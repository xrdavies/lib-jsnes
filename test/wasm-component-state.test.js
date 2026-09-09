import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdtemp, readFile, rm, symlink, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Cpu6502, Controller, Nes, PPU_STATE_SIZE, Apu } from '../dist/index.js';
import { OamDma, DmcDma } from '../dist/dma.js';

test('shared component snapshots restore and continue identically in JS and WASM', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'lib-jsnes-component-state-'));
  try {
    for (const name of ['src', 'wasm', 'scripts']) await cp(resolve(name), join(fixture, name), { recursive: true });
    await symlink(resolve('node_modules'), join(fixture, 'node_modules'), 'dir');
    // Force compilation of the shared serializer without exposing partial-system
    // restore functions in the shipped emulator ABI. Keep the scratch buffer rooted.
    await appendFile(join(fixture, 'wasm/index.ts'), `
let testState = new Uint8Array(Cpu6502.STATE_SIZE);
export function testSave(): usize { testState = cpu.saveState(); return changetype<usize>(testState.buffer); }
export function testLoad(): void { cpu.loadState(testState); }
export function testLoadShort(): void { cpu.loadState(testState.subarray(0, 15)); }
export function testStep(): void { cpu.step(); }
const events = new Array<i32>();
class StateBus implements OamDmaBus, DmcDmaBus {
  readDma(a: i32): i32 { events.push(a); return (a ^ (a >> 8)) & 255; }
  writeDma(v: i32): void { events.push(0x10000 | v); }
  completeDmc(v: i32): void { events.push(0x20000 | v); }
}
const stateController = new Controller();
const stateOam = new OamDma(new StateBus());
const stateDmc = new DmcDma(new StateBus());
class SampleBus implements DmcBus {
  readDmc(a: i32): i32 { events.push(a); return (a ^ (a >> 8)) & 255; }
}
const stateApu = new Apu(new SampleBus());
let stateAudio = new Int16Array(0);
export function componentSave(kind: i32): usize {
  __collect();
  testState = kind == 0 ? stateController.saveState() : kind == 1 ? stateOam.saveState() : kind == 2 ? stateDmc.saveState() : kind == 3 ? ppu.saveState() : stateApu.saveState();
  return changetype<usize>(testState.buffer);
}
export function componentLoad(kind: i32, length: i32): void {
  const bytes = testState.subarray(0, length);
  if (kind == 0) stateController.loadState(bytes);
  else if (kind == 1) stateOam.loadState(bytes);
  else if (kind == 2) stateDmc.loadState(bytes);
  else {
    const padded = new Uint8Array(bytes.length + 7);
    padded.set(bytes, 3);
    if (kind == 3) ppu.loadState(padded.subarray(3, 3 + bytes.length));
    else stateApu.loadState(padded.subarray(3, 3 + bytes.length));
  }
}
export function componentStep(kind: i32, odd: boolean, busy: boolean, held: i32): i32 {
  events.length = 0;
  if (kind == 0) return stateController.read();
  if (kind == 1) { stateOam.step(odd, busy); return 0; }
  return stateDmc.step(odd, held, busy) ? 1 : 0;
}
export function eventCount(): i32 { return events.length; }
export function eventAt(i: i32): i32 { return events[i]; }
export function ppuStep(dots: i32): boolean { return ppu.step(dots); }
export function ppuRead(reg: i32): i32 { return ppu.readRegister(reg); }
export function ppuWrite(reg: i32, value: i32): void { ppu.writeRegister(reg, value); }
export function ppuNmi(): boolean { return ppu.consumeNmi(); }
export function apuStep(cycles: i32): void { events.length = 0; stateApu.step(cycles); }
export function apuStatus(): i32 { return stateApu.readStatus(); }
export function apuWrite(a: i32, v: i32): void { stateApu.write(a, v); }
export function apuComplete(v: i32): void { stateApu.completeDmc(v); }
export function apuDrain(): i32 { stateAudio = stateApu.drainSamples(); return stateAudio.length; }
export function apuSample(i: i32): i32 { return stateAudio[i]; }
`);
    const build = spawnSync(process.execPath, ['scripts/build-wasm.mjs'], {
      cwd: fixture, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, PATH: resolve('node_modules/.bin') + delimiter + process.env.PATH },
    });
    assert.equal(build.status, 0, build.stderr + build.stdout);
    const { instance } = await WebAssembly.instantiate(await readFile(join(fixture, 'dist-wasm/lib-jsnes.wasm')), {
      env: { abort() { throw new Error('Invalid CPU/component state'); } },
    });
    const wasm = instance.exports;
    const rom = new Uint8Array(16 + 16384 + 8192); rom.set([78, 69, 83, 26, 1, 1]);
    rom.fill(0xea, 16); rom.set([0, 0x80], 16 + 0x3ffc);
    for (let i = 16 + 16384; i < rom.length; i++) rom[i] = (i * 73 + (i >>> 3)) & 255;
    const ptr = wasm.romAllocate(rom.length);
    new Uint8Array(wasm.memory.buffer, ptr, rom.length).set(rom); wasm.loadRom(rom.length); wasm.reset();
    const cpu = new Cpu6502({ read: () => 0xea, write() {} });
    const saveWasm = () => new Uint8Array(wasm.memory.buffer, wasm.testSave(), Cpu6502.STATE_SIZE).slice();
    function loadWasm(bytes) {
      const pointer = wasm.testSave();
      new Uint8Array(wasm.memory.buffer, pointer, bytes.length).set(bytes); wasm.testLoad();
    }
    for (const cycles of [0, 2 ** 31, 2 ** 32 + 7, 2 ** 40 + 3, Number.MAX_SAFE_INTEGER]) {
      for (const flags of [0, 1, 2, 3]) {
        cpu.a = 0x81; cpu.x = 0x32; cpu.y = 0xfe; cpu.sp = 0xa1; cpu.p = 0xe9; cpu.pc = 0x8123; cpu.cycles = cycles;
        const bytes = cpu.saveState(); bytes[15] = flags;
        cpu.loadState(bytes); loadWasm(bytes);
        assert.deepEqual(saveWasm(), bytes);
        const offset = Buffer.alloc(bytes.length + 9); offset.set(bytes, 5);
        cpu.loadState(offset.subarray(5, 5 + bytes.length));
        assert.deepEqual(cpu.save(), Array.from(bytes), 'legacy number[] API preserves encoding');
        if (cycles < Number.MAX_SAFE_INTEGER - 2) {
          cpu.step(); wasm.testStep();
          assert.deepEqual(saveWasm(), cpu.saveState(), 'next NOP/JAM preserves decoded state');
        }
      }
    }
    const before = saveWasm();
    for (const cycles of [-1, 1.5, NaN, Infinity, 2 ** 53]) {
      const invalid = before.slice(); new DataView(invalid.buffer).setFloat64(7, cycles, true);
      assert.throws(() => cpu.loadState(invalid), /Invalid CPU/);
      assert.throws(() => loadWasm(invalid), /Invalid CPU/);
      assert.deepEqual(saveWasm(), before); assert.deepEqual(cpu.saveState(), before);
    }
    const invalid = before.slice(); invalid[15] = 4;
    assert.throws(() => loadWasm(invalid), /Invalid CPU/); assert.deepEqual(saveWasm(), before);
    assert.throws(() => wasm.testLoadShort(), /Invalid CPU/); assert.deepEqual(saveWasm(), before);
    assert.throws(() => cpu.loadState(before.subarray(0, 15)), /Invalid CPU/);

    function saveComponent(kind, size) {
      const pointer = wasm.componentSave(kind);
      return new Uint8Array(wasm.memory.buffer, pointer, size).slice();
    }
    function loadComponent(kind, bytes, length = bytes.length) {
      const pointer = wasm.componentSave(kind);
      new Uint8Array(wasm.memory.buffer, pointer, bytes.length).set(bytes);
      wasm.componentLoad(kind, length);
    }
    for (const strobe of [0, 1]) for (let index = 0; index <= 8; index++) {
      const controller = new Controller(), bytes = Uint8Array.of(0xa5, 0x3c, index, strobe);
      controller.loadState(bytes); loadComponent(0, bytes);
      for (let i = 0; i < 10; i++) {
        assert.equal(wasm.componentStep(0, false, false, 0), controller.read());
        assert.deepEqual(saveComponent(0, 4), controller.saveState());
      }
    }
    const events = [], bus = {
      readDma(a) { events.push(a); return (a ^ (a >>> 8)) & 255; },
      writeDma(v) { events.push(0x10000 | v); },
      completeDmc(v) { events.push(0x20000 | v); },
    };
    // Reload every phase, including the final index=256 sentinel and a paused
    // write containing a byte different from its address. Check actual bus effects.
    for (const oddStart of [false, true]) {
      const oam = new OamDma(bus); oam.start(0xab, oddStart);
      let cycle = 0;
      do {
        const bytes = oam.saveState(); loadComponent(1, bytes);
        assert.deepEqual(saveComponent(1, 6), bytes);
        const odd = !!((Number(oddStart) + ++cycle) % 2), busy = cycle % 13 === 0;
        events.length = 0; oam.step(odd, busy); wasm.componentStep(1, odd, busy, 0);
        assert.deepEqual(Array.from({ length: wasm.eventCount() }, (_, i) => wasm.eventAt(i)), events);
        assert.deepEqual(saveComponent(1, 6), oam.saveState());
        assert.ok(cycle < 700);
      } while (oam.active);
      loadComponent(1, oam.saveState()); wasm.componentStep(1, true, false, 0);
      assert.equal(wasm.eventCount(), 0); assert.deepEqual(saveComponent(1, 6), oam.saveState());
    }
    for (const address of [0x8000, 0xc123, 0xffff]) for (const held of [0x2007, 0x4016]) {
      for (const oamActive of [false, true]) for (const oddStart of [false, true]) {
        const dmc = new DmcDma(bus); dmc.request(address);
        for (let cycle = 0; cycle < 5; cycle++) {
          const bytes = dmc.saveState(); loadComponent(2, bytes);
          assert.deepEqual(saveComponent(2, 3), bytes);
          events.length = 0;
          const odd = !!((Number(oddStart) + cycle) % 2);
          assert.equal(wasm.componentStep(2, odd, oamActive, held), Number(dmc.step(odd, held, oamActive)));
          assert.deepEqual(Array.from({ length: wasm.eventCount() }, (_, i) => wasm.eventAt(i)), events);
          assert.deepEqual(saveComponent(2, 3), dmc.saveState());
        }
      }
    }
    for (const [kind, good, invalids] of [
      [0, [0xa5, 0x3c, 3, 0], [[0, 0, 9, 0], [0, 0, 0, 2]]],
      [1, [2, 0, 0, 0x87, 0, 1], [[0, 1, 1, 0, 0, 0], [0, 0, 2, 0, 0, 0],
        [0, 0, 0, 0, 3, 0], [0, 0, 0, 0, 0, 2], [0, 0, 1, 0, 0, 1], [0, 1, 0, 0, 1, 0]]],
      [2, [0x23, 0xc1, 2], [[0, 0, 1], [1, 0, 0], [0, 0x7f, 0], [0, 0x80, 3]]],
    ]) {
      loadComponent(kind, Uint8Array.from(good));
      for (const invalid of invalids) {
        assert.throws(() => loadComponent(kind, Uint8Array.from(invalid)), /Invalid/);
        assert.deepEqual(saveComponent(kind, good.length), Uint8Array.from(good));
      }
      assert.throws(() => loadComponent(kind, Uint8Array.from(good), good.length - 1), /Invalid/);
      assert.deepEqual(saveComponent(kind, good.length), Uint8Array.from(good));
    }
    const { ppu } = new Nes(rom);
    for (const [line, dot] of [[120, 255], [241, 0], [261, 338]]) {
      ppu.reset(); ppu.step(89342); // Odd frame, including a pending skip decision.
      ppu.scanline = line; ppu.dot = dot;
      for (let i = 0; i < ppu.vram.length; i++) ppu.vram[i] = (i * 17 + (i >>> 7)) & 255;
      for (let i = 0; i < ppu.oam.length; i++) ppu.oam[i] = (i * 29) & 255;
      for (let i = 0; i < ppu.frame.length; i++) {
        ppu.frame[i] = (0xff123456 + i * 7) >>> 0; ppu.backgroundOpaque[i] = i & 1;
      }
      for (let i = 0; i < ppu.palette.length; i++) ppu.palette[i] = (i * 3) & 63;
      ppu.writeRegister(0, 0xb8); ppu.writeRegister(1, 0x1e);
      ppu.writeRegister(5, 173); ppu.writeRegister(5, 239);
      ppu.writeRegister(6, 0x2f); ppu.writeRegister(6, 0x17); ppu.readRegister(7);
      ppu.writeRegister(6, 0x3b); // Partly written address, independent of active address.
      if (line === 241) ppu.readRegister(2); // Suppress VBlank before its dot-1 transition.
      const state = ppu.saveState(), storage = Buffer.alloc(state.length + 11);
      if (line === 120) {
        // Exercise latched flags as well as the cleared state reached on pre-render.
        state[0x412c] = state[0x412f] = state[0x4130] = 1;
        state[0x4122] = 0xe0;
      }
      storage.set(state, 7); ppu.loadState(storage.subarray(7, 7 + state.length));
      loadComponent(3, state);
      assert.deepEqual(saveComponent(3, PPU_STATE_SIZE), state, 'all PPU fields survive cross-build loading');
      const bytes = new DataView(state.buffer);
      assert.equal(bytes.getUint32(0x4132, true), 0xff123456);
      assert.equal(bytes.getUint16(0x4128, true), line);
      assert.equal(bytes.getUint16(0x412a, true), dot);
      for (const dots of [1, 2, 3, 341, 89342]) {
        assert.equal(!!wasm.ppuStep(dots), ppu.step(dots));
        assert.equal(!!wasm.ppuNmi(), ppu.consumeNmi());
        for (const reg of [2, 4, 7, 0]) assert.equal(wasm.ppuRead(reg), ppu.readRegister(reg));
        ppu.writeRegister(5, 211); wasm.ppuWrite(5, 211);
        assert.deepEqual(saveComponent(3, PPU_STATE_SIZE), ppu.saveState(), 'continued rendering and I/O match');
        ppu.loadState(saveComponent(3, PPU_STATE_SIZE)); // Also decode the WASM-produced bytes in JS.
      }
    }
    const ppuBefore = ppu.saveState();
    for (const [offset, value] of [[0x4125, 0x80], [0x4126, 2], [0x4129, 2], [0x412b, 2],
      [0x412c, 2], [0x412f, 2], [0x4130, 2], [PPU_STATE_SIZE - 12, 7], [PPU_STATE_SIZE - 11, 4],
      [PPU_STATE_SIZE - 9, 4], [PPU_STATE_SIZE - 7, 4], [PPU_STATE_SIZE - 5, 4],
      [PPU_STATE_SIZE - 3, 128], [PPU_STATE_SIZE - 1, 2]]) {
      const invalid = ppuBefore.slice(); invalid[0] ^= 255; invalid[offset] = value;
      assert.throws(() => loadComponent(3, invalid), /Invalid/);
      assert.throws(() => ppu.loadState(invalid), /Invalid/);
      assert.deepEqual(saveComponent(3, PPU_STATE_SIZE), ppuBefore);
      assert.deepEqual(ppu.saveState(), ppuBefore);
    }
    assert.throws(() => loadComponent(3, ppuBefore, ppuBefore.length - 1), /Invalid/);
    const sampleReads = [], sampleBus = { readDmc(a) { sampleReads.push(a); return (a ^ (a >>> 8)) & 255; } };
    const drainWasm = () => Int16Array.from({ length: wasm.apuDrain() }, (_, i) => wasm.apuSample(i));
    function compareAudio(apu, cycles) {
      sampleReads.length = 0; apu.step(cycles); wasm.apuStep(cycles);
      assert.deepEqual(Array.from({ length: wasm.eventCount() }, (_, i) => wasm.eventAt(i)), sampleReads);
      assert.equal(wasm.apuStatus(), apu.readStatus());
      assert.deepEqual(drainWasm(), apu.drainSamples(), 'restored filters and oscillators produce identical PCM');
      assert.deepEqual(saveComponent(4, Apu.STATE_SIZE), apu.saveState());
    }
    for (const mode of [0, 0x80]) for (const position of [1, 2, 7456, 14912, 29827, 37280]) {
      const apu = new Apu(sampleBus); apu.write(0x4015, 31);
      for (const base of [0x4000, 0x4004, 0x4008, 0x400c]) {
        apu.write(base, base === 0x4008 ? 0x83 : 0xbf); apu.write(base + 1, 0x8a);
        apu.write(base + 2, base === 0x400c ? 0x8f : 99); apu.write(base + 3, 0x18);
      }
      apu.write(0x4010, 0xcf); apu.write(0x4011, 64); apu.write(0x4012, 0xff); apu.write(0x4013, 4);
      apu.write(0x4017, mode); apu.step(position);
      // Save a scheduled frame-counter change as well as active filter history.
      apu.write(0x4017, mode ^ 0x80);
      const saved = apu.saveState();
      wasm.apuStep(4000); // Restoration must discard pre-existing queued PCM.
      loadComponent(4, saved); assert.equal(wasm.apuDrain(), 0);
      const storage = Buffer.alloc(saved.length + 9); storage.set(saved, 3);
      apu.loadState(storage.subarray(3, 3 + saved.length));
      assert.deepEqual(saveComponent(4, Apu.STATE_SIZE), saved);
      for (const cycles of [1, 3, 128, 16000]) compareAudio(apu, cycles);
      apu.loadState(saveComponent(4, Apu.STATE_SIZE));
      apu.write(0x4015, 0); wasm.apuWrite(0x4015, 0); compareAudio(apu, 1000);
    }
    const pending = new Apu({ readDmc() { return 256; } });
    pending.write(0x4010, 0x8f); pending.write(0x4015, 16); pending.step(2);
    const waiting = pending.saveState(); assert.ok(waiting[67] & 4);
    loadComponent(4, waiting); compareAudio(pending, 100);
    pending.completeDmc(0xa5); wasm.apuComplete(0xa5); compareAudio(pending, 3000);
    const apuBefore = pending.saveState();
    const invalidStates = [];
    for (const [offset, value] of [[12, 8], [13, 8], [19, 32], [16, 2], [17, 2], [18, 2], [36, 2],
      [39, 2], [40, 2], [45, 2], [47, 2], [48, 2], [49, 16], [53, 16], [55, 16],
      [59, 0], [60, 0], [61, 4], [66, 128], [67, 8], [68, 0], [68, 9],
      [127, 5], [128, 2], [129, 2], [130, 4]]) {
      const invalid = apuBefore.slice(); invalid[offset] = value; invalidStates.push(invalid);
    }
    for (const [offset, value] of [[14, 0x8000], [24, 0x800], [26, 0x800], [28, 0x801],
      [30, 4069], [57, 0xffff], [70, 257], [72, 0x7fff], [74, 4082], [76, 428]]) {
      const invalid = apuBefore.slice(); new DataView(invalid.buffer).setUint16(offset, value, true); invalidStates.push(invalid);
    }
    for (const offset of [79, 87, 95, 103, 111, 119]) {
      const invalid = apuBefore.slice(); new DataView(invalid.buffer).setFloat64(offset, NaN, true); invalidStates.push(invalid);
    }
    for (const [offset, value] of [[79, 1.5], [79, -1], [79, 32768], [87, 65535],
      [95, -65535], [103, 65535], [111, -65535], [119, 65535]]) {
      const invalid = apuBefore.slice(); new DataView(invalid.buffer).setFloat64(offset, value, true); invalidStates.push(invalid);
    }
    const badFraction = apuBefore.slice(); new DataView(badFraction.buffer).setUint32(41, 1789773, true); invalidStates.push(badFraction);
    const badHistory = apuBefore.slice();
    new DataView(badHistory.buffer).setFloat64(95, new DataView(badHistory.buffer).getFloat64(87, true) + 1, true);
    invalidStates.push(badHistory);
    for (const invalid of invalidStates) {
      const apu = new Apu(sampleBus); apu.loadState(apuBefore); loadComponent(4, apuBefore);
      apu.step(1000); wasm.apuStep(1000); // Rejected input must leave queued PCM intact.
      const unchanged = apu.saveState();
      assert.throws(() => apu.loadState(invalid), /Invalid/);
      assert.throws(() => loadComponent(4, invalid), /Invalid/);
      assert.deepEqual(apu.saveState(), unchanged); assert.deepEqual(saveComponent(4, Apu.STATE_SIZE), unchanged);
      assert.deepEqual(drainWasm(), apu.drainSamples());
    }
    assert.throws(() => loadComponent(4, apuBefore, Apu.STATE_SIZE - 1), /Invalid/);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});
