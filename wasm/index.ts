import { Cpu6502, CpuBus } from '../dist-wasm/cpu.generated';
import { Ppu } from '../dist-wasm/ppu.generated';
import { Apu, DmcBus } from '../dist-wasm/apu.generated';
import { Controller } from '../dist-wasm/controller.generated';
import { OamDma, OamDmaBus } from '../dist-wasm/dma.generated';
import { Cartridge, MAX_ROM_SIZE } from './cartridge';
const RAM = new Uint8Array(0x800);
const cartridge = new Cartridge();
const ppu = new Ppu(cartridge);
const apu = new Apu(new Bus());
const oamDma = new OamDma(new Bus());
let audio = new Int16Array(0);
const controller1 = new Controller(), controller2 = new Controller();
let dmaStall: i32 = 0;
let collectionCycles: i32 = 0;
let frameCompleted: boolean = false;
let openBus: i32 = 0;
let nmiPending: boolean = false, nmiPolled: boolean = false, irqPolled: boolean = false;
let nmiEarlier: boolean = false, irqEarlier: boolean = false;
class Bus implements CpuBus, DmcBus, OamDmaBus {
  readDma(address: i32): i32 { return read(address); }
  writeDma(value: i32): void { openBus = value; ppu.writeRegister(4, value); }
  readDmc(address: i32): i32 { dmaStall += 4; return read(address); }
  read(address: i32, cpuCycle: boolean): i32 {
    if (cpuCycle) beginCpuCycle();
    const value = read(address);
    if (cpuCycle) endCpuCycle();
    return value;
  }
  write(address: i32, value: i32, consecutive: boolean, oddCycle: boolean, cpuCycle: boolean): void {
    if (cpuCycle) beginCpuCycle();
    write(address, value, consecutive, oddCycle);
    if (cpuCycle) endCpuCycle();
  }
}
const cpu = new Cpu6502(new Bus());
function read(address: i32): i32 {
  address &= 0xffff;
  if (address == 0x4015) return apu.readStatus() | (openBus & 0x20);
  let value = openBus;
  if (address < 0x2000) value = RAM[address & 0x7ff];
  else if (address < 0x4000) value = ppu.readRegister(address);
  else if (address == 0x4016) value = controller1.read() | (openBus & 0xe0);
  else if (address == 0x4017) value = controller2.read() | (openBus & 0xe0);
  else if (address >= 0x4020) value = cartridge.readCpu(address, openBus);
  openBus = value;
  return value;
}
function write(address: i32, value: i32, consecutive: boolean, oddCycle: boolean): void {
  address &= 0xffff; value &= 255;
  openBus = value;
  if (address < 0x2000) RAM[address & 0x7ff] = value;
  else if (address < 0x4000) ppu.writeRegister(address, value);
  else if (address == 0x4014) {
    oamDma.start(value, oddCycle);
  } else if ((address >= 0x4000 && address <= 0x4015) || address == 0x4017) {
    apu.write(address, value);
  } else if (address == 0x4016) {
    controller1.write(value); controller2.write(value);
  } else cartridge.writeCpu(address, value, consecutive);
}
export function setController(player: i32, mask: i32): void {
  if (player == 1) controller1.setButtons(mask);
  else if (player == 2) controller2.setButtons(mask);
  else throw new RangeError('player must be 1 or 2');
}
export function romAllocate(length: i32): usize {
  if (length < 16 || length > MAX_ROM_SIZE) throw new RangeError('Invalid ROM capacity');
  cartridge.rom = new Uint8Array(length);
  __collect();
  return changetype<usize>(cartridge.rom.buffer) + cartridge.rom.byteOffset;
}
export function romWrite(index: i32, value: i32): void {
  if (index >= 0 && index < cartridge.rom.length) cartridge.rom[index] = value;
}
export function loadRom(length: i32): void {
  cartridge.load(length);
  cpu.a = cpu.x = cpu.y = 0;
  ppu.vram.fill(0); ppu.palette.fill(0); ppu.oam.fill(0);
}
export function reset(): void {
  nmiPending = nmiPolled = irqPolled = nmiEarlier = irqEarlier = false;
  RAM.fill(0); cartridge.reset(); ppu.reset(); apu.reset(); oamDma.reset(); audio = new Int16Array(0); dmaStall = 0;
  cpu.reset();
  collectionCycles = 0;
  __collect();
}
export function step(count: i32): void {
  if (count <= 0) return;
  // Match the JS host: allow instruction overshoot plus interrupt entry.
  if (cpu.cycles < 0 || cpu.cycles > 9007199254740991 - <f64>count - 14) {
    throw new RangeError('cycle budget exceeds the safe integer range');
  }
  let remaining = count;
  while (remaining > 0) {
    collectIfNeeded();
    if (dmaStall > 0) {
      const used = min(dmaStall, remaining);
      dmaStall -= used; remaining -= used; cpu.cycles += used;
      clockDevices(used);
      continue;
    }
    if (oamDma.active) { oamDma.step(); cpu.cycles++; remaining--; clockDevices(1); continue; }
    const used = cpu.step(); remaining -= used;
    if (used > cpu.busCycles) clockDevices(used - cpu.busCycles);
    ppu.consumeScanlines();
    if (cpu.interruptPollEarly ? nmiEarlier : nmiPolled) {
      nmiPending = false;
      if (cpu.nmi()) { cpu.cycles += 7; remaining -= 7; }
    } else if (irqPolled && (!cpu.interruptPollEarly || irqEarlier) && cpu.irqAfterInstruction()) { cpu.cycles += 7; remaining -= 7; }
  }
  collectIfNeeded();
}
export function runFrame(): void {
  frameCompleted = false;
  do {
    const dots = (262 - ppu.scanline) * 341 - ppu.dot;
    step(max(1, dots / 3));
  } while (!frameCompleted);
}
function clockDevices(cycles: i32): void {
  clockPpu(cycles * 3); apu.step(cycles);
  collectionCycles += cycles;
}
function clockPpu(dots: i32): void { frameCompleted = ppu.step(dots) || frameCompleted; }
function beginCpuCycle(): void {
  nmiEarlier = nmiPolled; irqEarlier = irqPolled;
  nmiPolled = nmiPending; irqPolled = apu.irqPending || cartridge.irqPending;
  clockPpu(2); apu.step(1); collectionCycles++;
}
function endCpuCycle(): void { clockPpu(1); nmiPending = ppu.consumeNmi() || nmiPending; }
function collectIfNeeded(): void {
  if (collectionCycles >= 29780) {
    collectionCycles = 0;
    // Minimal runtime collection is safe here: execution temporaries have returned,
    // and all live emulator state is reachable through module globals.
    __collect();
  }
}
export function sampleRate(): i32 { return apu.sampleRate; }
export function audioDrain(): i32 { audio = apu.drainSamples(); __collect(); return audio.length; }
export function audioPointer(): usize { return changetype<usize>(audio.buffer) + audio.byteOffset; }
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
export function chrRead(index:i32):i32{return cartridge.readChr(index);}
export function framePointer():usize{return changetype<usize>(ppu.frame.buffer)+ppu.frame.byteOffset;}
export function frameLength():i32{return ppu.frame.length;}
export function batteryRamPointer(): usize { return changetype<usize>(cartridge.prgRam.buffer) + cartridge.prgRam.byteOffset; }
export function batteryRamLength(): i32 { return cartridge.prgRam.length; }

export function cpuJammed(): boolean { return cpu.jammed; }
