const CPU_HZ=1789773, SAMPLE_HZ=44100;
// Bilinear one-pole stages: 90 Hz and 440 Hz high-pass, then 14 kHz low-pass.
const DC_C = SAMPLE_HZ / (Math.PI * 90), DC_B0 = DC_C / (DC_C + 1), DC_FEEDBACK = (DC_C - 1) / (DC_C + 1);
const HP_C = SAMPLE_HZ / (Math.PI * 440), HP_B0 = HP_C / (HP_C + 1), HP_FEEDBACK = (HP_C - 1) / (HP_C + 1);
const LP_C = SAMPLE_HZ / (Math.PI * 14000), LP_B0 = 1 / (LP_C + 1), LP_FEEDBACK = (LP_C - 1) / (LP_C + 1);
const LENGTH=[10,254,20,2,40,4,80,6,160,8,60,10,14,12,26,14,12,16,24,18,48,20,96,22,192,24,72,26,16,28,32,30];
const NOISE_PERIOD=[4,8,16,32,64,96,128,160,202,254,380,508,762,1016,2034,4068];
const DUTY=[0x02,0x06,0x1e,0xf9];
// Nonlinear lookup approximation: two pulse DACs, then weighted triangle/noise/DMC.
// Generate from the transfer curves rather than copying reference table data.
const PULSE_MIX = new Int16Array(31), TND_MIX = new Int16Array(203);
for (let i = 1; i < PULSE_MIX.length; i++) PULSE_MIX[i] = Math.floor(32767 * 95.52 * i / (8128.0 + 100.0 * i));
for (let i = 1; i < TND_MIX.length; i++) TND_MIX[i] = Math.floor(32767 * 163.67 * i / (24329.0 + 100.0 * i));
class Envelope {
  start = false;
  divider = 0;
  decay = 0;

  clock(control: number): void {
    const period = control & 15;
    if (this.start) {
      this.start = false;
      this.decay = 15;
      this.divider = period;
    } else if (this.divider > 0) {
      this.divider--;
    } else {
      this.divider = period;
      if (this.decay > 0) this.decay--;
      else if (control & 0x20) this.decay = 15;
    }
  }

  volume(control: number): number { return control & 0x10 ? control & 15 : this.decay; }
  reset(): void { this.start = false; this.divider = this.decay = 0; }
}

class Pulse {
  constructor(private readonly negateExtra: number) {}
  sweepDivider = 0;
  sweepReload = false;

  regs = new Uint8Array(4);
  readonly envelope = new Envelope();
  timer = 0; phase = 0; length = 0; enabled = false;
  get period(): number {
    // Widen the register byte before shifting when compiled to fixed-width WASM integers.
    const high: number = this.regs[3];
    return this.regs[2] | ((high & 7) << 8);
  }
  private get sweepTarget(): number {
    const delta = this.period >>> (this.regs[1] & 7);
    return this.period + (this.regs[1] & 8 ? -delta - this.negateExtra : delta);
  }
  private get muted(): boolean { return this.period < 8 || this.sweepTarget > 0x7ff; }
  write(i: number, value: number): void {
    this.regs[i] = value & 255;
    if (i === 1) this.sweepReload = true;
    if (i === 3) {
      if (this.enabled) this.length = LENGTH[value >>> 3];
      this.envelope.start = true;
      this.phase = 0;
    }
  }
  step(): void {
    if (this.timer-- <= 0) {
      this.timer = this.period;
      this.phase = (this.phase + 1) & 7;
    }
  }
  clockLength(): void { if (this.length > 0 && !(this.regs[0] & 0x20)) this.length--; }
  clockSweep(): void {
    const control = this.regs[1];
    if (this.sweepDivider === 0 && (control & 0x80) && (control & 7) && !this.muted) {
      const target = this.sweepTarget;
      this.regs[2] = target & 255;
      this.regs[3] = (this.regs[3] & 0xf8) | (target >>> 8);
    }
    if (this.sweepDivider === 0 || this.sweepReload) {
      this.sweepDivider = (control >>> 4) & 7;
      this.sweepReload = false;
    } else this.sweepDivider--;
  }
  sample(): number {
    if (!this.enabled || !this.length || this.muted) return 0;
    return (DUTY[this.regs[0] >>> 6] >>> this.phase) & 1
      ? this.envelope.volume(this.regs[0]) : 0;
  }
}

