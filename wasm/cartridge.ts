// WASM cartridge storage and bank decoding for the supported boards.
// Largest linear NES 2.0 layout: header, trainer, 3839 PRG and CHR units.
export const MAX_ROM_SIZE: i32 = 16 + 512 + 0xeff * 0x6000;
export class Cartridge {
  rom: Uint8Array = new Uint8Array(0x80000);
  readonly prgRam: Uint8Array = new Uint8Array(0x2000);
  private readonly chrRam: Uint8Array = new Uint8Array(0x2000);
  private prgStart: i32 = 0;
  private prgBanks: i32 = 0;
  private chrStart: i32 = 0;
  private hasChrRom: boolean = false;
  private flags: i32 = 0;
  private mapper: i32 = 0;
  private bank: i32 = 0;
  private mmc2Latch0: i32 = 1;
  private mmc2Latch1: i32 = 1;
  private highBank: i32 = 1;
  private readonly extraRam: Uint8Array = new Uint8Array(4);
  private chrBank: i32 = 0;
  private mirror: i32 = 0;
  private m15Mode: i32 = 0;
  private m32Mode: i32 = 0;
  private shift: i32 = 0x10;
  private control: i32 = 0x0c;
  private chrLow: i32 = 0;
  private chrHigh: i32 = 0;
  private chrBytes: i32 = 0x2000;
  private mmc3Select: i32 = 0;
  private readonly mmc3Regs: Uint8Array = new Uint8Array(8);
  private irqLatch: i32 = 0;
  private irqCounter: i32 = 0;
  private irqEnabled: boolean = false;
  private pending: boolean = false;
  private ramDisabled: boolean = false;
  private ramProtected: boolean = false;
  private a12High: boolean = false;
  private a12Low: i32 = 0;
  get irqPending(): boolean { return this.mapper == 4 && this.pending; }
  // ponytail: fixed three-dot low filter; board-specific MMC3 revisions can tune it.
  clockScanline(): void {
    if (this.mapper != 4) return;
    if (this.irqCounter == 0) this.irqCounter = this.irqLatch;
    else this.irqCounter--;
    if (this.irqCounter == 0 && this.irqEnabled) this.pending = true;
  }
  clockA12(address: i32): void {
    if (this.mapper != 4) return;
    const high = (address & 0x1000) != 0;
    if (high && !this.a12High && this.a12Low >= 3) this.clockScanline();
    this.a12High = high;
    this.a12Low = high ? 0 : min(3, this.a12Low + 1);
  }

