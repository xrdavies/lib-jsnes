export interface OamDmaBus {
  readDma(address: number): number;
  writeDma(value: number): void;
}

/** Alternating OAM reads/writes; the host arbitrates DMC stalls and clocks devices. */
export class OamDma {
  static readonly STATE_SIZE = 6;
  private page = 0;
  private index = 256;
  private latch = 0;
  private dummy = 0;
  private writing = false;
  constructor(private readonly bus: OamDmaBus) {}
  get active(): boolean { return this.index < 256; }
  start(page: number, odd: boolean): void {
    this.page = page & 255; this.index = 0; this.latch = 0;
    // With this core's cycle count, DMA reads finish on odd cycles and writes
    // on even cycles. An even write needs halt + alignment before the first read.
    this.dummy = odd ? 1 : 2; this.writing = false;
  }
  step(oddCycle = !this.writing, busBusy = false): void {
    if (!this.active) return;
    if (this.dummy) { this.dummy--; return; }
    if (busBusy || oddCycle === this.writing) return;
    if (this.writing) { this.bus.writeDma(this.latch); this.index++; }
    else this.latch = this.bus.readDma(this.page * 256 + this.index) & 255;
    this.writing = !this.writing;
  }
  reset(): void { this.page = this.latch = this.dummy = 0; this.index = 256; this.writing = false; }
  saveState(): Uint8Array { return Uint8Array.of(this.page, this.index & 255, this.index >>> 8, this.latch, this.dummy, +this.writing); }
  static validateState(state: Uint8Array): void {
    if (state.length !== OamDma.STATE_SIZE || state[2] > 1 || (state[2] && state[1])
      || state[4] > 2 || state[5] > 1 || (state[2] && (state[4] || state[5]))
      || (state[4] && (state[1] || state[5]))) throw new RangeError('Invalid OAM DMA state');
  }
  loadState(state: Uint8Array): void {
    OamDma.validateState(state);
    this.page = state[0]; this.index = state[1] | (state[2] << 8);
    this.latch = state[3]; this.dummy = state[4]; this.writing = !!state[5];
  }
}

export interface DmcDmaBus {
  readDma(address: number): number;
  completeDmc(value: number): void;
}

/** Halt and dummy clocks can overlap OAM; only the final odd read owns the bus. */
export class DmcDma {
  static readonly STATE_SIZE = 3;
  private address = 0;
  private phase = 0;
  constructor(private readonly bus: DmcDmaBus) {}
  get active(): boolean { return this.address !== 0; }
  request(address: number): void { this.address = address; this.phase = 0; }
  step(oddCycle: boolean, heldAddress: number, oamActive: boolean): boolean {
    if (!this.active) return false;
    if (this.phase < 2) {
      if (!oamActive && (this.phase === 0 || (heldAddress !== 0x4016 && heldAddress !== 0x4017))) this.bus.readDma(heldAddress);
      this.phase++; return false;
    }
    if (!oddCycle) {
      if (!oamActive && heldAddress !== 0x4016 && heldAddress !== 0x4017) this.bus.readDma(heldAddress);
      return false;
    }
    const value = this.bus.readDma(this.address);
    this.reset(); this.bus.completeDmc(value);
    return true;
  }
  reset(): void { this.address = this.phase = 0; }
  saveState(): Uint8Array { return Uint8Array.of(this.address & 255, this.address >>> 8, this.phase); }
  static validateState(state: Uint8Array): void {
    if (state.length !== DmcDma.STATE_SIZE || state[2] > 2
      || (state[1] < 0x80 && (state[0] || state[1] || state[2]))) throw new RangeError('Invalid DMC DMA state');
  }
  loadState(state: Uint8Array): void {
    DmcDma.validateState(state); this.address = state[0] | (state[1] << 8); this.phase = state[2];
  }
}
