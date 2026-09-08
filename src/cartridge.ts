import type { Mirroring, RomImage } from './rom.js';

export type NametableMirroring = Mirroring | 'single-lower' | 'single-upper';

/** Cartridge memory shared by the CPU bus, PPU data port, and renderer. */
export class Cartridge {
  readonly prgRam = new Uint8Array(0x2000);
  private readonly chr: Uint8Array;
  private shift = 0x10;
  private control = 0x0c;
  private chr0 = 0;
  private chr1 = 0;
  private prg = 0;

  constructor(readonly rom: RomImage) {
    if (![0, 1, 2].includes(rom.mapper)) throw new Error(`Unsupported mapper: ${rom.mapper}`);
    if (rom.mapper === 1 && (rom.prgRom.length > 0x40000 || rom.chrRom.length > 0x20000)) {
      throw new Error('Extended MMC1 boards are not supported yet');
    }
    this.chr = rom.chrRam ? new Uint8Array(0x2000) : rom.chrRom;
    if (rom.trainer) this.prgRam.set(rom.trainer, 0x1000);
  }

  get mirroring(): NametableMirroring {
    if (this.rom.mapper !== 1) return this.rom.mirroring;
    switch (this.control & 3) {
      case 0: return 'single-lower';
      case 1: return 'single-upper';
      case 2: return 'vertical';
      default: return 'horizontal';
    }
  }

  /** Reset mapping without discarding cartridge RAM. */
  saveState(): Uint8Array { const out=new Uint8Array(5+0x2000); out.set([this.shift,this.control,this.chr0,this.chr1,this.prg]); out.set(this.prgRam,5); return out; }
  loadState(state: Uint8Array): void { if(state.length!==5+0x2000) throw new RangeError('Invalid cartridge state'); [this.shift,this.control,this.chr0,this.chr1,this.prg]=state; this.prgRam.set(state.subarray(5)); }

  reset(): void {
    this.shift = 0x10;
    this.control = 0x0c;
    this.chr0 = this.chr1 = this.prg = 0;
  }

  readCpu(address: number): number {
    address &= 0xffff;
    if (address < 0x6000) return 0;
    if (address < 0x8000) return this.ramEnabled ? this.prgRam[address - 0x6000] : 0;
    const slot = (address - 0x8000) >>> 14;
    const count = this.rom.prgRom.length / 0x4000;
    let bank = slot;
    if (this.rom.mapper === 2) bank = slot === 0 ? this.prg : count - 1;
    if (this.rom.mapper === 1) {
      const selected = this.prg & 15;
      switch ((this.control >>> 2) & 3) {
        case 0:
        case 1: bank = (selected & ~1) + slot; break;
        case 2: bank = slot === 0 ? 0 : selected; break;
        case 3: bank = slot === 0 ? selected : count - 1; break;
      }
    }
    return this.rom.prgRom[(bank % count) * 0x4000 + (address & 0x3fff)];
  }

  writeCpu(address: number, value: number): void {
    address &= 0xffff;
    value &= 255;
    if (address < 0x6000) return;
    if (address < 0x8000) {
      if (this.ramEnabled) this.prgRam[address - 0x6000] = value;
      return;
    }
    if (this.rom.mapper === 2) this.prg = value;
    if (this.rom.mapper !== 1) return;
    // ponytail: instruction-level bus; suppress consecutive-cycle writes when CPU bus timing is implemented.
    if (value & 0x80) {
      this.shift = 0x10;
      this.control |= 0x0c;
      return;
    }
    const complete = this.shift & 1;
    this.shift = (this.shift >>> 1) | ((value & 1) << 4);
    if (!complete) return;
    switch ((address >>> 13) & 3) {
      case 0: this.control = this.shift; break;
      case 1: this.chr0 = this.shift; break;
      case 2: this.chr1 = this.shift; break;
      case 3: this.prg = this.shift; break;
    }
    this.shift = 0x10;
  }

  readChr(address: number): number { return this.chr[this.chrAddress(address)]; }

  writeChr(address: number, value: number): void {
    if (this.rom.chrRam) this.chr[this.chrAddress(address)] = value & 255;
  }

  private get ramEnabled(): boolean { return this.rom.mapper !== 1 || !(this.prg & 16); }

  private chrAddress(address: number): number {
    address &= 0x1fff;
    if (this.rom.mapper !== 1) return address;
    const slot = address >>> 12;
    const bank = this.control & 16
      ? (slot === 0 ? this.chr0 : this.chr1)
      : (this.chr0 & ~1) + slot;
    return (bank % (this.chr.length / 0x1000)) * 0x1000 + (address & 0x0fff);
  }
}
