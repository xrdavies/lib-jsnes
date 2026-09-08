import { parseRom, RomImage } from './rom.js';
import { Cpu6502, CpuBus } from './cpu.js';
export interface Frame { readonly pixels: Uint32Array; readonly width: 256; readonly height: 240; }
export class Nes implements CpuBus { readonly rom: RomImage; readonly frame = new Uint32Array(256 * 240); readonly cpu: Cpu6502; private readonly ram = new Uint8Array(0x800); private cycles = 0;
  constructor(image: ArrayBuffer | Uint8Array) { this.rom=parseRom(image); this.cpu=new Cpu6502(this); }
  read(address:number){address&=0xffff; if(address<0x2000)return this.ram[address&0x7ff]; if(address>=0x8000){const i=address-0x8000; return this.rom.prgRom[i%this.rom.prgRom.length];} return 0;}
  write(address:number,value:number){if(address<0x2000)this.ram[address&0x7ff]=value&255;}
  reset(){this.ram.fill(0); this.frame.fill(0xff000000); this.cpu.reset(); this.cycles=0;}
  step(cycles=1){if(!Number.isInteger(cycles)||cycles<1)throw new RangeError('cycles must be a positive integer'); while(this.cycles<cycles)this.cycles+=this.cpu.step();}
  runFrame():Frame{this.step(29780); return {pixels:this.frame,width:256,height:240};} get cycleCount(){return this.cycles;}
}
