// Minimal WASM ABI shared by browser hosts; the TypeScript core remains the reference implementation.
const RAM = new Uint8Array(0x800);
const FRAME = new Uint32Array(256 * 240);
let prg = new Uint8Array(0); let pc = 0; let cycles = 0;
export function loadRom(ptr: usize, length: i32): void { prg = Uint8Array.wrap(changetype<ArrayBuffer>(ptr), length); }
export function reset(): void { RAM.fill(0); FRAME.fill(0xff000000); cycles=0; pc=prg.length > 0x7ffc ? prg[0x7ffc] | (prg[0x7ffd]<<8) : 0x8000; }
export function step(count: i32): void { if(count<0) return; cycles += count; }
export function cycleCount(): i32 { return cycles; }
export function framePointer(): usize { return changetype<usize>(FRAME); }
export function frameLength(): i32 { return FRAME.length; }
