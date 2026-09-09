import { parseRom } from './rom.js';

export interface WasmExports {
  readonly memory: WebAssembly.Memory;
  romAllocate(length: number): number;
  romWrite(index: number, value: number): void;
  loadRom(length: number): void;
  reset(): void;
  setController(player: number, mask: number): void;
  sampleRate(): number;
  audioDrain(): number;
  audioPointer(): number;
  step(cycles: number): void;
  cycleCount(): number;
  programCounter(): number;
  ramRead(index: number): number;
  chrRead(index: number): number;
  /** A, X, Y, SP, P, PC at indices 0 through 5. */
  cpuRegister(index: number): number;
  unknownOpcodeCount(): number;
  framePointer(): number;
  frameLength(): number;
  batteryRamPointer(): number;
  batteryRamLength(): number;
}

/** Thin browser/Node wrapper around the optional AssemblyScript build. */
export class WasmCore {
  static readonly FRAME_WIDTH = 256;
  static readonly FRAME_HEIGHT = 240;
  static readonly FRAME_CYCLES = 29780;
  // Largest supported linear NES 2.0 header plus optional trainer and ROM data.
  static readonly MAX_ROM_SIZE = 16 + 512 + 0xeff * 0x6000;
  private constructor(readonly exports: WasmExports) {}

  static async from(source: ArrayBuffer | Uint8Array | Response): Promise<WasmCore> {
    if (typeof Response !== 'undefined' && source instanceof Response) {
      if (!source.ok) throw new Error(`WASM request failed: ${source.status}`);
      source = await source.arrayBuffer();
    }
    const input = source;
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input as ArrayBuffer);
    const result = await WebAssembly.instantiate(bytes, { env: { abort() { throw new Error('WASM abort'); } } });
    const instance = ('instance' in result ? result.instance : result) as WebAssembly.Instance;
    return new WasmCore(instance.exports as unknown as WasmExports);
  }

  loadRom(rom: Uint8Array): void {
    if (rom.length > WasmCore.MAX_ROM_SIZE) throw new RangeError('ROM exceeds WASM capacity');
    const image = parseRom(rom);
    const format = rom[7] & 0x0c;
    if (format !== 0 && format !== 8) throw new Error('Unsupported ROM format');
    if (format === 8 && ((rom[9] & 15) === 15 || (rom[9] >>> 4) === 15)) throw new Error('Unsupported NES 2.0 size encoding');
    if (![0, 1, 2, 3, 4, 7, 15, 66, 87, 140, 177, 241].includes(image.mapper)) throw new Error(`Unsupported WASM mapper: ${image.mapper}`);
    if (image.mapper === 1 && (image.prgRom.length > 0x40000 || image.chrRom.length > 0x20000)) throw new Error('Extended MMC1 boards are not supported yet');
    if (image.mapper === 0 && image.prgRom.length > 0x8000) throw new Error('Invalid NROM PRG size');
    // Allocation may grow memory or reclaim its former ROM buffer.
    if (rom.buffer === this.exports.memory.buffer) rom = rom.slice();
    const pointer = this.exports.romAllocate(rom.length);
    new Uint8Array(this.exports.memory.buffer, pointer, rom.length).set(rom);
    this.exports.loadRom(rom.length);
  }

  reset(): void { this.exports.reset(); }
  saveBatteryRam(): Uint8Array {
    return new Uint8Array(this.exports.memory.buffer, this.exports.batteryRamPointer(), this.exports.batteryRamLength()).slice();
  }
  loadBatteryRam(data: Uint8Array): void {
    const length = this.exports.batteryRamLength();
    if (data.length !== length) throw new RangeError(`Battery RAM must be ${length} bytes`);
    new Uint8Array(this.exports.memory.buffer, this.exports.batteryRamPointer(), length).set(data);
  }
  get sampleRate(): number { return this.exports.sampleRate(); }
  audioSamples(): Int16Array {
    const length = this.exports.audioDrain();
    return new Int16Array(this.exports.memory.buffer, this.exports.audioPointer(), length).slice();
  }
  setController(player: 1 | 2, mask: number): void {
    if (player !== 1 && player !== 2) throw new RangeError('player must be 1 or 2');
    this.exports.setController(player, mask);
  }
  step(cycles: number): void {
    if (!Number.isInteger(cycles) || cycles < 1) throw new RangeError('cycles must be a positive integer');
    this.exports.step(cycles);
  }
  runFrame(cycles = WasmCore.FRAME_CYCLES): Uint32Array { this.step(cycles); return this.frame(); }
  get cycleCount(): number { return this.exports.cycleCount(); }
  get programCounter(): number { return this.exports.programCounter(); }
  frame(): Uint32Array { return new Uint32Array(this.exports.memory.buffer, this.exports.framePointer(), this.exports.frameLength()); }
  frameRgba(): Uint8ClampedArray {
    const pixels = this.frame(), rgba = new Uint8ClampedArray(pixels.length * 4);
    for (let i = 0; i < pixels.length; i++) { const pixel = pixels[i]; const offset = i * 4; rgba[offset] = pixel >>> 16 & 255; rgba[offset + 1] = pixel >>> 8 & 255; rgba[offset + 2] = pixel & 255; rgba[offset + 3] = pixel >>> 24 & 255; }
    return rgba;
  }
}