class Triangle {
  regs = new Uint8Array(4);
  get period(): number {
    const high: number = this.regs[3];
    return this.regs[2] | ((high & 7) << 8);
  }
  linear = 0; linearReload = false;
  timer = 0; phase = 0; length = 0; enabled = false;
  write(i: number, value: number): void {
    this.regs[i] = value & 255;
    if (i === 3) this.linearReload = true;
    if (i === 3) {
      if (this.enabled) this.length = LENGTH[value >>> 3];
      this.timer = this.period;
    }
  }
  step(): void {
    if (this.timer-- <= 0) {
      this.timer = this.period;
      if (this.length > 0 && this.linear > 0) this.phase = (this.phase + 1) & 31;
    }
  }
  clockLength(): void { if (this.length > 0 && !(this.regs[0] & 0x80)) this.length--; }
  clockLinear(): void { if(this.linearReload)this.linear=this.regs[0]&127; else if(this.linear>0)this.linear--; if(!(this.regs[0]&0x80))this.linearReload=false; }
  sample(): number { return !this.enabled || !this.length || !this.linear ? 0 : this.phase < 16 ? this.phase : 31 - this.phase; }
}

class Noise {
  regs = new Uint8Array(4);
  readonly envelope = new Envelope();
  timer = 0; shift = 1; length = 0; enabled = false;
  write(i: number, value: number): void {
    this.regs[i] = value & 255;
    if (i === 3) {
      if (this.enabled) this.length = LENGTH[value >>> 3];
      this.envelope.start = true;
    }
  }
  step(): void {
    if (this.timer-- <= 0) {
      // Table entries are CPU-cycle intervals, including this expiration cycle.
      this.timer = NOISE_PERIOD[this.regs[2] & 15] - 1;
      const tap = this.regs[2] & 0x80 ? 6 : 1;
      this.shift = (this.shift >>> 1) | (((this.shift ^ (this.shift >>> tap)) & 1) << 14);
    }
  }
  clockLength(): void { if (this.length > 0 && !(this.regs[0] & 0x20)) this.length--; }
  sample(): number { return this.enabled && this.length > 0 && !(this.shift & 1) ? this.envelope.volume(this.regs[0]) : 0; }
}
/** The host reads CPU-mapped sample memory and charges the fetch stall. */
export interface DmcBus { readDmc(address: number): number; }
const DMC_PERIOD = [428,380,340,320,286,254,226,214,190,160,142,128,106,84,72,54];
class Dmc {
  regs = new Uint8Array(4);
  output = 0;
  address = 0xc000;
  remaining = 0;
  timer = 0;
  shift = 0;
  bits = 8;
  buffer = 256; // Empty; every 8-bit sample value is valid.
  silence = true;
  irq = false;
  write(index: number, value: number): void {
    this.regs[index] = value;
    if (index === 0 && !(value & 0x80)) this.irq = false;
    if (index === 1) this.output = value & 127;
  }
  restart(): void {
    const start: number = this.regs[2], length: number = this.regs[3];
    this.address = 0xc000 + start * 64;
    this.remaining = length * 16 + 1;
  }
  enable(enabled: boolean): void {
    this.irq = false;
    if (!enabled) this.remaining = 0;
    else if (this.remaining === 0) this.restart();
  }
  step(bus: DmcBus | null): void {
    if (this.buffer === 256 && this.remaining > 0 && bus !== null) {
      this.buffer = bus.readDmc(this.address) & 255;
      this.address = this.address === 0xffff ? 0x8000 : this.address + 1;
      if (--this.remaining === 0) {
        if (this.regs[0] & 0x40) this.restart();
        else if (this.regs[0] & 0x80) this.irq = true;
      }
    }
    if (this.timer-- > 0) return;
    this.timer = DMC_PERIOD[this.regs[0] & 15] - 1;
    if (!this.silence) {
      if (this.shift & 1) { if (this.output <= 125) this.output += 2; }
      else if (this.output >= 2) this.output -= 2;
    }
    this.shift >>>= 1;
    if (--this.bits === 0) {
      this.bits = 8;
      this.silence = this.buffer === 256;
      if (!this.silence) { this.shift = this.buffer; this.buffer = 256; }
    }
  }
  reset(): void {
    this.regs.fill(0); this.output = this.remaining = this.timer = this.shift = 0;
    this.address = 0xc000; this.bits = 8; this.buffer = 256; this.silence = true; this.irq = false;
  }
}
/** Five-channel NTSC synthesis; exact DMA bus arbitration remains incomplete. */
export class Apu {
  static readonly STATE_SIZE = 130;
  private frameWriteDelay = 0;
  private pendingMode5 = false;
  private frameClockBlock = 0;
  private readonly filterState = new Float64Array(6);
  private pulseClock = false;
  private readonly dmc = new Dmc();
  private nextFrameEvent = 7457;
  constructor(private readonly bus: DmcBus | null = null) {}
  readonly sampleRate = SAMPLE_HZ; private readonly pulse=[new Pulse(1),new Pulse(0)]; private readonly noise=new Noise(); private readonly triangle=new Triangle(); private frac=0; private frame=0; private mode5=false; private frameIrq=false; private irqInhibit=false; private samples:number[]=[];
  get irqPending(): boolean { return this.frameIrq || this.dmc.irq; }
  write(address:number,value:number):void {
    value&=255;
    if(address>=0x4000&&address<0x4008)this.pulse[address<0x4004?0:1].write(address&3,value);
    else if(address>=0x4008&&address<0x400c)this.triangle.write(address&3,value);
    else if(address>=0x400c&&address<0x4010)this.noise.write(address&3,value);
    else if(address>=0x4010&&address<=0x4013)this.dmc.write(address&3,value);
    else if(address===0x4015){this.dmc.enable(!!(value&16));this.pulse[0].enabled=!!(value&1);this.pulse[1].enabled=!!(value&2);this.triangle.enabled=!!(value&4);this.noise.enabled=!!(value&8);if(!this.pulse[0].enabled)this.pulse[0].length=0;if(!this.pulse[1].enabled)this.pulse[1].length=0;if(!this.triangle.enabled)this.triangle.length=0;if(!this.noise.enabled)this.noise.length=0;}
    else if(address===0x4017){
      this.pendingMode5 = !!(value & 0x80);
      this.frameWriteDelay = this.pulseClock ? 4 : 3;
      this.irqInhibit = !!(value & 0x40);
      if (this.irqInhibit) this.frameIrq = false;
    }
  }
  /** Fixed-width, little-endian oscillator state; queued host audio is not included. */
  saveState(): Uint8Array {
    const out = new Uint8Array(Apu.STATE_SIZE);
    const view = new DataView(out.buffer);
    out.set(this.pulse[0].regs, 0);
    out.set(this.pulse[1].regs, 4);
    out.set(this.noise.regs, 8);
    out[12] = this.pulse[0].phase;
    out[13] = this.pulse[1].phase;
    view.setUint16(14, this.noise.shift, true);
    out[16] = +this.pulse[0].enabled;
    out[17] = +this.pulse[1].enabled;
    out[18] = +this.noise.enabled;
    out[19] = this.triangle.phase;
    out[20] = this.pulse[0].length;
    out[21] = this.pulse[1].length;
    out[22] = this.triangle.length;
    out[23] = this.noise.length;
    view.setUint16(24, this.pulse[0].timer, true);
    view.setUint16(26, this.pulse[1].timer, true);
    view.setUint16(28, this.triangle.timer, true);
    view.setUint16(30, this.noise.timer, true);
    out.set(this.triangle.regs, 32);
    out[36] = +this.triangle.enabled; out[37]=this.pulse[0].sweepDivider; out[38]=this.pulse[1].sweepDivider; out[39]=+this.pulse[0].sweepReload; out[40]=+this.pulse[1].sweepReload;
    view.setUint32(41, this.frac, true);
    view.setUint16(57, this.frame, true);
    out[45]=+this.mode5; out[46]=this.triangle.linear; out[47]=+this.triangle.linearReload; out[59] = 6; out[60] = 8; out[61]=+this.frameIrq | (+this.irqInhibit << 1); // APU snapshot format version.
    for (const [i, channel] of [...this.pulse, this.noise].entries()) {
      out.set([+channel.envelope.start, channel.envelope.divider, channel.envelope.decay], 48 + i * 3);
    }
    out.set(this.dmc.regs, 62);
    out[66] = this.dmc.output; out[67] = +this.dmc.silence | (+this.dmc.irq << 1);
    out[68] = this.dmc.bits; out[69] = this.dmc.shift;
    view.setUint16(70, this.dmc.buffer, true); view.setUint16(72, this.dmc.address, true);
    view.setUint16(74, this.dmc.remaining, true); view.setUint16(76, this.dmc.timer, true);
    out[78] = +this.pulseClock;
    out[127] = this.frameWriteDelay; out[128] = +this.pendingMode5; out[129] = this.frameClockBlock;
    for (let i = 0; i < this.filterState.length; i++) view.setFloat64(79 + i * 8, this.filterState[i], true);
    return out;
  }

