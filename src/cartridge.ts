import type { Mirroring, RomImage } from './rom.js';

export type NametableMirroring = Mirroring | 'single-lower' | 'single-upper';

/** Cartridge memory shared by the CPU bus, PPU data port, and renderer. */
export class Cartridge {
  /** Fixed registers + PRG RAM; CHR RAM cartridges append their pattern memory. */
  static readonly STATE_SIZE = 26 + 0x2000;
  get stateSize(): number { return Cartridge.STATE_SIZE + (this.rom.chrRam ? this.chr.length : 0) + (this.rom.mapper === 225 ? 4 : 0); }
  private readonly extraRam = new Uint8Array(4);
  readonly prgRam = new Uint8Array(0x2000);
  private readonly chr: Uint8Array;
  private shift = 0x10;
  private control = 0x0c;
  private chr0 = 0;
  private chr1 = 0;
  private prg = 0; private chrBank = 0; private axBank=0; private gxBank=0; private gxChr=0; private m15Bank=0; private m15Mode=0; private m15Mirror=0; private m71Mirror=0; private m9Latch0=1; private m9Latch1=1; private m9Mirror=0; private m32Mode=0; private m32Mirror=0; private mmc3Select=0; private mmc3Regs=new Uint8Array(8); private mmc3Mirror=0; private mmc3Latch=0; private mmc3Counter=0; private mmc3Irq=false;

  private mmc3Pending = false;
  private mmc3RamDisabled = false;
  private mmc3RamProtected = false;
  private mmc3A12High = false;
  private mmc3A12Low = 0;
  get irqPending(): boolean { return this.rom.mapper === 4 && this.mmc3Pending; }

  constructor(readonly rom: RomImage) {
    if (rom.consoleType && rom.consoleType !== 'nes') throw new Error(`Unsupported console type: ${rom.consoleType}`);
    if (![0, 1, 2, 3, 4, 7, 9, 10, 11, 13, 15, 32, 34, 66, 71, 79, 87, 113, 140, 177, 180, 225, 241].includes(rom.mapper)) throw new Error(`Unsupported mapper: ${rom.mapper}`);
    if (rom.mapper === 1 && (rom.prgRom.length > 0x40000 || rom.chrRom.length > 0x20000)) {
      throw new Error('Extended MMC1 boards are not supported yet');
    }
    if ((rom.mapper === 9 || rom.mapper === 10) && rom.prgRom.length < 0x8000) throw new Error('MMC2/MMC4 require at least 32 KiB PRG');
    if (rom.mapper === 13 && rom.prgRom.length !== 0x8000) throw new Error('CPROM requires 32 KiB PRG');
    if (rom.mapper === 32 && rom.prgRom.length < 0x8000) throw new Error('Irem G-101 requires at least 32 KiB PRG');
    if (rom.mapper === 32 && (rom.prgRom.length % 0x4000 || rom.chrRom.length % 0x400)) throw new Error('Irem G-101 requires 16 KiB PRG and 1 KiB CHR banks');
    if (rom.mapper === 225) this.gxBank = 1;
    if (rom.mapper === 9 || rom.mapper === 10) this.m9Mirror = rom.mirroring === 'four-screen' ? 2 : rom.mirroring === 'vertical' ? 1 : 0;
    if (rom.mapper === 32) this.m32Mirror = rom.mirroring === 'four-screen' ? 2 : rom.mirroring === 'horizontal' ? 1 : 0;
    this.chr = rom.chrRam ? new Uint8Array(0x2000) : rom.chrRom;
    if (rom.trainer) this.prgRam.set(rom.trainer, 0x1000);
  }

  get mirroring(): NametableMirroring {
    if (this.rom.mapper === 7) return this.axBank&16 ? 'single-upper' : 'single-lower';
    if (this.rom.mapper === 4) return this.rom.mirroring === 'four-screen' ? 'four-screen' : this.mmc3Mirror ? 'horizontal' : 'vertical';
    if (this.rom.mapper === 15 || this.rom.mapper === 113 || this.rom.mapper === 177 || this.rom.mapper === 225) return this.m15Mirror ? 'horizontal' : 'vertical';
    if (this.rom.mapper === 71) return this.m71Mirror === 2 ? 'single-upper' : this.m71Mirror === 1 ? 'single-lower' : this.rom.mirroring;
    if (this.rom.mapper === 9 || this.rom.mapper === 10) return this.m9Mirror === 2 ? 'four-screen' : this.m9Mirror ? 'vertical' : 'horizontal';
    if (this.rom.mapper === 32) return this.m32Mirror === 2 ? 'four-screen' : this.m32Mirror ? 'horizontal' : 'vertical';
    if (this.rom.mapper !== 1) return this.rom.mirroring;
    switch (this.control & 3) {
      case 0: return 'single-lower';
      case 1: return 'single-upper';
      case 2: return 'vertical';
      default: return 'horizontal';
    }
  }

