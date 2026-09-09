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
    this.dummy = odd ? 2 : 1; this.writing = false;
  }
  step(): void {
    if (!this.active) return;
    if (this.dummy) { this.dummy--; return; }
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
