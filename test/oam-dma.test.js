import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Nes, WasmCore } from '../dist/index.js';
import { OamDma } from '../dist/dma.js';

test('OAM DMA alternates one read/write per cycle after alignment, and replays every phase', () => {
  for (const odd of [false, true]) {
    const events = [], bus = { readDma(a) { events.push(['r', a]); return a & 255; },
      writeDma(v) { events.push(['w', v]); } };
    const dma = new OamDma(bus); dma.start(2, odd);
    for (let cycle = 0; cycle < 513 + Number(odd); cycle++) {
      const saved = dma.saveState(), otherEvents = [];
      const restored = new OamDma({ readDma(a) { otherEvents.push(['r', a]); return a & 255; },
        writeDma(v) { otherEvents.push(['w', v]); } }); restored.loadState(saved);
      const before = events.length; dma.step(); restored.step();
      assert.deepEqual(otherEvents, events.slice(before));
      assert.deepEqual(restored.saveState(), dma.saveState());
      assert.equal(dma.active, cycle !== 512 + Number(odd));
    }
    assert.deepEqual(events, Array.from({ length: 256 }, (_, i) => [['r', 512 + i], ['w', i]]).flat());
  }
});

function rom() {
  const bytes = new Uint8Array(16 + 16384); bytes.set([78, 69, 83, 26, 1, 0]);
  bytes.set([0x4c, 0, 0x80], 16); bytes.set([0, 0x80], 16 + 16384 - 4); return bytes;
}
test('system DMA reads source data when its read cycle occurs and retains a buffered byte in snapshots', () => {
  const nes = new Nes(rom()); nes.reset(); nes.ppu.oam.fill(0x77);
  nes.write(0x2003, 255); nes.write(0x200, 0x12); nes.write(0x201, 0x34); nes.write(0x4014, 2);
  assert.equal(nes.ppu.oam[255], 0x77);
  nes.step(2); // One alignment cycle, then read byte zero.
  const saved = nes.saveState(); nes.write(0x200, 0xff); nes.write(0x201, 0x56);
  nes.step(1); assert.equal(nes.ppu.oam[255], 0x12, 'write uses the byte already read');
  nes.step(2); assert.equal(nes.ppu.oam[0], 0x56, 'later reads observe current RAM');
  const restored = new Nes(rom()); restored.reset(); restored.loadState(saved);
  restored.write(0x200, 0xff); restored.write(0x201, 0x56); restored.step(3);
  assert.deepEqual(restored.saveState(), nes.saveState());
  const invalid = saved.slice(); invalid[invalid.length - 14 + 4] = 3;
  const before = restored.saveState();
  assert.throws(() => restored.loadState(invalid), /Invalid OAM DMA state/);
  assert.deepEqual(restored.saveState(), before);
});

test('WASM DMA observes source changes between read cycles through CPU-visible OAM', async () => {
  const bytes = rom(); bytes.set([0xa9, 2, 0x8d, 0x14, 0x40], 16);
  const js = new Nes(bytes), wasm = await WasmCore.from(await readFile('dist-wasm/lib-jsnes.wasm'));
  js.reset(); wasm.loadRom(bytes); wasm.reset();
  // Program fills its DMA source through CPU stores, leaving a pointer to the request.
  const prefix = [0xa9, 0x5a, 0x8d, 0, 2, 0xa9, 0x80, 0x8d, 0x14, 0x40,
    0xa9, 1, 0x8d, 3, 0x20, 0xad, 4, 0x20, 0x85, 0x10, 0x4c, 20, 0x80];
  js.rom.prgRom.set(prefix); prefix.forEach((v, i) => wasm.exports.romWrite(16 + i, v));
  js.step(12); wasm.step(12);
  assert.equal(js.ppu.oam[0], 0);
  js.step(2); wasm.step(2); assert.equal(js.ppu.oam[0], 0);
  js.rom.prgRom[0] = 0x77; wasm.exports.romWrite(16, 0x77);
  js.rom.prgRom[1] = 0x66; wasm.exports.romWrite(17, 0x66);
  js.step(1); wasm.step(1); assert.equal(js.ppu.oam[0], 0xa9);
  js.step(510); wasm.step(510);
  js.step(13); wasm.step(13);
  assert.equal(js.read(0x10), 0x66); assert.equal(wasm.exports.ramRead(0x10), 0x66);
  assert.equal(wasm.programCounter, js.cpu.pc); assert.equal(wasm.cycleCount, js.cycleCount);
  assert.deepEqual(wasm.frame(), js.frame); assert.deepEqual(wasm.audioSamples(), js.audioSamples());
});
