import { parseRom, RomImage } from './rom.js';
import { Cpu6502, CpuBus } from './cpu.js';
import { Controller } from './controller.js';
import { Ppu, PPU_STATE_SIZE } from './ppu.js';
import { Cartridge } from './cartridge.js';
import { Apu } from './apu.js';
import { OamDma } from './dma.js';
export interface Frame { readonly pixels: Uint32Array; readonly width: 256; readonly height: 240; }
export const NTSC_FRAME_RATE = 1789773 * 3 / 89341.5;
export const FRAME_WIDTH = 256;
export const FRAME_HEIGHT = 240;
export class Nes implements CpuBus {
  readonly controller1 = new Controller();
  readonly controller2 = new Controller();
  readonly rom: RomImage;
  readonly cartridge: Cartridge;
  readonly ppu: Ppu;
  readonly cpu: Cpu6502;
  readonly apu = new Apu(this);
  private readonly ram = new Uint8Array(0x800);
  private cycles = 0;
  private frameCompleted = false;
  private readonly oamDma = new OamDma(this);
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

  write(address: number, value: number, consecutive = false): void {
    address &= 0xffff;
    value &= 255;
    if (address < 0x2000) this.ram[address & 0x7ff] = value;
    else if (address < 0x4000) this.ppu.writeRegister(address, value);
    else if (address === 0x4014) {
      this.oamDma.start(value, !!(this.cpu.cycles & 1));
    } else if ((address >= 0x4000 && address <= 0x4015) || address === 0x4017) this.apu.write(address, value);
    else if (address === 0x4016) {
      this.controller1.write(value);
      this.controller2.write(value);
    } else this.cartridge.writeCpu(address, value, consecutive);
  }
  reset(){this.ram.fill(0); this.cartridge.reset(); this.apu.reset(); this.oamDma.reset(); this.dmaStall=0; this.ppu.reset(); this.cpu.reset(); this.cycles=0;}
  step(cycles = 1): void {
    if (!Number.isInteger(cycles) || cycles < 1) throw new RangeError('cycles must be a positive integer');
    // The final instruction can overshoot by 7 cycles (8-cycle instruction with
    // one cycle left), followed by a 7-cycle interrupt before checking the target.
    if (!Number.isSafeInteger(this.cpu.cycles) || this.cpu.cycles < 0
      || cycles > Number.MAX_SAFE_INTEGER - this.cpu.cycles - 14) {
      throw new RangeError('cycle budget exceeds the safe integer range');
    }
    const target = this.cpu.cycles + cycles;
    while (this.cpu.cycles < target) {
      if (this.dmaStall) {
        const used = Math.min(this.dmaStall, target - this.cpu.cycles);
        this.dmaStall -= used;
        this.cpu.cycles += used;
        this.clockDevices(used);
        continue;
      }
      if (this.oamDma.active) {
        this.oamDma.step(); this.cpu.cycles++; this.clockDevices(1); continue;
      }
      this.clockDevices(this.cpu.step());
      this.ppu.consumeScanlines();
      if (this.ppu.consumeNmi() && this.cpu.nmi()) {
        this.cpu.cycles += 7;
        this.clockDevices(7);
      } else if ((this.apu.irqPending || this.cartridge.irqPending) && this.cpu.irqAfterInstruction()) {
        this.cpu.cycles += 7;
        this.clockDevices(7);
      }
    }
    this.cycles = this.cpu.cycles;
  }

  readDma(address: number): number { return this.read(address); }
  writeDma(value: number): void { this.ppu.writeRegister(4, value); }

  readDmc(address: number): number {
    // ponytail: four-cycle fetch stall; bus-phase alignment and OAM overlap need cycle-level DMA.
    this.dmaStall += 4;
    return this.read(address);
  }

  private clockDevices(cycles: number): void {
    // ponytail: instruction-level bus timing; clock individual CPU bus accesses for cycle-exact register effects.
    this.frameCompleted = this.ppu.step(cycles * 3) || this.frameCompleted;
    this.apu.step(cycles);
  }
  saveState(): Uint8Array {
    const cart = this.cartridge.saveState(), ppu = this.ppu.saveState(), apu = this.apu.saveState();
    const out = new Uint8Array(Cpu6502.STATE_SIZE + cart.length + ppu.length + apu.length + 8 + this.ram.length + OamDma.STATE_SIZE + 8);
    let offset = 0;
    out.set(this.cpu.save(), offset); offset += Cpu6502.STATE_SIZE;
    out.set(cart, offset); offset += cart.length;
    out.set(ppu, offset); offset += ppu.length;
    out.set(apu, offset); offset += apu.length;
    out.set(this.controller1.saveState(), offset); offset += 4;
    out.set(this.controller2.saveState(), offset); offset += 4;
    out.set(this.ram, offset); offset += this.ram.length;
    out.set(this.oamDma.saveState(), offset); offset += OamDma.STATE_SIZE;
    // Preserve pending DMC stall cycles.
    new DataView(out.buffer).setFloat64(offset, this.dmaStall, true);
    return out;
  }
  loadState(state: Uint8Array): void {
    const cartSize = this.cartridge.stateSize, ppuSize = PPU_STATE_SIZE, apuSize = Apu.STATE_SIZE;
    const size = Cpu6502.STATE_SIZE + cartSize + ppuSize + apuSize + 8 + this.ram.length + OamDma.STATE_SIZE + 8;
    if (state.length !== size) throw new RangeError('Invalid state size');
    state = new Uint8Array(state); // Validate and apply the same bytes, including shared-memory inputs.
    const view = new DataView(state.buffer, state.byteOffset, state.byteLength);
    const dmaState = state.subarray(size - 8 - OamDma.STATE_SIZE, size - 8);
    OamDma.validateState(dmaState);
    const dmaStall = view.getFloat64(size - 8, true);
    if (!Number.isSafeInteger(dmaStall) || dmaStall < 0) throw new RangeError('Invalid DMA state');
    let offset = Cpu6502.STATE_SIZE;
    const cart = state.subarray(offset, offset += cartSize);
    const ppu = state.subarray(offset, offset += ppuSize);
    const apu = state.subarray(offset, offset += apuSize);
    const controller1 = state.subarray(offset, offset += 4);
    const controller2 = state.subarray(offset, offset += 4);
    // Reject every invalid section before changing live state or clearing queued PCM.
    const cpu = Array.from(state.subarray(0, Cpu6502.STATE_SIZE));
    Cpu6502.validateState(cpu);
    this.cartridge.validateState(cart);
    Ppu.validateState(ppu);
    Apu.validateState(apu);
    Controller.validateState(controller1);
    Controller.validateState(controller2);
    this.cpu.load(cpu);
    this.cycles = this.cpu.cycles;
    this.cartridge.loadState(cart);
    this.ppu.loadState(ppu);
    this.apu.loadState(apu);
    this.controller1.loadState(controller1);
    this.controller2.loadState(controller2);
    this.ram.set(state.subarray(offset, offset + this.ram.length));
    this.oamDma.loadState(dmaState);
    this.dmaStall = dmaStall;
  }
  runFrame(cycles?: number): Frame {
    if (cycles !== undefined) this.step(cycles);
    else {
      this.frameCompleted = false;
      do {
        const dots = (262 - this.ppu.scanline) * 341 - this.ppu.dot;
        this.step(Math.max(1, Math.floor(dots / 3)));
      } while (!this.frameCompleted);
    }
    return { pixels: this.frame, width: 256, height: 240 };
  }
  get cycleCount(){return this.cpu.cycles;}
}
