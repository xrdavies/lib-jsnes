import { parseRom, RomImage } from './rom.js';
import { Cpu6502, CpuBus } from './cpu.js';
import { Controller } from './controller.js';
import { Ppu } from './ppu.js';
import { Cartridge } from './cartridge.js';
export interface Frame { readonly pixels: Uint32Array; readonly width: 256; readonly height: 240; }
export class Nes implements CpuBus {
  readonly controller1 = new Controller();
  readonly controller2 = new Controller();
  readonly rom: RomImage;
  readonly cartridge: Cartridge;
  readonly ppu: Ppu;
  readonly cpu: Cpu6502;
  private readonly ram = new Uint8Array(0x800);
  private cycles = 0;
  private dmaStall = 0;

  get frame(): Uint32Array { return this.ppu.frame; }

  constructor(image: ArrayBuffer | Uint8Array) {
    this.rom = parseRom(image);
    this.cartridge = new Cartridge(this.rom);
    this.ppu = new Ppu(this.cartridge);
    this.cpu = new Cpu6502(this);
  }

  read(address: number): number {
    address &= 0xffff;
    if (address < 0x2000) return this.ram[address & 0x7ff];
    if (address < 0x4000) return this.ppu.readRegister(address);
    if (address === 0x4016) return this.controller1.read();
    if (address === 0x4017) return this.controller2.read();
    return this.cartridge.readCpu(address);
  }

  write(address: number, value: number): void {
    address &= 0xffff;
    value &= 255;
    if (address < 0x2000) this.ram[address & 0x7ff] = value;
    else if (address < 0x4000) this.ppu.writeRegister(address, value);
    else if (address === 0x4016) {
      this.controller1.write(value);
      this.controller2.write(value);
    } else if (address === 0x4014) {
      this.dmaStall += 513;
      const bytes = new Uint8Array(256);
      for (let i = 0; i < 256; i++) bytes[i] = this.read((value << 8) + i);
      this.ppu.dma(bytes);
    } else this.cartridge.writeCpu(address, value);
  }
  reset(){this.ram.fill(0); this.cartridge.reset(); this.dmaStall=0; this.ppu.frame.fill(0xff000000); this.cpu.reset(); this.cycles=0;}
  step(cycles=1){if(!Number.isInteger(cycles)||cycles<1)throw new RangeError('cycles must be a positive integer'); while(this.cycles<cycles){if(this.dmaStall){const used=Math.min(this.dmaStall,cycles-this.cycles); this.dmaStall-=used; this.cycles+=used; this.ppu.step(used*3); continue;} const used=this.cpu.step(); this.cycles+=used; this.ppu.step(used*3);}}
  saveState(): Uint8Array { const cart=this.cartridge.saveState(), ppu=this.ppu.saveState(), out=new Uint8Array(11+cart.length+ppu.length+0x800); out.set(this.cpu.save()); out.set(cart,11); out.set(ppu,11+cart.length); out.set(this.ram,11+cart.length+ppu.length); return out; }
  loadState(state: Uint8Array): void { const cartSize=5+0x2000, ppuSize=0x4000+32+256+12; if(state.length!==11+cartSize+ppuSize+0x800) throw new RangeError('Invalid state size'); this.cpu.load(Array.from(state.subarray(0,11))); this.cartridge.loadState(state.subarray(11,11+cartSize)); this.ppu.loadState(state.subarray(11+cartSize,11+cartSize+ppuSize)); this.ram.set(state.subarray(11+cartSize+ppuSize)); }
  runFrame():Frame{this.step(29780); return {pixels:this.frame,width:256,height:240};} get cycleCount(){return this.cycles;}
}
