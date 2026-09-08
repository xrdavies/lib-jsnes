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
  private prg = 0; private chrBank = 0; private axBank=0; private gxBank=0; private gxChr=0; private mmc3Select=0; private mmc3Regs=new Uint8Array(8); private mmc3Mirror=0;

  constructor(readonly rom: RomImage) {
    if (![0, 1, 2, 3, 4, 7, 66].includes(rom.mapper)) throw new Error(`Unsupported mapper: ${rom.mapper}`);
    if (rom.mapper === 1 && (rom.prgRom.length > 0x40000 || rom.chrRom.length > 0x20000)) {
      throw new Error('Extended MMC1 boards are not supported yet');
    }
    this.chr = rom.chrRam ? new Uint8Array(0x2000) : rom.chrRom;
    if (rom.trainer) this.prgRam.set(rom.trainer, 0x1000);
  }

  get mirroring(): NametableMirroring {
    if (this.rom.mapper === 7) return this.axBank&16 ? 'single-upper' : 'single-lower';
    if (this.rom.mapper === 4) return this.mmc3Mirror ? 'horizontal' : 'vertical';
    if (this.rom.mapper !== 1) return this.rom.mirroring;
    switch (this.control & 3) {
      case 0: return 'single-lower';
      case 1: return 'single-upper';
      case 2: return 'vertical';
      default: return 'horizontal';
    }
  }

  /** Reset mapping without discarding cartridge RAM. */
  saveState(): Uint8Array { const out=new Uint8Array(20+0x2000); out.set([this.shift,this.control,this.chr0,this.chr1,this.prg]); out.set(this.prgRam,20); return out; }
  loadState(state: Uint8Array): void { if(state.length!==20+0x2000) throw new RangeError('Invalid cartridge state'); [this.shift,this.control,this.chr0,this.chr1,this.prg,this.chrBank,this.axBank,this.gxBank,this.gxChr,this.mmc3Select,this.mmc3Mirror]=state; this.mmc3Regs.set(state.subarray(11,19)); this.prgRam.set(state.subarray(20)); }

  reset(): void {
    this.shift = 0x10;
    this.control = 0x0c;
    this.chr0 = this.chr1 = this.prg = this.chrBank = this.axBank = this.gxBank = this.gxChr = 0; this.mmc3Select=0; this.mmc3Regs.fill(0); this.mmc3Mirror=0;
  }

  readCpu(address: number): number {
    address &= 0xffff;
    if (address < 0x6000) return 0;
    if (address < 0x8000) return this.ramEnabled ? this.prgRam[address - 0x6000] : 0;
    const slot = (address - 0x8000) >>> 14;
    const count = this.rom.prgRom.length / 0x4000;
    let bank = slot;
    if (this.rom.mapper === 2) bank = slot === 0 ? this.prg : count - 1;
    if (this.rom.mapper === 7) bank = (this.axBank&15)*2 + slot;
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

  writeCpu(address: number, value: number): void {
    address &= 0xffff;
    value &= 255;
    if (address < 0x6000) return;
    if (address < 0x8000) {
      if (this.ramEnabled) this.prgRam[address - 0x6000] = value;
      return;
    }
    if (this.rom.mapper === 2) this.prg = value;
    if (this.rom.mapper === 3) { this.chrBank = value; return; }
    if (this.rom.mapper === 7) { this.axBank=value; return; }
    if (this.rom.mapper === 66) { this.gxBank=value>>4; this.gxChr=value&3; return; }
    if (this.rom.mapper === 4) { const a=address&0xe001; if(a===0x8000)this.mmc3Select=value; else if(a===0x8001)this.mmc3Regs[this.mmc3Select&7]=value; else if(a===0xa000)this.mmc3Mirror=value&1; return; }
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
    if (this.rom.mapper === 66) return (this.gxChr % (this.chr.length / 0x2000)) * 0x2000 + address;
    if (this.rom.mapper === 4) { const r=this.mmc3Regs, inv=!!(this.mmc3Select&0x80), bank=address>>>10; let b; if(!inv)b=bank<2?r[bank]&~1:bank<4?r[bank-2]|1:bank===4?r[4]:bank===5?r[5]:bank===6?r[0]:r[1]; else b=bank<2?r[2]:bank<4?r[3]:bank===4?r[0]:bank===5?r[1]:bank===6?r[4]:r[5]; return (b%(this.chr.length/0x400))*0x400+(address&0x3ff); }
    if (this.rom.mapper === 3) return (this.chrBank % (this.chr.length / 0x2000)) * 0x2000 + address;
    if (this.rom.mapper !== 1) return address;
    const slot = address >>> 12;
    const bank = this.control & 16
      ? (slot === 0 ? this.chr0 : this.chr1)
      : (this.chr0 & ~1) + slot;
    return (bank % (this.chr.length / 0x1000)) * 0x1000 + (address & 0x0fff);
  }
}
