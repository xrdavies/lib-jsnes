import { parseRom, RomImage } from './rom.js';
import { Cpu6502, CpuBus } from './cpu.js';
import { Controller } from './controller.js';
import { Ppu } from './ppu.js';
import { Cartridge } from './cartridge.js';
import { Apu } from './apu.js';
export interface Frame { readonly pixels: Uint32Array; readonly width: 256; readonly height: 240; }
export const NTSC_FRAME_RATE = 60;
export const FRAME_WIDTH = 256;
export const FRAME_HEIGHT = 240;
export class Nes implements CpuBus {
  readonly controller1 = new Controller();
  readonly controller2 = new Controller();
  readonly rom: RomImage;
  readonly cartridge: Cartridge;
  readonly ppu: Ppu;
  readonly cpu: Cpu6502;
  readonly apu = new Apu();
  private readonly ram = new Uint8Array(0x800);
  private cycles = 0;
  private dmaStall = 0; private readonly rgba = new Uint8ClampedArray(FRAME_WIDTH*FRAME_HEIGHT*4);

  get frame(): Uint32Array { return this.ppu.frame; }
  setController(player: 1|2, mask: number): void { if(player===1)this.controller1.setButtons(mask); else if(player===2)this.controller2.setButtons(mask); else throw new RangeError('player must be 1 or 2'); }
  audioSamples(): Int16Array { return this.apu.drainSamples(); }
  saveBatteryRam(): Uint8Array { return this.cartridge.prgRam.slice(); }
  loadBatteryRam(data: Uint8Array): void { if(data.length!==0x2000)throw new RangeError('Battery RAM must be 8192 bytes'); this.cartridge.prgRam.set(data); }
  frameRgba(): Uint8ClampedArray { const out=this.rgba; for(let i=0;i<this.frame.length;i++){const p=this.frame[i]; out[i*4]=p>>>16&255; out[i*4+1]=p>>>8&255; out[i*4+2]=p&255; out[i*4+3]=p>>>24&255;} return out; }

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
    if (address === 0x4015) return this.apu.readStatus();
    if (address === 0x4016) return this.controller1.read();
    if (address === 0x4017) return this.controller2.read();
    return this.cartridge.readCpu(address);
  }

  write(address: number, value: number): void {
    address &= 0xffff;
    value &= 255;
    if (address < 0x2000) this.ram[address & 0x7ff] = value;
    else if (address < 0x4000) this.ppu.writeRegister(address, value);
    else if (address === 0x4014) {
      this.dmaStall += 513 + (this.cpu.cycles & 1);
      const bytes = new Uint8Array(256);
      for (let i = 0; i < 256; i++) bytes[i] = this.read((value << 8) + i);
      this.ppu.dma(bytes);
    } else if (address >= 0x4000 && address <= 0x4015) this.apu.write(address, value);
    else if (address === 0x4016) {
      this.controller1.write(value);
      this.controller2.write(value);
    } else this.cartridge.writeCpu(address, value);
  }
  reset(){this.ram.fill(0); this.cartridge.reset(); this.apu.reset(); this.dmaStall=0; this.ppu.reset(); this.cpu.reset(); this.cycles=0;}
  step(cycles=1){if(!Number.isInteger(cycles)||cycles<1)throw new RangeError('cycles must be a positive integer'); const start=this.cpu.cycles, target=start+cycles; while(this.cpu.cycles<target){if(this.dmaStall){const used=Math.min(this.dmaStall,target-this.cpu.cycles); this.dmaStall-=used; this.cpu.cycles+=used; this.ppu.step(used*3); continue;} const used=this.cpu.step(); this.ppu.step(used*3); for(let i=0;i<this.ppu.consumeScanlines();i++)if(this.cartridge.clockScanline()){this.cpu.irq();this.cpu.cycles+=7;this.ppu.step(21);} if(this.ppu.consumeNmi()){this.cpu.nmi();this.cpu.cycles+=7;this.ppu.step(21);}} this.cycles=this.cpu.cycles; this.apu.step(this.cpu.cycles-start);}
  saveState(): Uint8Array { const cart=this.cartridge.saveState(), ppu=this.ppu.saveState(), apu=this.apu.saveState(), c1=this.controller1.saveState(), c2=this.controller2.saveState(), out=new Uint8Array(11+cart.length+ppu.length+apu.length+8+0x800); let o=0; out.set(this.cpu.save(),o);o+=11;out.set(cart,o);o+=cart.length;out.set(ppu,o);o+=ppu.length;out.set(apu,o);o+=apu.length;out.set(c1,o);o+=4;out.set(c2,o);o+=4;out.set(this.ram,o);return out; }
  loadState(state: Uint8Array): void { const cartSize=23+0x2000, ppuSize=0x4000+32+256+13+245760+61440+5, apuSize=32, size=11+cartSize+ppuSize+apuSize+8+0x800; if(state.length!==size)throw new RangeError('Invalid state size'); let o=0;this.cpu.load(Array.from(state.subarray(o,o+=11)));this.cycles=this.cpu.cycles;this.dmaStall=0;this.cartridge.loadState(state.subarray(o,o+=cartSize));this.ppu.loadState(state.subarray(o,o+=ppuSize));this.apu.loadState(state.subarray(o,o+=apuSize));this.controller1.loadState(state.subarray(o,o+=4));this.controller2.loadState(state.subarray(o,o+=4));this.ram.set(state.subarray(o)); }
  runFrame():Frame{this.step(29780); return {pixels:this.frame,width:256,height:240};} get cycleCount(){return this.cpu.cycles;}
}
