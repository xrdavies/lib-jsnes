import assert from 'node:assert/strict';
import test from 'node:test';
import { Nes } from '../dist/index.js';

// Synthetic bank markers keep the test independent of commercial ROMs.
function image(mapper = 1, prgBanks = 8, chrBanks = 4, flags = 0) {
  const bytes = new Uint8Array(16 + prgBanks * 0x4000 + chrBanks * 0x2000);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, prgBanks, chrBanks, ((mapper & 15) << 4) | flags, (mapper >>> 4) << 4]);
  for (let i = 0; i < prgBanks; i++) bytes.fill(i, 16 + i * 0x4000, 16 + (i + 1) * 0x4000);
  for (let i = 0; i < chrBanks * 2; i++) {
    const start = 16 + prgBanks * 0x4000 + i * 0x1000;
    bytes.fill(0x40 + i, start, start + 0x1000);
  }
  return bytes;
}
function serial(nes, address, value) {
  for (let bit = 0; bit < 5; bit++) nes.write(address, (value >> bit) & 1);
}
function address(nes, at) {
  nes.ppu.step(6); // Allow the preceding PPUDATA read to recover.

  nes.read(0x2002);
  nes.write(0x2006, at >> 8);
  nes.write(0x2006, at & 255);
}
function ppuRead(nes, at) {
  address(nes, at);
  if (at < 0x3f00) { nes.read(0x2007); nes.ppu.step(6); }
  return nes.read(0x2007);
}
function ppuWrite(nes, at, value) {
  address(nes, at);
  nes.write(0x2007, value);
}
function prgPair(nes) { return [nes.read(0x8000), nes.read(0xc000)]; }
function chrPair(nes) { return [ppuRead(nes, 0), ppuRead(nes, 0x1000)]; }

test('MMC1 powers up with its last PRG bank fixed and implements every PRG mode', () => {
  const nes = new Nes(image());
  assert.deepEqual(prgPair(nes), [0, 7]);
  serial(nes, 0xe000, 3);
  assert.deepEqual(prgPair(nes), [3, 7]);
  serial(nes, 0x8000, 8);
  assert.deepEqual(prgPair(nes), [0, 3]);
  for (const mode of [0, 4]) {
    serial(nes, 0x8000, mode);
    assert.deepEqual(prgPair(nes), [2, 3]);
  }
  serial(nes, 0xe000, 0x13); // RAM-enable bit must not select a PRG bank.
  assert.deepEqual(prgPair(nes), [2, 3]);
  nes.write(0x8000, 0x80);
  assert.deepEqual(prgPair(nes), [3, 7]);
});

test('MMC1 latches only on the fifth write, whose address selects the register', () => {
  const nes = new Nes(image());
  for (const bit of [1, 0, 1, 0]) nes.write(0x8000, bit);
  assert.deepEqual(prgPair(nes), [0, 7]);
  nes.write(0xe000, 0);
  assert.deepEqual(prgPair(nes), [5, 7]);
  nes.write(0xe000, 1);
  nes.write(0xe000, 0x80);
  serial(nes, 0xe000, 2);
  assert.deepEqual(prgPair(nes), [2, 7]);
});

test('MMC1 uses 4KB CHR bank numbers in both 8KB and split 4KB modes', () => {
  const nes = new Nes(image());
  assert.deepEqual(chrPair(nes), [0x40, 0x41]);
  serial(nes, 0xa000, 3);
  assert.deepEqual(chrPair(nes), [0x42, 0x43]);
  serial(nes, 0xc000, 6); // Ignored in 8KB mode, retained for 4KB mode.
  serial(nes, 0x8000, 0x1c);
  assert.deepEqual(chrPair(nes), [0x43, 0x46]);
  serial(nes, 0xa000, 31);
  serial(nes, 0xc000, 30);
  assert.deepEqual(chrPair(nes), [0x47, 0x46]);
  ppuWrite(nes, 0, 0xff);
  assert.equal(ppuRead(nes, 0), 0x47, 'CHR ROM must remain read-only');
});

test('MMC1 controls both single-screen layouts and horizontal/vertical mirroring', () => {
  const nes = new Nes(image());
  serial(nes, 0x8000, 0x0c);
  ppuWrite(nes, 0x2000, 11);
  assert.deepEqual([0x2000, 0x2400, 0x2800, 0x2c00].map(a => ppuRead(nes, a)), [11, 11, 11, 11]);
  serial(nes, 0x8000, 0x0d);
  ppuWrite(nes, 0x2400, 22);
  assert.deepEqual([0x2000, 0x2400, 0x2800, 0x2c00].map(a => ppuRead(nes, a)), [22, 22, 22, 22]);
  serial(nes, 0x8000, 0x0e);
  assert.deepEqual([0x2000, 0x2400, 0x2800, 0x2c00].map(a => ppuRead(nes, a)), [11, 22, 11, 22]);
  serial(nes, 0x8000, 0x0f);
  assert.deepEqual([0x2000, 0x2400, 0x2800, 0x2c00].map(a => ppuRead(nes, a)), [11, 11, 22, 22]);
});

