import assert from 'node:assert/strict';
import test from 'node:test';
import { OamDma, DmcDma } from '../dist/dma.js';

test('DMC preparations overlap OAM, its read steals an odd cycle, and the next empty put is skipped', () => {
  for (const requestAt of [1, 2, 3, 20, 509, 510, 511, 512, 513, 514]) {
    const pixels = [], fetches = [];
    let cycle = 0;
    const bus = {
      readDma(a) {
        if (a >= 0x200 && a <= 0x2ff) assert.equal(cycle % 2, 1);
        if (a === 0xc000) { assert.equal(cycle % 2, 1); fetches.push(cycle); return 0xa5; }
        return a & 255;
      },
      writeDma(v) { assert.equal(cycle % 2, 0); pixels.push(v); },
      completeDmc(v) { assert.equal(v, 0xa5); },
    };
    const oam = new OamDma(bus), dmc = new DmcDma(bus); oam.start(2, false);
    while (oam.active || dmc.active) {
      cycle++;
      assert.ok(cycle < 520, 'arbitration must finish');
      if (cycle === requestAt) dmc.request(0xc000);
      const busy = dmc.step(!!(cycle % 2), 0x8000, oam.active);
      oam.step(!!(cycle % 2), busy);
    }
    assert.deepEqual(pixels, Array.from({ length: 256 }, (_, i) => i));
    assert.equal(fetches.length, 1);
    if (requestAt === 20) assert.equal(cycle, 516, 'a transfer in mid-OAM costs two extra cycles');
  }
});

test('DMC DMA restores every halt/dummy/alignment phase and reads memory only at completion', () => {
  for (const firstOdd of [false, true]) {
    let sample = 0x12;
    const events = [], bus = { readDma(a) { events.push(['r', a]); return sample; },
      completeDmc(v) { events.push(['done', v]); } };
    const dma = new DmcDma(bus); dma.request(0xc000);
    for (let cycle = 0; dma.active; cycle++) {
      const saved = dma.saveState(), otherEvents = [];
      const other = new DmcDma({ readDma(a) { otherEvents.push(['r', a]); return sample; },
        completeDmc(v) { otherEvents.push(['done', v]); } }); other.loadState(saved);
      sample++; const before = events.length, odd = !!((Number(firstOdd) + cycle) % 2);
      assert.equal(dma.step(odd, 0x4016, false), other.step(odd, 0x4016, false));
      assert.deepEqual(otherEvents, events.slice(before)); assert.deepEqual(dma.saveState(), other.saveState());
    }
    assert.deepEqual(events, [['r', 0x4016], ['r', 0xc000], ['done', sample]]);
    for (const invalid of [[0, 0, 1], [1, 0, 0], [0, 0x7f, 0], [0, 0xc0, 3]]) {
      assert.throws(() => dma.loadState(Uint8Array.from(invalid)), /Invalid DMC DMA state/);
    }
  }
});
