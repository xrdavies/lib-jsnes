// WASM cartridge storage for iNES NROM, UxROM, CNROM, and GxROM boards.
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

  get mirroring(): string {
    return this.flags & 8 ? 'four-screen' : this.flags & 1 ? 'vertical' : 'horizontal';
  }
  reset(): void { this.bank = 0; this.chrBank = 0; }
  readCpu(address: i32): i32 {
    if (address < 0x6000 || this.prgBanks == 0) return 0;
    if (address < 0x8000) return this.prgRam[address - 0x6000];
    const selected = this.mapper == 2
      ? (address < 0xc000 ? this.bank : this.prgBanks - 1)
      : this.mapper == 66 ? (this.bank * 2 + ((address - 0x8000) >>> 14)) % this.prgBanks
      : ((address - 0x8000) >>> 14) % this.prgBanks;
    return this.rom[this.prgStart + selected * 0x4000 + (address & 0x3fff)];
  }
  writeCpu(address: i32, value: i32): void {
    if (address >= 0x6000 && address < 0x8000) this.prgRam[address - 0x6000] = value & 255;
    else if (address >= 0x8000 && this.mapper == 2 && this.prgBanks > 0) this.bank = (value & 255) % this.prgBanks;
    else if (address >= 0x8000 && this.mapper == 3 && this.rom[5] > 0) this.chrBank = (value & 255) % this.rom[5];
    else if (address >= 0x8000 && this.mapper == 66) {
      this.bank = (value >>> 4) & 3;
      this.chrBank = this.hasChrRom ? (value & 3) % this.rom[5] : 0;
    }
  }
  readChr(address: i32): i32 {
    return this.hasChrRom ? this.rom[this.chrStart + this.chrBank * 0x2000 + (address & 0x1fff)] : this.chrRam[address & 0x1fff];
  }
  writeChr(address: i32, value: i32): void {
    if (!this.hasChrRom) this.chrRam[address & 0x1fff] = value & 255;
  }
  load(length: i32): void {
    this.prgBanks = 0;
    if (length < 16 || length > this.rom.length) throw new RangeError('Invalid ROM length');
    if (this.rom[0] != 78 || this.rom[1] != 69 || this.rom[2] != 83 || this.rom[3] != 26) throw new Error('Invalid iNES header');
    if ((this.rom[7] & 0x0c) != 0) throw new Error('WASM requires iNES 1.0');
    const mapper = (this.rom[6] >>> 4) | (this.rom[7] & 0xf0);
    if (mapper != 0 && mapper != 2 && mapper != 3 && mapper != 66) throw new Error('Unsupported WASM mapper');
    const banks: i32 = this.rom[4];
    if (banks == 0 || (mapper == 0 && banks > 2)) throw new Error('Invalid PRG size');
    const start = 16 + ((this.rom[6] & 4) != 0 ? 512 : 0);
    if (start + banks * 0x4000 + <i32>this.rom[5] * 0x2000 > length) throw new Error('Truncated iNES ROM');
    this.prgStart = start;
    this.prgBanks = banks;
    this.chrStart = start + banks * 0x4000;
    this.hasChrRom = this.rom[5] != 0;
    this.flags = this.rom[6];
    this.mapper = mapper;
    this.chrBank = 0;
    this.bank = 0;
    this.prgRam.fill(0);
    this.chrRam.fill(0);
    if (start > 16) for (let i = 0; i < 512; i++) this.prgRam[0x1000 + i] = this.rom[16 + i];
  }
}
