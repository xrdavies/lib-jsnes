export interface WasmExports {
  readonly memory: WebAssembly.Memory;
  romWrite(index: number, value: number): void;
  loadRom(length: number): void;
  reset(): void;
  step(cycles: number): void;
  cycleCount(): number;
  programCounter(): number;
  framePointer(): number;
  frameLength(): number;
}

/** Thin browser/Node wrapper around the optional AssemblyScript build. */
export class WasmCore {
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
    for (let i = 0; i < rom.length; i++) this.exports.romWrite(i, rom[i]);
    this.exports.loadRom(rom.length);
  }

  reset(): void { this.exports.reset(); }
  step(cycles: number): void { this.exports.step(cycles); }
  get cycleCount(): number { return this.exports.cycleCount(); }
  get programCounter(): number { return this.exports.programCounter(); }
  frame(): Uint32Array { return new Uint32Array(this.exports.memory.buffer, this.exports.framePointer(), this.exports.frameLength()); }
}
