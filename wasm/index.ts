// Minimal WASM ABI shared by browser hosts; the TypeScript core remains the reference implementation.
const ROM = new Uint8Array(0x80000);
const RAM = new Uint8Array(0x800);
const FRAME = new Uint32Array(256 * 240);
let romLength = 0; let pc = 0; let cycles = 0;
export function romWrite(index: i32, value: i32): void { if (index >= 0 && index < ROM.length) ROM[index] = value; }
export function loadRom(length: i32): void { romLength = length < 0 ? 0 : length > ROM.length ? ROM.length : length; }
export function reset(): void { RAM.fill(0); FRAME.fill(0xff000000); cycles=0; pc=romLength >= 0x4000 ? ROM[romLength - 4] | (ROM[romLength - 3]<<8) : 0x8000; }
export function step(count: i32): void { if(count>0) cycles += count; }
export function cycleCount(): i32 { return cycles; }
export function framePointer(): usize { return changetype<usize>(FRAME); }
export function frameLength(): i32 { return FRAME.length; }
