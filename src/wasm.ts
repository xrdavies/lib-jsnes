import { parseRom } from './rom.js';

export interface WasmExports {
  readonly memory: WebAssembly.Memory;
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
}

/** Thin browser/Node wrapper around the optional AssemblyScript build. */
export class WasmCore {
  static readonly FRAME_WIDTH = 256;
  static readonly FRAME_HEIGHT = 240;
  static readonly FRAME_CYCLES = 29780;
  static readonly MAX_ROM_SIZE = 0x80000;
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
    if ((rom[7] & 0x0c) !== 0) throw new Error('WASM requires iNES 1.0');
    if (![0, 2, 3, 7, 66].includes(image.mapper)) throw new Error(`Unsupported WASM mapper: ${image.mapper}`);
    if (image.mapper === 0 && image.prgRom.length > 0x8000) throw new Error('Invalid NROM PRG size');
    for (let i = 0; i < rom.length; i++) this.exports.romWrite(i, rom[i]);
    this.exports.loadRom(rom.length);
  }

  reset(): void { this.exports.reset(); }
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
}
