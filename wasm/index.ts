import { Cpu6502, CpuBus } from '../dist-wasm/cpu.generated';
// Experimental WASM CPU core; rendering and audio are not implemented yet.
const ROM = new Uint8Array(0x80000), RAM = new Uint8Array(0x800), FRAME = new Uint32Array(256 * 240);
const PRG_RAM = new Uint8Array(0x2000);
let prgStart: i32 = 0, prgBanks: i32 = 0;
let mapper: i32 = 0, bank: i32 = 0;
class Bus implements CpuBus {
  read(address: i32): i32 { return read(address); }
  write(address: i32, value: i32): void { write(address, value); }
}
const cpu = new Cpu6502(new Bus());
function read(address: i32): i32 {
  address &= 0xffff;
  if (address < 0x2000) return RAM[address & 0x7ff];
  if (address < 0x6000 || prgBanks == 0) return 0;
  if (address < 0x8000) return PRG_RAM[address - 0x6000];
  const selected = mapper == 2
    ? (address < 0xc000 ? bank : prgBanks - 1)
    : ((address - 0x8000) >>> 14) % prgBanks;
  return ROM[prgStart + selected * 0x4000 + (address & 0x3fff)];
}
function write(address: i32, value: i32): void {
  address &= 0xffff;
  if (address < 0x2000) RAM[address & 0x7ff] = value & 255;
  else if (address >= 0x6000 && address < 0x8000) PRG_RAM[address - 0x6000] = value & 255;
  else if (address >= 0x8000 && mapper == 2 && prgBanks > 0) bank = (value & 255) % prgBanks;
}
export function romWrite(index:i32,value:i32):void{if(index>=0&&index<ROM.length)ROM[index]=value;}
export function loadRom(length: i32): void {
  prgBanks = 0;
  if (length < 16 || length > ROM.length) throw new RangeError('Invalid ROM length');
  if (ROM[0] != 78 || ROM[1] != 69 || ROM[2] != 83 || ROM[3] != 26) throw new Error('Invalid iNES header');
  if ((ROM[7] & 0x0c) != 0) throw new Error('WASM requires iNES 1.0');
  const selectedMapper = (ROM[6] >>> 4) | (ROM[7] & 0xf0);
  if (selectedMapper != 0 && selectedMapper != 2) throw new Error('Unsupported WASM mapper');
  const banks: i32 = ROM[4];
  if (banks == 0 || (selectedMapper == 0 && banks > 2)) throw new Error('Invalid PRG size');
  const start = 16 + ((ROM[6] & 4) != 0 ? 512 : 0);
  if (start + banks * 0x4000 + <i32>ROM[5] * 0x2000 > length) throw new Error('Truncated iNES ROM');
  prgStart = start;
  prgBanks = banks;
  mapper = selectedMapper;
  bank = 0;
  PRG_RAM.fill(0);
  if (start > 16) for (let i = 0; i < 512; i++) PRG_RAM[0x1000 + i] = ROM[16 + i];
}
export function reset(): void {
  RAM.fill(0); FRAME.fill(0xff000000); bank = 0;
  cpu.a = cpu.x = cpu.y = 0;
  cpu.reset();
}
export function step(count: i32): void {
  if (count <= 0) return;
  let remaining = count;
  while (remaining > 0) remaining -= cpu.step();
}
export function cycleCount(): f64 { return cpu.cycles; }
export function programCounter(): i32 { return cpu.pc; }
export function cpuRegister(index: i32): i32 {
  switch (index) {
    case 0: return cpu.a;
    case 1: return cpu.x;
    case 2: return cpu.y;
    case 3: return cpu.sp;
    case 4: return cpu.p;
    default: return cpu.pc;
  }
}
export function unknownOpcodeCount(): i32 { return cpu.unknownOpcodes; }
export function ramRead(index:i32):i32{return index>=0&&index<RAM.length?RAM[index]:0;}
export function framePointer():usize{return changetype<usize>(FRAME.buffer)+FRAME.byteOffset;}
export function frameLength():i32{return FRAME.length;}
