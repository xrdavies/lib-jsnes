import { Cpu6502, CpuBus } from '../dist-wasm/cpu.generated';
import { Ppu } from '../dist-wasm/ppu.generated';
import { Controller } from '../dist-wasm/controller.generated';
import { Cartridge } from './cartridge';
const RAM = new Uint8Array(0x800);
const cartridge = new Cartridge();
const ppu = new Ppu(cartridge);
const controller1 = new Controller(), controller2 = new Controller();
let dmaStall: i32 = 0;
class Bus implements CpuBus {
  read(address: i32): i32 { return read(address); }
  write(address: i32, value: i32): void { write(address, value); }
}
const cpu = new Cpu6502(new Bus());
function read(address: i32): i32 {
  address &= 0xffff;
  if (address < 0x2000) return RAM[address & 0x7ff];
  if (address < 0x4000) return ppu.readRegister(address);
  if (address == 0x4016) return controller1.read();
  if (address == 0x4017) return controller2.read();
  return cartridge.readCpu(address);
}
function write(address: i32, value: i32): void {
  address &= 0xffff; value &= 255;
  if (address < 0x2000) RAM[address & 0x7ff] = value;
  else if (address < 0x4000) ppu.writeRegister(address, value);
  else if (address == 0x4014) {
    dmaStall += 513 + (<i32>cpu.cycles & 1);
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = read((value << 8) + i);
    ppu.dma(bytes);
  } else if (address == 0x4016) {
    controller1.write(value); controller2.write(value);
  } else cartridge.writeCpu(address, value);
}
export function setController(player: i32, mask: i32): void {
  if (player == 1) controller1.setButtons(mask);
  else if (player == 2) controller2.setButtons(mask);
  else throw new RangeError('player must be 1 or 2');
}
export function romWrite(index: i32, value: i32): void {
  if (index >= 0 && index < cartridge.rom.length) cartridge.rom[index] = value;
}
export function loadRom(length: i32): void {
  cartridge.load(length);
  ppu.vram.fill(0); ppu.palette.fill(0); ppu.oam.fill(0);
}
export function reset(): void {
  RAM.fill(0); cartridge.reset(); ppu.reset(); dmaStall = 0;
  cpu.a = cpu.x = cpu.y = 0;
  cpu.reset();
}
export function step(count: i32): void {
  if (count <= 0) return;
  let remaining = count;
  while (remaining > 0) {
    if (dmaStall > 0) {
      const used = min(dmaStall, remaining);
      dmaStall -= used; remaining -= used; cpu.cycles += used;
      ppu.step(used * 3);
      continue;
    }
    const used = cpu.step(); remaining -= used; ppu.step(used * 3);
    ppu.consumeScanlines();
    if (ppu.consumeNmi()) { cpu.nmi(); cpu.cycles += 7; remaining -= 7; ppu.step(21); }
  }
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
export function framePointer():usize{return changetype<usize>(ppu.frame.buffer)+ppu.frame.byteOffset;}
export function frameLength():i32{return ppu.frame.length;}