  get mirroring(): string {
    if (this.mapper == 15 || this.mapper == 113 || this.mapper == 177 || this.mapper == 225) return this.mirror ? 'horizontal' : 'vertical';
    if (this.mapper == 9 || this.mapper == 10) return this.mirror == 2 ? 'four-screen' : this.mirror ? 'vertical' : 'horizontal';
    if (this.mapper == 32) return this.mirror == 2 ? 'four-screen' : this.mirror ? 'horizontal' : 'vertical';
    if (this.mapper == 4) return this.flags & 8 ? 'four-screen' : this.mirror ? 'horizontal' : 'vertical';
    if (this.mapper == 1) {
      switch (this.control & 3) {
        case 0: return 'single-lower';
        case 1: return 'single-upper';
        case 2: return 'vertical';
        default: return 'horizontal';
      }
    }
    if (this.mapper == 152) return this.mirror ? 'single-upper' : 'single-lower';
    if (this.mapper == 71) return this.mirror == 2 ? 'single-upper' : this.mirror == 1 ? 'single-lower' : this.flags & 8 ? 'four-screen' : this.flags & 1 ? 'vertical' : 'horizontal';
    return this.mapper == 7 ? (this.mirror ? 'single-upper' : 'single-lower') : this.flags & 8 ? 'four-screen' : this.flags & 1 ? 'vertical' : 'horizontal';
  }
  reset(): void {
    this.bank = 0; this.highBank = 1; this.chrBank = 0; this.mirror = 0; this.m15Mode = 0; this.m32Mode = 0; this.mmc2Latch0 = this.mmc2Latch1 = 1;
    if (this.mapper == 9 || this.mapper == 10) this.mirror = this.flags & 8 ? 2 : this.flags & 1 ? 1 : 0;
    if (this.mapper == 32) { this.highBank = 0; this.mirror = this.flags & 8 ? 2 : this.flags & 1 ? 0 : 1; }
    this.shift = 0x10; this.control = 0x0c; this.chrLow = this.chrHigh = 0;
    this.mmc3Select = 0; this.mmc3Regs.fill(0);
    this.irqLatch = this.irqCounter = 0; this.irqEnabled = this.pending = false;
    this.ramDisabled = this.ramProtected = false; this.a12High = false; this.a12Low = 0;
  }
  private get ramEnabled(): boolean { return this.mapper == 4 ? !this.ramDisabled : this.mapper != 1 || (this.bank & 16) == 0; }
  readCpu(address: i32, openBus: i32 = 0): i32 {
    if (this.mapper == 225 && (address & 0xf800) == 0x5800) return this.extraRam[address & 3];
    if (address < 0x6000 || this.prgBanks == 0) return openBus;
    if (address < 0x8000) return this.ramEnabled ? this.prgRam[address - 0x6000] : openBus;
    if (this.mapper == 225) {
      const selected = address < 0xc000 ? this.bank : this.highBank;
      return this.rom[this.prgStart + (selected % this.prgBanks) * 0x4000 + (address & 0x3fff)];
    }
    if (this.mapper == 15) {
      // ponytail: bit 7 selects mode-2 halves only; distinguish board variants when submapper metadata is supported.
      const slot = (address - 0x8000) >>> 13, base = (this.bank & 0x3f) * 2;
      let selected = base + slot;
      if (this.m15Mode == 1) selected = (slot < 2 ? base : base | 14) + (slot & 1);
      if (this.m15Mode == 2) selected = base + (this.bank >>> 7);
      if (this.m15Mode == 3) selected = base + (slot & 1);
      return this.rom[this.prgStart + (selected * 0x2000 + (address & 0x1fff)) % (this.prgBanks * 0x4000)];
    }
    if (this.mapper == 4) {
      const count = this.prgBanks * 2, slot = (address - 0x8000) >>> 13;
      const swapped = (this.mmc3Select & 0x40) != 0;
      const bank = slot == 3 ? count - 1 : slot == 1 ? this.mmc3Regs[7]
        : slot == (swapped ? 2 : 0) ? this.mmc3Regs[6] : count - 2;
      return this.rom[this.prgStart + (bank % count) * 0x2000 + (address & 0x1fff)];
    }
    if (this.mapper == 9) {
      const count8 = this.prgBanks * 2, slot8 = (address - 0x8000) >>> 13;
      const selected = slot8 == 0 ? this.bank % count8 : count8 - (4 - slot8);
      return this.rom[this.prgStart + selected * 0x2000 + (address & 0x1fff)];
    }
    if (this.mapper == 10) {
      const selected = address < 0xc000 ? this.bank % this.prgBanks : this.prgBanks - 1;
      return this.rom[this.prgStart + selected * 0x4000 + (address & 0x3fff)];
    }
    if (this.mapper == 180) {
      const selected = address < 0xc000 ? 0 : this.bank % this.prgBanks;
      return this.rom[this.prgStart + selected * 0x4000 + (address & 0x3fff)];
    }
    if (this.mapper == 32) {
      const count8 = this.prgBanks * 2, slot8 = (address - 0x8000) >>> 13;
      const selected = this.m32Mode == 0
        ? (slot8 == 0 ? this.bank : slot8 == 1 ? this.highBank : count8 - (4 - slot8))
        : (slot8 == 0 ? count8 - 2 : slot8 == 1 ? this.highBank : slot8 == 2 ? this.bank : count8 - 1);
      return this.rom[this.prgStart + (selected % count8) * 0x2000 + (address & 0x1fff)];
    }
    if (this.mapper == 240) {
      const count32 = this.prgBanks / 2;
      return this.rom[this.prgStart + (this.bank % count32) * 0x8000 + (address & 0x7fff)];
    }
    let selected = this.mapper == 2 || this.mapper == 70 || this.mapper == 71 || this.mapper == 152
      ? (address < 0xc000 ? this.bank % this.prgBanks : this.prgBanks - 1)
      : this.mapper == 11 || this.mapper == 34 || this.mapper == 66 || this.mapper == 7 || this.mapper == 79 || this.mapper == 113 || this.mapper == 140 || this.mapper == 177 || this.mapper == 241 ? ((this.mapper == 7 ? this.bank & 15 : this.mapper == 11 || this.mapper == 66 ? this.bank & 3 : this.mapper == 79 ? this.bank & 1 : this.bank) * 2 + ((address - 0x8000) >>> 14)) % this.prgBanks
      : ((address - 0x8000) >>> 14) % this.prgBanks;
    if (this.mapper == 1) {
      const slot = (address - 0x8000) >>> 14, bank = this.bank & 15;
      switch ((this.control >>> 2) & 3) {
        case 0:
        case 1: selected = (bank & 14) + slot; break;
        case 2: selected = slot == 0 ? 0 : bank; break;
        default: selected = slot == 0 ? bank : this.prgBanks - 1; break;
      }
      selected %= this.prgBanks;
    }
    return this.rom[this.prgStart + selected * 0x4000 + (address & 0x3fff)];
  }
  writeCpu(address: i32, value: i32, consecutive: boolean = false): void {
    if (this.mapper == 225 && (address & 0xf800) == 0x5800) { this.extraRam[address & 3] = value & 15; return; }
    if (this.mapper == 240 && address >= 0x4020 && address < 0x6000) { this.bank = value >>> 4; this.chrBank = value & 15; return; }
    if (this.mapper == 225 && address >= 0x8000) {
      const high = (address >>> 8) & 64, selected = ((address >>> 6) & 63) | high;
      this.bank = address & 0x1000 ? selected : selected & 126;
      this.highBank = address & 0x1000 ? selected : this.bank + 1;
      this.chrBank = ((address & 63) | high);
      this.mirror = (address >>> 13) & 1;
      return;
    }
    if ((this.mapper == 79 || this.mapper == 113) && (address & 0xe100) == 0x4100) {
      this.bank = (value >>> 3) & (this.mapper == 79 ? 1 : 7);
      this.chrBank = ((value & 7) | (this.mapper == 113 ? (value & 0x40) >>> 3 : 0));
      if (this.mapper == 113) this.mirror = value & 0x80 ? 0 : 1;
      return;
    }
    if (address >= 0x6000 && address < 0x8000) {
      if (this.mapper == 87) {
        this.chrBank = (((value & 1) << 1) | ((value & 2) >>> 1));
        return;
      }
      if (this.mapper == 140) {
        this.bank = (value >>> 4) & 3;
        this.chrBank = value & 15;
        return;
      }
      if (this.ramEnabled && !(this.mapper == 4 && this.ramProtected)) this.prgRam[address - 0x6000] = value & 255;
    }
    else if (address >= 0x8000 && this.mapper == 4) {
      switch (address & 0xe001) {
        case 0x8000: this.mmc3Select = value; break;
        case 0x8001: this.mmc3Regs[this.mmc3Select & 7] = value; break;
        case 0xa000: this.mirror = value & 1; break;
        case 0xa001: this.ramDisabled = !(value & 0x80); this.ramProtected = (value & 0x40) != 0; break;
        case 0xc000: this.irqLatch = value; break;
        case 0xc001: this.irqCounter = 0; break;
        case 0xe000: this.irqEnabled = this.pending = false; break;
        case 0xe001: this.irqEnabled = true; break;
      }
    }
    else if (address >= 0x8000 && this.mapper == 1) {
      if (consecutive) return; // Ignore the second CPU RMW write.
      if (value & 0x80) { this.shift = 0x10; this.control |= 0x0c; return; }
      const complete = this.shift & 1;
      this.shift = (this.shift >>> 1) | ((value & 1) << 4);
      if (!complete) return;
      switch ((address >>> 13) & 3) {
        case 0: this.control = this.shift; break;
        case 1: this.chrLow = this.shift; break;
        case 2: this.chrHigh = this.shift; break;
        case 3: this.bank = this.shift; break;
      }
      this.shift = 0x10;
    }
    else if (address >= 0x8000 && (this.mapper == 177 || this.mapper == 241)) {
      this.bank = value & 31;
      if (this.mapper == 177) this.mirror = (value >>> 5) & 1;
    }
    else if (address >= 0x8000 && this.mapper == 15) {
      this.m15Mode = address & 3; this.bank = value; this.mirror = (value >>> 6) & 1;
    }
    else if (address >= 0x8000 && (this.mapper == 9 || this.mapper == 10)) {
      switch (address & 0xf000) {
        case 0xa000: this.bank = value; break;
        case 0xb000: this.mmc3Regs[0] = value; break;
        case 0xc000: this.mmc3Regs[1] = value; break;
        case 0xd000: this.mmc3Regs[2] = value; break;
        case 0xe000: this.mmc3Regs[3] = value; break;
        case 0xf000: this.mirror = (value & 1) ^ 1; break;
      }
    }
    else if (address >= 0x8000 && this.mapper == 32) {
      switch (address & 0xf000) {
        case 0x8000: this.bank = value & 0x1f; break;
        case 0x9000: this.m32Mode = (value >>> 1) & 1; if (!(this.flags & 8)) this.mirror = value & 1; break;
        case 0xa000: this.highBank = value & 0x1f; break;
        case 0xb000: this.mmc3Regs[address & 7] = value; break;
      }
    }
    else if (address >= 0x8000 && this.mapper == 71) {
      if ((address & 0xf000) == 0x9000) this.mirror = 1 + ((value >>> 4) & 1); else this.bank = value & 255;
    }
    else if (address >= 0x8000 && this.mapper == 2 && this.prgBanks > 0) this.bank = value & 255;
    else if (address >= 0x8000 && (this.mapper == 70 || this.mapper == 152)) { this.bank = (value >>> 4) & 7; this.chrBank = value & 15; if (this.mapper == 152) this.mirror = value >>> 7; }
    else if (address >= 0x8000 && this.mapper == 180) this.bank = value & 255;
    else if (address >= 0x8000 && this.mapper == 11) this.bank = value & 255;
    else if (address >= 0x8000 && this.mapper == 13) this.chrBank = value & 255;
    else if (address >= 0x8000 && this.mapper == 34) this.bank = value & 255;
    else if (address >= 0x8000 && this.mapper == 7) { this.bank = value & 255; this.mirror = (value >>> 4) & 1; }
    else if (address >= 0x8000 && this.mapper == 3) this.chrBank = value & 255;
    else if (address >= 0x8000 && this.mapper == 66) {
      this.bank = value >>> 4;
      this.chrBank = value & 3;
    }
  }
  readChr(address: i32): i32 {
    if (this.mapper == 4) {
      const offset = this.mmc3ChrAddress(address);
      return this.hasChrRom ? this.rom[this.chrStart + offset] : this.chrRam[offset];
    }
    if (this.mapper == 1) {
      const offset = this.mmc1ChrAddress(address);
      return this.hasChrRom ? this.rom[this.chrStart + offset] : this.chrRam[offset];
    }
    if (this.mapper == 9 || this.mapper == 10) {
      const offset = this.mmc2ChrAddress(address);
      return this.hasChrRom ? this.rom[this.chrStart + offset] : this.chrRam[offset];
    }
    if (this.mapper == 32) {
      address &= 0x1fff;
      const offset = (this.mmc3Regs[(address >>> 10) & 7] % (this.chrBytes / 0x400)) * 0x400 + (address & 0x3ff);
      return this.hasChrRom ? this.rom[this.chrStart + offset] : this.chrRam[offset];
    }
    if (this.mapper == 11) return this.hasChrRom
      ? this.rom[this.chrStart + ((this.bank >>> 4) % (this.chrBytes / 0x2000)) * 0x2000 + (address & 0x1fff)]
      : this.chrRam[address & 0x1fff];
    if (this.mapper == 13) {
      const offset = address < 0x1000 ? address : (this.chrBank % (this.chrBytes / 0x1000)) * 0x1000 + (address & 0xfff);
      return this.hasChrRom ? this.rom[this.chrStart + offset] : this.chrRam[offset];
    }
    return this.hasChrRom ? this.rom[this.chrStart + (this.chrBank % (this.chrBytes / 0x2000)) * 0x2000 + (address & 0x1fff)] : this.chrRam[address & 0x1fff];
  }
  writeChr(address: i32, value: i32): void {
    if (!this.hasChrRom && !(this.mapper == 15 && this.m15Mode == 3)) this.chrRam[this.mapper == 1 ? this.mmc1ChrAddress(address)
      : this.mapper == 4 ? this.mmc3ChrAddress(address) : this.mapper == 9 || this.mapper == 10 ? this.mmc2ChrAddress(address) : this.mapper == 13 ? (address < 0x1000 ? address : (this.chrBank % (this.chrBytes / 0x1000)) * 0x1000 + (address & 0xfff)) : this.mapper == 32 ? (this.mmc3Regs[(address >>> 10) & 7] % (this.chrBytes / 0x400)) * 0x400 + (address & 0x3ff) : address & 0x1fff] = value & 255;
  }
  private mmc3ChrAddress(address: i32): i32 {
    address &= 0x1fff;
    const slot = (address >>> 10) ^ (this.mmc3Select & 0x80 ? 4 : 0);
    const bank = slot < 4 ? (this.mmc3Regs[slot >>> 1] & 0xfe) | (slot & 1) : this.mmc3Regs[slot - 2];
    return (bank % (this.chrBytes / 0x400)) * 0x400 + (address & 0x3ff);
  }
  private mmc1ChrAddress(address: i32): i32 {
    address &= 0x1fff;
    const slot = address >>> 12;
    const bank = this.control & 16 ? (slot == 0 ? this.chrLow : this.chrHigh) : (this.chrLow & 30) + slot;
    return (bank % (this.chrBytes / 0x1000)) * 0x1000 + (address & 0xfff);
  }
  private mmc2ChrAddress(address: i32): i32 {
    address &= 0x1fff;
    if ((address & 0x1ff0) == 0x0fd0) this.mmc2Latch0 = 0;
    else if ((address & 0x1ff0) == 0x0fe0) this.mmc2Latch0 = 1;
    else if ((address & 0x1ff0) == 0x1fd0) this.mmc2Latch1 = 0;
    else if ((address & 0x1ff0) == 0x1fe0) this.mmc2Latch1 = 1;
    const bank = address < 0x1000 ? (this.mmc2Latch0 ? this.mmc3Regs[1] : this.mmc3Regs[0]) : (this.mmc2Latch1 ? this.mmc3Regs[3] : this.mmc3Regs[2]);
    return (bank % (this.chrBytes / 0x1000)) * 0x1000 + (address & 0xfff);
  }
  get stateSize(): i32 {
    if (!this.prgBanks) throw new Error('Load a ROM before saving or restoring state');
    return 26 + 0x2000 + (this.hasChrRom ? 0 : 0x2000) + (this.mapper == 225 ? 4 : 0);
  }
  saveState(): Uint8Array {
    const out = new Uint8Array(this.stateSize);
    out[0] = this.shift; out[1] = this.control; out[2] = this.chrLow; out[3] = this.chrHigh;
    if (this.mapper == 1 || this.mapper == 2 || this.mapper == 9 || this.mapper == 10 || this.mapper == 32) out[4] = this.bank;
    if (this.mapper == 3 || this.mapper == 13 || this.mapper == 87) out[5] = this.chrBank;
    if (this.mapper == 7) out[6] = this.bank;
    if (this.mapper == 11 || this.mapper == 32 || this.mapper == 34 || this.mapper == 66 || this.mapper == 70 || this.mapper == 71 || this.mapper == 79 || this.mapper == 113 || this.mapper == 140 || this.mapper == 152 || this.mapper == 177 || this.mapper == 180 || this.mapper == 240 || this.mapper == 241) out[7] = this.mapper == 32 ? this.highBank : this.bank;
    if (this.mapper == 225) out[7] = this.highBank;
    if (this.mapper == 66 || this.mapper == 70 || this.mapper == 79 || this.mapper == 113 || this.mapper == 140 || this.mapper == 152 || this.mapper == 225 || this.mapper == 240) out[8] = this.chrBank;
    out[9] = this.mmc3Select; out[10] = this.mapper == 4 ? this.mirror : 0;
    out.set(this.mmc3Regs, 11); out[19] = this.irqLatch; out[20] = this.irqCounter;
    out[21] = this.irqEnabled ? 1 : 0;
    if (this.mapper == 15 || this.mapper == 225) out[22] = this.bank;
    else if (this.mapper == 4) out[22] = this.a12Low;
    out[23] = this.mapper == 15 ? this.m15Mode : this.mapper == 32 ? this.m32Mode : 14;
    if (this.mapper == 9 || this.mapper == 10) { out[19] = this.mmc2Latch0; out[20] = this.mmc2Latch1; }
    if (this.mapper == 15 || this.mapper == 32 || this.mapper == 71 || this.mapper == 113 || this.mapper == 152 || this.mapper == 177 || this.mapper == 225 || this.mapper == 9 || this.mapper == 10) out[24] = this.mirror;
    else if (this.mapper == 4) out[24] = this.a12High ? 1 : 0;
    out[25] = (this.pending ? 1 : 0) | (this.ramDisabled ? 2 : 0) | (this.ramProtected ? 4 : 0);
    out.set(this.prgRam, 26);
    if (!this.hasChrRom) out.set(this.chrRam, 26 + 0x2000);
    if (this.mapper == 225) out.set(this.extraRam, out.length - 4);
    return out;
  }
  validateState(state: Uint8Array): void {
    if (state.length != this.stateSize || state[10] > 1 || state[21] > 1 || ((this.mapper == 9 || this.mapper == 10) && (state[19] > 1 || state[20] > 1)) || (this.mapper == 4 && state[22] > 3) || (this.mapper == 9 || this.mapper == 10 || this.mapper == 32 || this.mapper == 71 ? state[24] > 2 : state[24] > 1) || state[25] > 7
      || (this.mapper == 15 ? state[23] > 3 : this.mapper == 32 ? state[23] > 1 : state[23] != 13 && state[23] != 14)) throw new RangeError('Invalid cartridge state');
    if (this.mapper == 225) for (let i = state.length - 4; i < state.length; i++) {
      if (state[i] > 15) throw new RangeError('Invalid cartridge state');
    }
  }
  loadState(state: Uint8Array): void {
    this.validateState(state);
    this.shift = state[0]; this.control = state[1]; this.chrLow = state[2]; this.chrHigh = state[3];
    this.bank = this.mapper == 1 || this.mapper == 2 || this.mapper == 9 || this.mapper == 10 || this.mapper == 32 ? state[4] : this.mapper == 7 ? state[6]
      : this.mapper == 15 || this.mapper == 225 ? state[22] : state[7];
    this.chrBank = this.mapper == 3 || this.mapper == 13 || this.mapper == 87 ? state[5] : this.mapper == 79 ? state[8] & 7 : state[8];
    this.mmc2Latch0 = this.mapper == 9 || this.mapper == 10 ? state[19] : 1; this.mmc2Latch1 = this.mapper == 9 || this.mapper == 10 ? state[20] : 1;
    this.highBank = state[7]; this.m15Mode = this.mapper == 15 ? state[23] : 0; this.m32Mode = this.mapper == 32 ? state[23] : 0;
    this.mirror = this.mapper == 4 ? state[10] : this.mapper == 7 ? (this.bank >>> 4) & 1 : state[24];
    this.a12Low = this.mapper == 4 ? state[22] : 0; this.a12High = this.mapper == 4 && state[24] != 0;
    this.mmc3Select = state[9]; this.mmc3Regs.set(state.subarray(11, 19));
    this.irqLatch = state[19]; this.irqCounter = state[20]; this.irqEnabled = !!state[21];
    this.pending = !!(state[25] & 1); this.ramDisabled = !!(state[25] & 2); this.ramProtected = !!(state[25] & 4);
    this.prgRam.set(state.subarray(26, 26 + 0x2000));
    if (!this.hasChrRom) this.chrRam.set(state.subarray(26 + 0x2000, 26 + 0x4000));
    if (this.mapper == 225) this.extraRam.set(state.subarray(state.length - 4));
  }
  load(length: i32): void {
    this.prgBanks = 0;
    if (length < 16 || length > this.rom.length) throw new RangeError('Invalid ROM length');
    if (this.rom[0] != 78 || this.rom[1] != 69 || this.rom[2] != 83 || this.rom[3] != 26) throw new Error('Invalid iNES header');
    const nes2 = (this.rom[7] & 0x0c) == 8;
    if (!nes2 && (this.rom[7] & 0x0c) != 0) throw new Error('Unsupported ROM format');
    if ((this.rom[7] & 3) != 0) throw new Error('Unsupported console type');
    // Widen bytes before shifting: u8 << 8 would discard the extension bits.
    const mapperExtension: i32 = this.rom[8], sizeExtension: i32 = this.rom[9];
    const exponentSize = (value: i32): i32 => {
      const exponent = value >>> 2, multiplier = (value & 3) * 2 + 1;
      if (exponent > 30) throw new Error('NES 2.0 ROM size is too large');
      const size = (<i64>1 << exponent) * multiplier;
      if (size > MAX_ROM_SIZE) throw new Error('NES 2.0 ROM size exceeds WASM capacity');
      return <i32>size;
    };
    const mapper = (this.rom[6] >>> 4) | (this.rom[7] & 0xf0) | (nes2 ? ((mapperExtension & 15) << 8) : 0);
    if (mapper != 0 && mapper != 1 && mapper != 2 && mapper != 3 && mapper != 4 && mapper != 7 && mapper != 9 && mapper != 10 && mapper != 11 && mapper != 13 && mapper != 15 && mapper != 32 && mapper != 34 && mapper != 66 && mapper != 70 && mapper != 71 && mapper != 79 && mapper != 87 && mapper != 113 && mapper != 140 && mapper != 152 && mapper != 177 && mapper != 180 && mapper != 225 && mapper != 240 && mapper != 241) throw new Error('Unsupported WASM mapper');
    const prgSize: i32 = nes2 && (sizeExtension & 15) == 15 ? exponentSize(this.rom[4]) : (this.rom[4] | (nes2 ? ((sizeExtension & 15) << 8) : 0)) * 0x4000;
    const chrSize: i32 = nes2 && (sizeExtension >>> 4) == 15 ? exponentSize(this.rom[5]) : (this.rom[5] | (nes2 ? ((sizeExtension >>> 4) << 8) : 0)) * 0x2000;
    if (prgSize == 0 || (mapper == 0 && prgSize > 0x8000) || (mapper == 13 && prgSize != 0x8000) || ((mapper == 9 || mapper == 10 || mapper == 32) && prgSize < 0x8000) || (mapper == 240 && prgSize % 0x8000 != 0) || prgSize % 0x4000 != 0) throw new Error('Invalid PRG size');
    const chrUnit = mapper == 4 || mapper == 32 ? 0x400 : mapper == 1 ? 0x1000 : 0x2000;
    if (chrSize % chrUnit != 0) throw new Error('Unsupported CHR bank size');
    const start = 16 + ((this.rom[6] & 4) != 0 ? 512 : 0);
    if (mapper == 1 && (prgSize > 0x40000 || chrSize > 0x20000)) throw new Error('Extended MMC1 boards are not supported yet');
    if (start + prgSize + chrSize > length) throw new Error('Truncated ROM');
    this.prgStart = start;
    this.prgBanks = prgSize / 0x4000;
    this.chrStart = start + prgSize;
    this.hasChrRom = chrSize != 0;
    this.chrBytes = chrSize == 0 ? 0x2000 : chrSize;
    this.flags = this.rom[6];
    this.mapper = mapper;
    this.reset();
    this.prgRam.fill(0); this.extraRam.fill(0);
    this.chrRam.fill(0);
    if (start > 16) for (let i = 0; i < 512; i++) this.prgRam[0x1000 + i] = this.rom[16 + i];
  }
}