  static validateState(state: Uint8Array): void {
    if (state.length !== Apu.STATE_SIZE) throw new RangeError('Invalid APU state size');
    const view = new DataView(state.buffer, state.byteOffset, state.byteLength);
    const frac = view.getUint32(41, true), frame = view.getUint16(57, true);
    const previousInput = view.getFloat64(79, true), previousOutput = view.getFloat64(87, true);
    if (!Number.isInteger(previousInput) || previousInput < 0 || previousInput > 32767
      || !Number.isFinite(previousOutput) || previousOutput > DC_B0 * previousInput + 1e-6
      || previousOutput < DC_B0 * (previousInput - 32767) - 1e-6) throw new RangeError('Invalid APU filter state');
    for (const offset of [95, 103, 111, 119]) {
      const value = view.getFloat64(offset, true);
      if (!Number.isFinite(value) || Math.abs(value) > 65534) throw new RangeError('Invalid APU filter state');
    }
    if (view.getFloat64(95, true) !== previousOutput || view.getFloat64(111, true) !== view.getFloat64(103, true)) {
      throw new RangeError('Invalid APU filter state');
    }
    if (state[127] > 4 || state[128] > 1 || state[129] > 1 || state[78] > 1 || state[59] !== 6 || state[60] !== 8 || state[61] > 3 || frac >= CPU_HZ || frame >= (state[45] ? 37282 : 29830)
      || [48, 51, 54].some(offset => state[offset] > 1 || state[offset + 1] > 15 || state[offset + 2] > 15)
      || state[12] > 7 || state[13] > 7 || state[19] > 31
      || view.getUint16(14, true) > 0x7fff
      || [16, 17, 18, 36, 39, 40, 45, 47].some(offset => state[offset] > 1)
      || state[37] > 7 || state[38] > 7 || state[46] > 127
      || [24, 26].some(offset => view.getUint16(offset, true) > 0x7ff)
      || view.getUint16(28, true) > 0x800
      || view.getUint16(30, true) > 4068) throw new RangeError('Invalid APU state values');
    if (state[66] > 127 || state[67] > 3 || state[68] < 1 || state[68] > 8
      || view.getUint16(70, true) > 256 || view.getUint16(72, true) < 0x8000
      || view.getUint16(74, true) > 4081 || view.getUint16(76, true) > 427) throw new RangeError('Invalid DMC state');
  }

