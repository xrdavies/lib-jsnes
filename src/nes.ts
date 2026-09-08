import { parseRom, RomImage } from './rom.js';
export interface Frame { readonly pixels: Uint32Array; readonly width: 256; readonly height: 240; }
export class Nes { readonly rom: RomImage; readonly frame = new Uint32Array(256 * 240); private cycles = 0;
  constructor(image: ArrayBuffer | Uint8Array) { this.rom = parseRom(image); }
  reset(): void { this.cycles = 0; this.frame.fill(0xff000000); }
  step(cycles = 1): void { if (!Number.isInteger(cycles) || cycles < 1) throw new RangeError('cycles must be a positive integer'); this.cycles += cycles; }
  runFrame(): Frame { this.step(29780); return { pixels: this.frame, width: 256, height: 240 }; }
  get cycleCount(): number { return this.cycles; }
}
