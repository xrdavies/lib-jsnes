import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdtemp, readFile, rm, symlink, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Cpu6502 } from '../dist/index.js';

test('shared CPU snapshots round-trip between JS and WASM, preserving long cycles and rejecting invalid data', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'lib-jsnes-cpu-state-'));
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
`);
    const build = spawnSync(process.execPath, ['scripts/build-wasm.mjs'], {
      cwd: fixture, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, PATH: resolve('node_modules/.bin') + delimiter + process.env.PATH },
    });
    assert.equal(build.status, 0, build.stderr + build.stdout);
    const { instance } = await WebAssembly.instantiate(await readFile(join(fixture, 'dist-wasm/lib-jsnes.wasm')), {
      env: { abort() { throw new Error('Invalid CPU state'); } },
    });
    const wasm = instance.exports;
    const rom = new Uint8Array(16 + 16384); rom.set([78, 69, 83, 26, 1, 0]);
    rom.fill(0xea, 16); rom.set([0, 0x80], 16 + 0x3ffc);
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
  } finally { await rm(fixture, { recursive: true, force: true }); }
});