test('CHR RAM is shared between PPU data-port writes and banked reads', () => {
  const nes = new Nes(image(1, 8, 0));
  ppuWrite(nes, 0, 0xa5);
  ppuWrite(nes, 0x1000, 0x5a);
  serial(nes, 0x8000, 0x1c);
  serial(nes, 0xa000, 1);
  serial(nes, 0xc000, 0);
  assert.deepEqual(chrPair(nes), [0x5a, 0xa5]);
  ppuWrite(nes, 0, 0x33);
  serial(nes, 0x8000, 0x0c);
  assert.deepEqual(chrPair(nes), [0xa5, 0x33]);
});

test('MMC1 PRG RAM survives disable/re-enable and mapper reset', () => {
  const nes = new Nes(image());
  nes.write(0x6000, 0x11);
  nes.write(0x7fff, 0x22);
  serial(nes, 0xe000, 0x10);
  nes.write(0x6000, 0x99);
  serial(nes, 0xe000, 0);
  assert.deepEqual([nes.read(0x6000), nes.read(0x7fff)], [0x11, 0x22]);
  serial(nes, 0xe000, 5);
  serial(nes, 0x8000, 0);
  nes.reset();
  assert.deepEqual(prgPair(nes), [0, 7]);
  assert.equal(nes.read(0x6000), 0x11);
});

test('NROM mirroring and UxROM switching retain their independent mappings', () => {
  const nrom = new Nes(image(0, 1, 1));
  assert.deepEqual(prgPair(nrom), [0, 0]);
  assert.deepEqual(chrPair(nrom), [0x40, 0x41]);
  nrom.write(0x8000, 0xff);
  assert.deepEqual(prgPair(nrom), [0, 0]);
  const uxrom = new Nes(image(2, 8, 0));
  uxrom.write(0xffff, 3);
  assert.deepEqual(prgPair(uxrom), [3, 7]);
  ppuWrite(uxrom, 0x123, 0x6d);
  assert.equal(ppuRead(uxrom, 0x123), 0x6d);
  uxrom.reset();
  assert.deepEqual(prgPair(uxrom), [0, 7]);
});

test('save/load restores CPU, mapper, PPU memory, and cartridge RAM', () => {
  const nes = new Nes(image(1, 8, 4));
  serial(nes, 0xe000, 3); ppuWrite(nes, 0x2000, 0x66); nes.write(0x6000, 0x77);
  const state = nes.saveState();
  serial(nes, 0xe000, 5); ppuWrite(nes, 0x2000, 0x11); nes.write(0x6000, 0x22);
  nes.loadState(state);
  assert.deepEqual(prgPair(nes), [3, 7]);
  assert.equal(ppuRead(nes, 0x2000), 0x66);
  assert.equal(nes.read(0x6000), 0x77);
  assert.equal(nes.cycleCount, 0); assert.equal(nes.audioSamples().length, 0);
});

test('CNROM switches the 8KB CHR bank without changing PRG mapping', () => {
  const nes = new Nes(image(3, 2, 4)); assert.deepEqual(prgPair(nes), [0, 1]); assert.deepEqual(chrPair(nes), [0x40, 0x41]);
  nes.write(0x8000, 2); assert.deepEqual(prgPair(nes), [0, 1]); assert.deepEqual(chrPair(nes), [0x44, 0x45]);
});

test('AxROM switches 32KB PRG banks and single-screen nametable', () => {
  const nes = new Nes(image(7, 4, 1)); assert.deepEqual(prgPair(nes), [0, 1]); nes.write(0x8000, 1); assert.deepEqual(prgPair(nes), [2, 3]);
  ppuWrite(nes, 0x2000, 9); assert.deepEqual([0x2000,0x2400,0x2800,0x2c00].map(a=>ppuRead(nes,a)), [9,9,9,9]);
});

test('GxROM switches PRG and CHR banks from one register', () => {
  const nes = new Nes(image(66, 8, 4)); nes.write(0x8000, 0x21); assert.deepEqual(prgPair(nes), [4,5]); assert.deepEqual(chrPair(nes), [0x42,0x43]);
});