  loadState(state: Uint8Array): void {
    Apu.validateState(state);
    const view = new DataView(state.buffer, state.byteOffset, state.byteLength);
    const frac = view.getUint32(41, true), frame = view.getUint16(57, true);
    for (let i = 0; i < this.filterState.length; i++) this.filterState[i] = view.getFloat64(79 + i * 8, true);
    this.frameWriteDelay = state[127]; this.pendingMode5 = !!state[128]; this.frameClockBlock = state[129];
    this.pulseClock = !!state[78];
    this.dmc.regs.set(state.subarray(62, 66)); this.dmc.output = state[66];
    this.dmc.silence = !!(state[67] & 1); this.dmc.irq = !!(state[67] & 2);
    this.dmc.bits = state[68]; this.dmc.shift = state[69];
    this.dmc.buffer = view.getUint16(70, true); this.dmc.address = view.getUint16(72, true);
    this.dmc.remaining = view.getUint16(74, true); this.dmc.timer = view.getUint16(76, true);
    this.pulse[0].regs.set(state.subarray(0, 4));
    this.pulse[1].regs.set(state.subarray(4, 8));
    this.noise.regs.set(state.subarray(8, 12));
    this.pulse[0].phase = state[12];
    this.pulse[1].phase = state[13];
    this.noise.shift = view.getUint16(14, true);
    this.pulse[0].enabled = !!state[16];
    this.pulse[1].enabled = !!state[17];
    this.noise.enabled = !!state[18];
    this.triangle.phase = state[19];
    this.pulse[0].length = state[20];
    this.pulse[1].length = state[21];
    this.triangle.length = state[22];
    this.noise.length = state[23];
    this.pulse[0].timer = view.getUint16(24, true);
    this.pulse[1].timer = view.getUint16(26, true);
    this.triangle.timer = view.getUint16(28, true);
    this.noise.timer = view.getUint16(30, true);
    this.triangle.regs.set(state.subarray(32, 36));
    this.triangle.enabled = !!state[36]; this.mode5=!!state[45]; this.triangle.linear=state[46]; this.triangle.linearReload=!!state[47]; this.frameIrq=!!(state[61]&1); this.irqInhibit=!!(state[61]&2); this.pulse[0].sweepDivider=state[37]; this.pulse[1].sweepDivider=state[38]; this.pulse[0].sweepReload=!!state[39]; this.pulse[1].sweepReload=!!state[40];
    this.frac = frac;
    this.frame = frame;
    this.scheduleFrameEvent();
    for (const [i, channel] of [...this.pulse, this.noise].entries()) {
      const offset = 48 + i * 3;
      channel.envelope.start = !!state[offset];
      channel.envelope.divider = state[offset + 1];
      channel.envelope.decay = state[offset + 2];
    }
    this.samples = [];
  }
  readStatus():number { const value=(this.pulse[0].length?1:0)|(this.pulse[1].length?2:0)|(this.triangle.length?4:0)|(this.noise.length?8:0)|(this.frameIrq?0x40:0)|(this.dmc.remaining?16:0)|(this.dmc.irq?128:0); this.frameIrq=false; return value; }
  step(cycles:number):void {for(let i=0;i<cycles;i++){if(this.pulseClock)for(let channel=0;channel<this.pulse.length;channel++)this.pulse[channel].step();this.pulseClock=!this.pulseClock;this.triangle.step();this.noise.step();this.dmc.step(this.bus);if(++this.frame===this.nextFrameEvent)this.clockFrame();if(this.frameWriteDelay || this.frameClockBlock)this.finishFrameWrite();this.frac+=SAMPLE_HZ;if(this.frac>=CPU_HZ){this.frac-=CPU_HZ;if(this.samples.length>=SAMPLE_HZ*2)this.samples.splice(0,1024); this.samples.push(this.filterSample(PULSE_MIX[this.pulse[0].sample()+this.pulse[1].sample()] + TND_MIX[3*this.triangle.sample()+2*this.noise.sample()+this.dmc.output]));}}}
  private filterSample(input: number): number {
    const output = DC_B0 * (input - this.filterState[0]) + DC_FEEDBACK * this.filterState[1];
    this.filterState[0] = input; this.filterState[1] = output;
    const high = HP_B0 * (output - this.filterState[2]) + HP_FEEDBACK * this.filterState[3];
    this.filterState[2] = output; this.filterState[3] = high;
    const low = LP_B0 * (high + this.filterState[4]) + LP_FEEDBACK * this.filterState[5];
    this.filterState[4] = high; this.filterState[5] = low;
    return Math.floor(Math.min(32767, Math.max(-32768, low)) + 0.5);
  }
  private clockFrame(): void {
    // NTSC sequencer in CPU cycles. Both sequence lengths are even.
    const end = this.mode5 ? 37281 : 29829;
    if (this.frame === 7457 || this.frame === 14913 || this.frame === 22371 || this.frame === end) {
      this.clockUnits(this.frame === 14913 || this.frame === end);
    }
    // The four-step IRQ is a level latch asserted once at the sequence endpoint.
    if (!this.mode5 && !this.irqInhibit && this.frame === end) this.frameIrq = true;
    if (this.frame === end + 1) this.frame = 0;
    this.scheduleFrameEvent();
  }
  private clockUnits(half: boolean): void {
    if (this.frameClockBlock) return;
    for (let i = 0; i < this.pulse.length; i++) {
      const pulse = this.pulse[i]; pulse.envelope.clock(pulse.regs[0]);
      if (half) { pulse.clockLength(); pulse.clockSweep(); }
    }
    this.noise.envelope.clock(this.noise.regs[0]); this.triangle.clockLinear();
    if (half) { this.triangle.clockLength(); this.noise.clockLength(); }
    this.frameClockBlock = 2;
  }
  private finishFrameWrite(): void {
    if (this.frameWriteDelay > 0 && --this.frameWriteDelay === 0) {
      this.mode5 = this.pendingMode5; this.frame = 0; this.nextFrameEvent = 7457;
      if (this.mode5) this.clockUnits(true);
    }
    if (this.frameClockBlock > 0) this.frameClockBlock--;
  }
  private scheduleFrameEvent(): void {
    const end = this.mode5 ? 37281 : 29829;
    this.nextFrameEvent = this.frame < 7457 ? 7457 : this.frame < 14913 ? 14913
      : this.frame < 22371 ? 22371 : this.frame < end ? end : end + 1;
  }
  drainSamples(): Int16Array {
    const out = new Int16Array(this.samples.length);
    for (let i = 0; i < out.length; i++) out[i] = this.samples[i];
    this.samples = [];
    return out;
  }
  reset():void {this.frameWriteDelay=0;this.pendingMode5=false;this.frameClockBlock=0;this.filterState.fill(0);this.pulseClock=false;this.dmc.reset();this.frac=0;this.frame=0;this.nextFrameEvent=7457;this.mode5=false;this.frameIrq=false;this.irqInhibit=false;this.samples=[];for(let i=0;i<this.pulse.length;i++){const p=this.pulse[i];p.envelope.reset();p.regs.fill(0);p.timer=0;p.phase=0;p.length=0;p.sweepDivider=0;p.sweepReload=false;p.enabled=false;}this.triangle.regs.fill(0);this.triangle.timer=0;this.triangle.phase=0;this.triangle.length=0;this.triangle.linear=0;this.triangle.linearReload=false;this.triangle.enabled=false;this.noise.envelope.reset();this.noise.regs.fill(0);this.noise.timer=0;this.noise.shift=1;this.noise.length=0;this.noise.enabled=false;}
}