  /** Reset mapping without discarding cartridge RAM. */
  saveState(): Uint8Array { const out=new Uint8Array(this.stateSize); out.set([this.shift,this.control,this.chr0,this.chr1,this.prg,this.chrBank,this.axBank,this.gxBank,this.gxChr,this.mmc3Select,this.mmc3Mirror,...this.mmc3Regs,this.rom.mapper===9||this.rom.mapper===10?this.m9Latch0:this.mmc3Latch,this.rom.mapper===9||this.rom.mapper===10?this.m9Latch1:this.mmc3Counter,this.mmc3Irq?1:0,this.rom.mapper===4?this.mmc3A12Low:this.m15Bank,this.rom.mapper===15?this.m15Mode:this.rom.mapper===32?this.m32Mode:14,this.rom.mapper===9||this.rom.mapper===10?this.m9Mirror:this.rom.mapper===32?this.m32Mirror:this.rom.mapper===4?+this.mmc3A12High:this.rom.mapper===71?this.m71Mirror:this.m15Mirror]); out[25]=+this.mmc3Pending | (+this.mmc3RamDisabled << 1) | (+this.mmc3RamProtected << 2); out.set(this.prgRam,26); if(this.rom.chrRam)out.set(this.chr,Cartridge.STATE_SIZE); if(this.rom.mapper===225)out.set(this.extraRam,this.stateSize-4); return out; }
  validateState(state: Uint8Array): void { if(state.length!==this.stateSize || state[10]>1 || state[21]>1 || ((this.rom.mapper===9 || this.rom.mapper===10) && (state[19]>1 || state[20]>1)) || (this.rom.mapper===15 ? state[23]>3 : this.rom.mapper===32 ? state[23]>1 : state[23]!==13 && state[23]!==14) || (this.rom.mapper===4 && state[22]>3) || ((this.rom.mapper===9 || this.rom.mapper===10 || this.rom.mapper===32 || this.rom.mapper===71) ? state[24]>2 : state[24]>1) || state[25]>7 || (this.rom.mapper===225 && state.subarray(this.stateSize-4).some(value=>value>15))) throw new RangeError('Invalid cartridge state'); }
  loadState(state: Uint8Array): void { this.validateState(state); [this.shift,this.control,this.chr0,this.chr1,this.prg,this.chrBank,this.axBank,this.gxBank,this.gxChr,this.mmc3Select,this.mmc3Mirror]=state; this.mmc3Regs.set(state.subarray(11,19)); this.m9Latch0=this.rom.mapper===9||this.rom.mapper===10?state[19]:1; this.m9Latch1=this.rom.mapper===9||this.rom.mapper===10?state[20]:1; this.mmc3Latch=state[19]; this.mmc3Counter=state[20]; this.mmc3Irq=!!state[21]; this.mmc3Pending=!!(state[25]&1); this.mmc3RamDisabled=!!(state[25]&2); this.mmc3RamProtected=!!(state[25]&4); this.m15Bank=state[22]; this.m15Mode=this.rom.mapper===15?state[23]:0; this.m32Mode=this.rom.mapper===32?state[23]:0; this.m15Mirror=state[24]; this.m71Mirror=this.rom.mapper===71?state[24]:0; this.m9Mirror=this.rom.mapper===9||this.rom.mapper===10?state[24]:0; this.m32Mirror=this.rom.mapper===32?state[24]:0; this.mmc3A12Low=this.rom.mapper===4?state[22]:0; this.mmc3A12High=this.rom.mapper===4?!!state[24]:false; this.prgRam.set(state.subarray(26,Cartridge.STATE_SIZE)); if(this.rom.chrRam)this.chr.set(state.subarray(Cartridge.STATE_SIZE,Cartridge.STATE_SIZE+this.chr.length)); if(this.rom.mapper===225)this.extraRam.set(state.subarray(this.stateSize-4)); }

