// WASM cartridge storage for NROM, MMC1, UxROM, CNROM, AxROM, and GxROM boards.
export class Cartridge {
  readonly rom: Uint8Array = new Uint8Array(0x80000);
  readonly prgRam: Uint8Array = new Uint8Array(0x2000);
  private readonly chrRam: Uint8Array = new Uint8Array(0x2000);
  private prgStart: i32 = 0;
  private prgBanks: i32 = 0;
  private chrStart: i32 = 0;
  private hasChrRom: boolean = false;
  private flags: i32 = 0;
  private mapper: i32 = 0;
  private bank: i32 = 0;
  private chrBank: i32 = 0;
  private mirror: i32 = 0;
  private shift: i32 = 0x10;
  private control: i32 = 0x0c;
  private chrLow: i32 = 0;
  private chrHigh: i32 = 0;
  private chrBytes: i32 = 0x2000;

  get mirroring(): string {
    if (this.mapper == 1) {
      switch (this.control & 3) {
        case 0: return 'single-lower';
        case 1: return 'single-upper';
        case 2: return 'vertical';
        default: return 'horizontal';
      }
    }
    return this.mapper == 7 ? (this.mirror ? 'single-upper' : 'single-lower') : this.flags & 8 ? 'four-screen' : this.flags & 1 ? 'vertical' : 'horizontal';
  }
  reset(): void {
    this.bank = 0; this.chrBank = 0; this.mirror = 0;
    this.shift = 0x10; this.control = 0x0c; this.chrLow = this.chrHigh = 0;
  }
  private get ramEnabled(): boolean { return this.mapper != 1 || (this.bank & 16) == 0; }
  readCpu(address: i32): i32 {
    if (address < 0x6000 || this.prgBanks == 0) return 0;
    if (address < 0x8000) return this.ramEnabled ? this.prgRam[address - 0x6000] : 0;
    let selected = this.mapper == 2
      ? (address < 0xc000 ? this.bank : this.prgBanks - 1)
      : this.mapper == 66 || this.mapper == 7 ? (this.bank * 2 + ((address - 0x8000) >>> 14)) % this.prgBanks
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
  writeCpu(address: i32, value: i32): void {
    if (address >= 0x6000 && address < 0x8000) {
      if (this.ramEnabled) this.prgRam[address - 0x6000] = value & 255;
    }
    else if (address >= 0x8000 && this.mapper == 1) {
      // ponytail: instruction-level writes; consecutive-cycle suppression needs CPU bus timestamps.
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
    else if (address >= 0x8000 && this.mapper == 2 && this.prgBanks > 0) this.bank = (value & 255) % this.prgBanks;
    else if (address >= 0x8000 && this.mapper == 7) { this.bank = value & 15; this.mirror = (value >>> 4) & 1; }
    else if (address >= 0x8000 && this.mapper == 3 && this.rom[5] > 0) this.chrBank = (value & 255) % this.rom[5];
    else if (address >= 0x8000 && this.mapper == 66) {
      this.bank = (value >>> 4) & 3;
      this.chrBank = this.hasChrRom ? (value & 3) % this.rom[5] : 0;
    }
  }
  readChr(address: i32): i32 {
    if (this.mapper == 1) {
      const offset = this.mmc1ChrAddress(address);
      return this.hasChrRom ? this.rom[this.chrStart + offset] : this.chrRam[offset];
    }
    return this.hasChrRom ? this.rom[this.chrStart + this.chrBank * 0x2000 + (address & 0x1fff)] : this.chrRam[address & 0x1fff];
  }
  writeChr(address: i32, value: i32): void {
    if (!this.hasChrRom) this.chrRam[this.mapper == 1 ? this.mmc1ChrAddress(address) : address & 0x1fff] = value & 255;
  }
  private mmc1ChrAddress(address: i32): i32 {
    address &= 0x1fff;
    const slot = address >>> 12;
    const bank = this.control & 16 ? (slot == 0 ? this.chrLow : this.chrHigh) : (this.chrLow & 30) + slot;
    return (bank % (this.chrBytes / 0x1000)) * 0x1000 + (address & 0xfff);
  }
  load(length: i32): void {
    this.prgBanks = 0;
    if (length < 16 || length > this.rom.length) throw new RangeError('Invalid ROM length');
    if (this.rom[0] != 78 || this.rom[1] != 69 || this.rom[2] != 83 || this.rom[3] != 26) throw new Error('Invalid iNES header');
    const nes2 = (this.rom[7] & 0x0c) == 8;
    if (!nes2 && (this.rom[7] & 0x0c) != 0) throw new Error('Unsupported ROM format');
    // Widen bytes before shifting: u8 << 8 would discard the extension bits.
    const mapperExtension: i32 = this.rom[8], sizeExtension: i32 = this.rom[9];
    if (nes2 && ((sizeExtension & 15) == 15 || (sizeExtension >>> 4) == 15)) throw new Error('Unsupported NES 2.0 size encoding');
    const mapper = (this.rom[6] >>> 4) | (this.rom[7] & 0xf0) | (nes2 ? ((mapperExtension & 15) << 8) : 0);
    if (mapper != 0 && mapper != 1 && mapper != 2 && mapper != 3 && mapper != 7 && mapper != 66) throw new Error('Unsupported WASM mapper');
    const banks: i32 = this.rom[4] | (nes2 ? ((sizeExtension & 15) << 8) : 0);
    if (banks == 0 || (mapper == 0 && banks > 2)) throw new Error('Invalid PRG size');
    const start = 16 + ((this.rom[6] & 4) != 0 ? 512 : 0);
    const chrBanks: i32 = this.rom[5] | (nes2 ? ((sizeExtension >>> 4) << 8) : 0);
    if (mapper == 1 && (banks > 16 || chrBanks > 16)) throw new Error('Extended MMC1 boards are not supported yet');
    if (start + banks * 0x4000 + chrBanks * 0x2000 > length) throw new Error('Truncated ROM');
    this.prgStart = start;
    this.prgBanks = banks;
    this.chrStart = start + banks * 0x4000;
    this.hasChrRom = chrBanks != 0;
    this.chrBytes = chrBanks == 0 ? 0x2000 : chrBanks * 0x2000;
    this.flags = this.rom[6];
    this.mapper = mapper;
    this.reset();
    this.prgRam.fill(0);
    this.chrRam.fill(0);
    if (start > 16) for (let i = 0; i < 512; i++) this.prgRam[0x1000 + i] = this.rom[16 + i];
  }
}