test('mapper 79 switches 32KB PRG and 8KB CHR banks from $4100', () => {
  const nes = new Nes(image(79, 8, 8));
  nes.write(0x4100, 0x09);
  assert.deepEqual(prgPair(nes), [2, 3]);
  assert.deepEqual(chrPair(nes), [0x42, 0x43]);
  const state = nes.saveState(); nes.write(0x4100, 0); nes.loadState(state);
  assert.deepEqual(prgPair(nes), [2, 3]);
  assert.deepEqual(chrPair(nes), [0x42, 0x43]);
});

test('mapper 87 switches 8KB CHR banks from the $6000 register', () => {
  const nes = new Nes(image(87, 2, 8));
  assert.deepEqual(prgPair(nes), [0, 1]);
  nes.write(0x6000, 1); // Mapper swaps bits 0 and 1.
  assert.deepEqual(prgPair(nes), [0, 1]);
  assert.deepEqual(chrPair(nes), [0x44, 0x45]);
  const state = nes.saveState(); nes.write(0x6000, 0); nes.loadState(state);
  assert.deepEqual(chrPair(nes), [0x44, 0x45]);
});

test('mapper 113 switches PRG/CHR banks and selects mirroring at $4100', () => {
  const nes = new Nes(image(113, 8, 8));
  nes.write(0x4100, 0x89);
  assert.deepEqual(prgPair(nes), [2, 3]);
  assert.deepEqual(chrPair(nes), [0x42, 0x43]);
  assert.equal(nes.cartridge.mirroring, 'vertical');
  const state = nes.saveState(); nes.write(0x4100, 0); nes.loadState(state);
  assert.deepEqual(prgPair(nes), [2, 3]);
  assert.equal(nes.cartridge.mirroring, 'vertical');
});

test('mapper 140 switches 32KB PRG and 8KB CHR banks from $6000', () => {
  const nes = new Nes(image(140, 8, 16));
  nes.write(0x6000, 0x21);
  assert.deepEqual(prgPair(nes), [4, 5]);
  assert.deepEqual(chrPair(nes), [0x42, 0x43]);
  const state = nes.saveState(); nes.write(0x6000, 0); nes.loadState(state);
  assert.deepEqual(prgPair(nes), [4, 5]);
  assert.deepEqual(chrPair(nes), [0x42, 0x43]);
});

test('mapper 177 switches 32KB PRG and mirroring from any cartridge write', () => {
  const nes = new Nes(image(177, 8, 1));
  nes.write(0x8000, 0x25);
  assert.deepEqual(prgPair(nes), [2, 3]);
  assert.equal(nes.cartridge.mirroring, 'horizontal');
  const state = nes.saveState(); nes.write(0x9000, 0); nes.loadState(state);
  assert.deepEqual(prgPair(nes), [2, 3]);
  assert.equal(nes.cartridge.mirroring, 'horizontal');
});

test('cartridge rejects corrupt mapper snapshot flags atomically', () => {
  const nes = new Nes(image(140, 8, 16)); nes.write(0x6000, 0x21); const state = nes.cartridge.saveState();
  for (const offset of [10, 21, 23, 24]) {
    const corrupt = state.slice(); corrupt[offset] = offset === 23 ? 12 : 2;
    assert.throws(() => nes.cartridge.loadState(corrupt), /cartridge state/);
    assert.deepEqual(nes.cartridge.saveState(), state);
  }
});

test('MMC3 selects 8KB PRG slots and 1KB CHR banks', () => {
  const nes = new Nes(image(4, 8, 4)); nes.write(0x8000, 6); nes.write(0x8001, 3); assert.equal(nes.read(0x8000), 1); nes.write(0x8000, 0); nes.write(0x8001, 5); assert.equal(nes.cartridge.readChr(0), 0x41); nes.write(0x8000, 0x46); nes.write(0x8001, 2); assert.equal(nes.read(0x8000), 7);
});

test('MMC3 scanline counter raises an IRQ after the programmed interval', () => {
  const nes = new Nes(image(4, 8, 4)); nes.write(0xc000, 2); nes.write(0xc001, 0); nes.write(0xe001, 0); assert.equal(nes.cartridge.clockScanline(), false); assert.equal(nes.cartridge.clockScanline(), false); assert.equal(nes.cartridge.clockScanline(), true); nes.write(0xe000, 0); assert.equal(nes.cartridge.clockScanline(), false);
});