  reset(): void {
    this.shift = 0x10;
    this.control = 0x0c;
    this.chr0 = this.chr1 = this.prg = this.chrBank = this.axBank = this.gxBank = this.gxChr = this.m15Bank = 0; this.m15Mode=0; this.m15Mirror=0; this.m71Mirror=0; this.m9Latch0=this.m9Latch1=1; this.m9Mirror=this.rom.mapper===9||this.rom.mapper===10?(this.rom.mirroring==='four-screen'?2:this.rom.mirroring==='vertical'?1:0):0; this.m32Mode=0; this.m32Mirror=this.rom.mapper===32?(this.rom.mirroring==='four-screen'?2:this.rom.mirroring==='horizontal'?1:0):0; this.mmc3Select=0; this.mmc3Regs.fill(0); this.mmc3Mirror=0; this.mmc3Latch=0; this.mmc3Counter=0; this.mmc3Irq=false; this.mmc3Pending=false; this.mmc3RamDisabled=false; this.mmc3RamProtected=false; this.mmc3A12High=false; this.mmc3A12Low=0;
    if (this.rom.mapper === 225) this.gxBank = 1;
  }

  readCpu(address: number, openBus = 0): number {
    address &= 0xffff;
    if (this.rom.mapper === 225 && (address & 0xf800) === 0x5800) return this.extraRam[address & 3];
    if (address < 0x6000) return openBus;
    if (address < 0x8000) return this.ramEnabled ? this.prgRam[address - 0x6000] : openBus;
    const slot = (address - 0x8000) >>> 14;
    const count = this.rom.prgRom.length / 0x4000;
    let bank = slot;
    if (this.rom.mapper === 2) bank = slot === 0 ? this.prg : count - 1;
    if (this.rom.mapper === 180) bank = slot === 0 ? 0 : this.gxBank;
    if (this.rom.mapper === 9) { const count8 = count * 2, slot8 = (address - 0x8000) >>> 13, selected = slot8 === 0 ? this.prg % count8 : count8 - (4 - slot8); return this.rom.prgRom[(selected * 0x2000 + (address & 0x1fff)) % this.rom.prgRom.length]; }
    if (this.rom.mapper === 10) bank = address < 0xc000 ? this.prg : count - 1;
    if (this.rom.mapper === 32) {
      const count8 = count * 2, slot8 = (address - 0x8000) >>> 13;
      const selected = this.m32Mode === 0
        ? (slot8 === 0 ? this.prg : slot8 === 1 ? this.gxBank : count8 - (4 - slot8))
        : (slot8 === 0 ? count8 - 2 : slot8 === 1 ? this.gxBank : slot8 === 2 ? this.prg : count8 - 1);
      return this.rom.prgRom[(selected % count8) * 0x2000 + (address & 0x1fff)];
    }
    if (this.rom.mapper === 71) bank = slot === 0 ? this.gxBank : count - 1;
    if (this.rom.mapper === 7) bank = (this.axBank&15)*2 + slot;
    if (this.rom.mapper === 11) bank = (this.gxBank & 3) * 2 + slot;
    if (this.rom.mapper === 34) bank = this.gxBank * 2 + slot;
    if (this.rom.mapper === 15) {
      // ponytail: bit 7 selects mode-2 halves only; distinguish board variants when submapper metadata is supported.
      const slot8 = (address - 0x8000) >>> 13;
      const base = (this.m15Bank & 0x3f) * 2;
      let selected = base + slot8;
      if (this.m15Mode === 1) selected = (slot8 < 2 ? base : base | 14) + (slot8 & 1);
      if (this.m15Mode === 2) selected = base + (this.m15Bank >>> 7);
      if (this.m15Mode === 3) selected = base + (slot8 & 1);
      return this.rom.prgRom[(selected * 0x2000 + (address & 0x1fff)) % this.rom.prgRom.length];
    }
    if (this.rom.mapper === 79 || this.rom.mapper === 113 || this.rom.mapper === 140 || this.rom.mapper === 177 || this.rom.mapper === 241) bank = (this.rom.mapper === 79 ? this.gxBank & 1 : this.gxBank) * 2 + slot;
    if (this.rom.mapper === 225) { const b = address < 0xc000 ? this.m15Bank : this.gxBank; return this.rom.prgRom[((b % (this.rom.prgRom.length / 0x4000)) * 0x4000) + (address & 0x3fff)]; }
    if (this.rom.mapper === 4) { const b= this.rom.prgRom.length/0x2000; const last=b-1, second=last-1, r=this.mmc3Regs; const slot8=(address-0x8000)>>>13; const mode=this.mmc3Select&0x40; bank=mode?(slot8===0?second:slot8===1?r[7]:slot8===2?r[6]:last):(slot8===0?r[6]:slot8===1?r[7]:slot8===2?second:last); bank%=b; return this.rom.prgRom[bank*0x2000+(address&0x1fff)]; }
    if (this.rom.mapper === 66) bank = (this.gxBank&3)*2 + slot;
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

  writeCpu(address: number, value: number, consecutive = false): void {
    address &= 0xffff;
    value &= 255;
    if (this.rom.mapper === 140 && address >= 0x6000 && address < 0x8000) { this.gxChr = value & 15; this.gxBank = (value >>> 4) & 3; return; }
    if (this.rom.mapper === 177 && address >= 0x8000) { this.gxBank = value & 0x1f; this.m15Mirror = value & 0x20 ? 1 : 0; return; }
    if (this.rom.mapper === 225 && (address & 0xf800) === 0x5800) { this.extraRam[address & 3] = value & 15; return; }
    if (this.rom.mapper === 225 && address >= 0x8000) {
      const high = (address >>> 8) & 64, prg = ((address >>> 6) & 63) | high;
      this.gxChr = (address & 63) | high;
      this.m15Bank = address & 0x1000 ? prg : prg & 126;
      this.gxBank = address & 0x1000 ? prg : this.m15Bank + 1;
      this.m15Mirror = (address >>> 13) & 1;
      return;
    }
    if (this.rom.mapper === 241 && address >= 0x8000) { this.gxBank = value & 0x1f; return; }
    if ((this.rom.mapper === 79 || this.rom.mapper === 113) && (address & 0xe100) === 0x4100) {
      this.gxChr = (value & 7) | (this.rom.mapper === 113 ? (value & 0x40) >>> 3 : 0);
      this.gxBank = (value >>> 3) & (this.rom.mapper === 79 ? 1 : 7);
      if (this.rom.mapper === 113) this.m15Mirror = value & 0x80 ? 0 : 1;
      return;
    }
    if (this.rom.mapper === 87 && address >= 0x6000 && address < 0x8000) { this.chrBank = ((value & 1) << 1) | ((value & 2) >>> 1); return; }
    if (address < 0x6000) return;
    if (address < 0x8000) {
      if (this.ramEnabled && !(this.rom.mapper === 4 && this.mmc3RamProtected)) this.prgRam[address - 0x6000] = value;
      return;
    }
    if (this.rom.mapper === 2) this.prg = value;
    if (this.rom.mapper === 180) { this.gxBank = value; return; }
    if (this.rom.mapper === 71) { if ((address & 0xf000) === 0x9000) this.m71Mirror = 1 + ((value >>> 4) & 1); else this.gxBank = value; return; }
    if (this.rom.mapper === 9 || this.rom.mapper === 10) { switch (address & 0xf000) { case 0xa000: this.prg = value; break; case 0xb000: this.mmc3Regs[0] = value; break; case 0xc000: this.mmc3Regs[1] = value; break; case 0xd000: this.mmc3Regs[2] = value; break; case 0xe000: this.mmc3Regs[3] = value; break; case 0xf000: this.m9Mirror = (value & 1) ^ 1; break; } return; }
    if (this.rom.mapper === 11) { this.gxBank = value; return; }
    if (this.rom.mapper === 13) { this.chrBank = value; return; }
    if (this.rom.mapper === 32) {
      switch (address & 0xf000) {
        case 0x8000: this.prg = value & 0x1f; break;
        case 0x9000: this.m32Mode = (value >>> 1) & 1; if (this.m32Mirror !== 2) this.m32Mirror = value & 1; break;
        case 0xa000: this.gxBank = value & 0x1f; break;
        case 0xb000: this.mmc3Regs[address & 7] = value; break;
      }
      return;
    }
    if (this.rom.mapper === 34) { this.gxBank = value; return; }
    if (this.rom.mapper === 3) { this.chrBank = value; return; }
    if (this.rom.mapper === 7) { this.axBank=value; return; }
    if (this.rom.mapper === 15) { this.m15Mode = address & 3; this.m15Bank = value; this.m15Mirror = (value >>> 6) & 1; return; }
    if (this.rom.mapper === 66) { this.gxBank=value>>4; this.gxChr=value&3; return; }
    if (this.rom.mapper === 4) { const a=address&0xe001; if(a===0x8000)this.mmc3Select=value; else if(a===0x8001)this.mmc3Regs[this.mmc3Select&7]=value; else if(a===0xa000)this.mmc3Mirror=value&1; else if(a===0xa001){this.mmc3RamDisabled=!(value&0x80);this.mmc3RamProtected=!!(value&0x40);} else if(a===0xc000)this.mmc3Latch=value; else if(a===0xc001)this.mmc3Counter=0; else if(a===0xe000){this.mmc3Irq=false;this.mmc3Pending=false;} else if(a===0xe001)this.mmc3Irq=true; return; }
    if (this.rom.mapper !== 1) return;
    if (consecutive) return; // MMC1 ignores the second write of CPU RMW instructions.
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

  /** Compatibility hook for direct mapper tests; system timing uses clockA12. */
  clockScanline(): boolean {
    if (this.rom.mapper !== 4) return false;
    if (this.mmc3Counter === 0) this.mmc3Counter = this.mmc3Latch;
    else this.mmc3Counter--;
    if (this.mmc3Counter === 0 && this.mmc3Irq) this.mmc3Pending = true;
    return this.mmc3Pending;
  }

  /** Clock MMC3 from the PPU A12 line after its low-period filter. */
  clockA12(address: number): void {
    if (this.rom.mapper !== 4) return;
    const high = (address & 0x1000) !== 0;
    if (high && !this.mmc3A12High && this.mmc3A12Low >= 3) this.clockScanline();
    this.mmc3A12High = high;
    this.mmc3A12Low = high ? 0 : Math.min(3, this.mmc3A12Low + 1);
  }

  readChr(address: number): number { return this.chr[this.chrAddress(address)]; }

  writeChr(address: number, value: number): void {
    if (this.rom.chrRam && !(this.rom.mapper === 15 && this.m15Mode === 3)) this.chr[this.chrAddress(address)] = value & 255;
  }

  private get ramEnabled(): boolean { return this.rom.mapper === 4 ? !this.mmc3RamDisabled : this.rom.mapper !== 1 || !(this.prg & 16); }

  private chrAddress(address: number): number {
    address &= 0x1fff;
    if (this.rom.mapper === 9 || this.rom.mapper === 10) return this.mmc2ChrAddress(address);
    if (this.rom.mapper === 11) return ((this.gxBank >>> 4) % (this.chr.length / 0x2000)) * 0x2000 + address;
    if (this.rom.mapper === 13) return address < 0x1000 ? address : (this.chrBank % (this.chr.length / 0x1000)) * 0x1000 + (address & 0x0fff);
    if (this.rom.mapper === 32) return (this.mmc3Regs[(address >>> 10) & 7] % (this.chr.length / 0x400)) * 0x400 + (address & 0x3ff);
    if (this.rom.mapper === 66 || this.rom.mapper === 79 || this.rom.mapper === 113 || this.rom.mapper === 140 || this.rom.mapper === 225) return ((this.rom.mapper === 79 ? this.gxChr & 7 : this.gxChr) % (this.chr.length / 0x2000)) * 0x2000 + address;
    if (this.rom.mapper === 87) return (this.chrBank % (this.chr.length / 0x2000)) * 0x2000 + address;
    if (this.rom.mapper === 4) {
      // Inversion swaps the two 4KB halves. R0/R1 each select an aligned
      // 2KB pair; R2-R5 independently select the remaining four 1KB slots.
      const slot = (address >>> 10) ^ (this.mmc3Select & 0x80 ? 4 : 0);
      const bank = slot < 4
        ? (this.mmc3Regs[slot >>> 1] & 0xfe) | (slot & 1)
        : this.mmc3Regs[slot - 2];
      return (bank % (this.chr.length / 0x400)) * 0x400 + (address & 0x3ff);
    }
    if (this.rom.mapper === 3) return (this.chrBank % (this.chr.length / 0x2000)) * 0x2000 + address;
    if (this.rom.mapper !== 1) return address;
    const slot = address >>> 12;
    const bank = this.control & 16
      ? (slot === 0 ? this.chr0 : this.chr1)
      : (this.chr0 & ~1) + slot;
    return (bank % (this.chr.length / 0x1000)) * 0x1000 + (address & 0x0fff);
  }

  private mmc2ChrAddress(address: number): number {
    if ((address & 0x1ff0) === 0x0fd0) this.m9Latch0 = 0;
    else if ((address & 0x1ff0) === 0x0fe0) this.m9Latch0 = 1;
    else if ((address & 0x1ff0) === 0x1fd0) this.m9Latch1 = 0;
    else if ((address & 0x1ff0) === 0x1fe0) this.m9Latch1 = 1;
    const bank = address < 0x1000 ? (this.m9Latch0 ? this.mmc3Regs[1] : this.mmc3Regs[0]) : (this.m9Latch1 ? this.mmc3Regs[3] : this.mmc3Regs[2]);
    return (bank % (this.chr.length / 0x1000)) * 0x1000 + (address & 0xfff);
  }
}
