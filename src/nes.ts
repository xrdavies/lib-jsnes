import { parseRom, RomImage } from './rom.js';
import { Cpu6502, CpuBus } from './cpu.js';
import { Controller } from './controller.js';
import { Ppu } from './ppu.js';
export interface Frame { readonly pixels: Uint32Array; readonly width: 256; readonly height: 240; }
export class Nes implements CpuBus { readonly controller1 = new Controller(); readonly ppu = new Ppu(); readonly controller2 = new Controller(); readonly rom: RomImage; readonly frame = new Uint32Array(256 * 240); readonly cpu: Cpu6502; private readonly ram = new Uint8Array(0x800); private cycles = 0; private bank = 0;
  constructor(image: ArrayBuffer | Uint8Array) { this.rom=parseRom(image); this.cpu=new Cpu6502(this); }
  read(address:number){address&=0xffff; if(address<0x2000)return this.ram[address&0x7ff]; if(address>=0x2000 && address<0x4000)return this.ppu.readRegister(address); if(address===0x4016)return this.controller1.read(); if(address===0x4017)return this.controller2.read(); if(address>=0x8000){ if(this.rom.mapper===2){const bankSize=0x4000; const bankCount=this.rom.prgRom.length/bankSize; const i=address<0xc000 ? this.bank%bankCount*bankSize+address-0x8000 : (bankCount-1)*bankSize+address-0xc000; return this.rom.prgRom[i]; } const i=address-0x8000; return this.rom.prgRom[i%this.rom.prgRom.length];} return 0;}
  write(address:number,value:number){if(address>=0x2000 && address<0x4000){this.ppu.writeRegister(address,value); return;} if(address<0x2000)this.ram[address&0x7ff]=value&255; else if(address===0x4016){this.controller1.write(value); this.controller2.write(value);} else if(address>=0x8000 && this.rom.mapper===2)this.bank=value&255;}
  reset(){this.ram.fill(0); this.bank=0; this.frame.fill(0xff000000); this.cpu.reset(); this.cycles=0;}
  step(cycles=1){if(!Number.isInteger(cycles)||cycles<1)throw new RangeError('cycles must be a positive integer'); while(this.cycles<cycles){const used=this.cpu.step(); this.cycles+=used; this.ppu.step(used*3);}}
  saveState(): Uint8Array { const out=new Uint8Array(8+0x800); out.set(this.cpu.save()); out.set(this.ram,8); return out; }
  loadState(state: Uint8Array): void { if(state.length!==8+0x800) throw new RangeError('Invalid state size'); this.cpu.load(Array.from(state.slice(0,8))); this.ram.set(state.slice(8)); }
  runFrame():Frame{this.step(29780); return {pixels:this.frame,width:256,height:240};} get cycleCount(){return this.cycles;}
}