test('PPU enables an immediate NMI when NMI output is turned on during VBlank', () => {
  const nes=new Nes(image(0,1,1)); nes.ppu.step(241*341+1); assert.equal(nes.ppu.consumeNmi(),false); nes.ppu.writeRegister(0,0x80); assert.equal(nes.ppu.consumeNmi(),true);
});

test('PPU status reads preserve sprite hit and overflow bits', () => {
  const nes=new Nes(image(0,1,1)); nes.ppu.writeRegister(1,8); nes.ppu.step(262*341); nes.ppu.oam[0]=0; nes.ppu.oam[1]=0; nes.ppu.oam[2]=0; nes.ppu.oam[3]=0; nes.ppu.step(1); const first=nes.ppu.readRegister(2); const second=nes.ppu.readRegister(2); assert.equal(first&0x60,second&0x60);
});

test('PPU palette reads refresh the buffered data port', () => {
  const nes=new Nes(image(0,1,1)); ppuWrite(nes,0x2f00,0x2a); address(nes,0x3f00); assert.equal(nes.read(0x2007),0); address(nes,0x2f00); assert.equal(nes.read(0x2007),0x2a);
});

test('save/load restores PPU frame and scroll state', () => {
  const nes=new Nes(image(0,1,1)); nes.ppu.writeRegister(1,8); nes.runFrame(); const before=nes.frame[100], opaque=nes.ppu.backgroundOpaque[100]; const state=nes.saveState(); nes.ppu.writeRegister(1,0); nes.runFrame(); nes.loadState(state); assert.equal(nes.frame[100],before); assert.equal(nes.ppu.backgroundOpaque[100],opaque);
});

test('save/load restores APU oscillator state without stale samples', () => {
  const nes=new Nes(image(0,1,1)); nes.write(0x4000,0x4f); nes.write(0x4002,0x20); nes.write(0x4003,0x08); nes.write(0x4015,1); nes.step(10000); const state=nes.saveState(); nes.step(1000); nes.loadState(state); const a=nes.audioSamples(); nes.step(1000); const b=nes.audioSamples(); assert.equal(a.length,0); assert.ok(b.length>0);
});

test('save/load restores selected mapper bank', () => { const nes=new Nes(image(2,8,1)); nes.write(0x8000,4); const state=nes.saveState(); nes.write(0x8000,1); nes.loadState(state); assert.equal(nes.read(0x8000),4); });

test('APU sample queue remains bounded when the host does not drain it', () => {
  const nes=new Nes(image(0,1,1)); nes.write(0x4000,0x4f); nes.write(0x4002,0x20); nes.write(0x4003,0x08); nes.write(0x4015,1); nes.step(1789773*3); assert.ok(nes.apu['samples'].length <= 88200); assert.ok(nes.audioSamples().length <= 88200);
});

test('battery RAM can be persisted with strict length validation', () => { const nes=new Nes(image(1,1,1)); nes.write(0x6000,0x5a); const ram=nes.saveBatteryRam(); assert.equal(ram[0],0x5a); nes.write(0x6000,0); nes.loadBatteryRam(ram); assert.equal(nes.read(0x6000),0x5a); assert.throws(()=>nes.loadBatteryRam(new Uint8Array(1)),/8192/); });

test('PPU rendering resolves logical palette slots through palette RAM', () => { const nes=new Nes(image(0,1,0)); nes.ppu.writeRegister(1,8); for(let r=0;r<8;r++) { ppuWrite(nes,r,255); ppuWrite(nes,r+8,0); } ppuWrite(nes,0x2000,0); ppuWrite(nes,0x3f00,0x16); ppuWrite(nes,0x3f01,0x2a); nes.runFrame(); assert.equal(nes.frame[8],(0xff000000|0x5eea6f)>>>0); });

test('mapper 225 encodes PRG and CHR banks from address writes', () => { const nes=new Nes(image(225,16,16)); nes.write(0x8123,0); assert.deepEqual(prgPair(nes),[4,5]); assert.deepEqual(chrPair(nes),[0x46,0x47]); nes.write(0xc123,0); assert.deepEqual(prgPair(nes),[4,5]); assert.deepEqual(chrPair(nes),[0x46,0x47]); assert.equal(nes.cartridge.mirroring,'vertical'); const state=nes.saveState(); nes.write(0x8000,0); nes.loadState(state); assert.deepEqual(prgPair(nes),[4,5]); });

test('mapper 241 switches 32KB PRG bank from cartridge writes', () => { const nes=new Nes(image(241,16,1)); nes.write(0x8000,3); assert.deepEqual(prgPair(nes),[6,7]); const state=nes.saveState(); nes.write(0x8000,0); nes.loadState(state); assert.deepEqual(prgPair(nes),[6,7]); });
