const CPU_HZ=1789773, SAMPLE_HZ=44100;
const LENGTH=[10,254,20,2,40,4,80,6,160,8,60,10,14,12,26,14,12,16,24,18,48,20,96,22,192,24,72,26,16,28,32,30];
const NOISE_PERIOD=[4,8,16,32,64,96,128,160,202,254,380,508,762,1016,2034,4068];
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
  sweepDivider = 0;
  sweepReload = false;

  regs = new Uint8Array(4);
  readonly envelope = new Envelope();
  timer = 0; phase = 0; length = 0; enabled = false;
  write(i: number, value: number): void {
    this.regs[i] = value & 255;
    if (i === 1) this.sweepReload = true;
    if (i === 3) {
      if (this.enabled) this.length = LENGTH[value >>> 3];
      this.envelope.start = true;
      this.sweepReload = true;
      this.phase = 0;
      this.timer = (this.timer & 255) | ((value & 7) << 8);
    }
  }
  step(): void {
    if (this.timer-- <= 0) {
      this.timer = (this.regs[2] | ((this.regs[3] & 7) << 8)) + 1;
      this.phase = (this.phase + 1) & 7;
    }
  }
  clockLength(): void { if (this.length > 0 && !(this.regs[0] & 0x20)) this.length--; }


  clockSweep(channel: number): void { const control=this.regs[1], period=((control>>>4)&7)+1, shift=control&7; if(this.sweepReload){this.sweepDivider=period;this.sweepReload=false;return;} if(this.sweepDivider>0){this.sweepDivider--;return;} this.sweepDivider=period; if(!(control&0x80)||!shift)return; const timer=this.regs[2]|((this.regs[3]&7)<<8), delta=timer>>>shift; let next=timer+(control&8 ? -delta-(channel===1?1:0) : delta); if(next<0)next=0;if(next>0x7ff)next=0x7ff; this.regs[2]=next&255;this.regs[3]=(this.regs[3]&0xf8)|(next>>>8); }
  sample(): number {
    if (!this.enabled || !this.length || (!this.regs[2] && !(this.regs[3] & 7))) return 0;
    return this.phase < [1, 2, 4, 6][this.regs[0] >>> 6] ? this.envelope.volume(this.regs[0]) : 0;
  }
}

class Triangle {
  regs = new Uint8Array(4);
  timer = 0; phase = 0; length = 0; enabled = false;
  write(i: number, value: number): void {
    this.regs[i] = value & 255;
    if (i === 3) {
      if (this.enabled) this.length = LENGTH[value >>> 3];
      this.timer = (value & 7) << 8;
    }
  }
  step(): void {
    if (this.timer-- <= 0) {
      this.timer = (this.regs[2] | ((this.regs[3] & 7) << 8)) + 1;
      this.phase = (this.phase + 1) & 31;
    }
  }
  clockLength(): void { if (this.length > 0 && !(this.regs[0] & 0x80)) this.length--; }
  sample(): number { return !this.enabled || !this.length ? 0 : this.phase < 16 ? this.phase : 31 - this.phase; }
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
      this.timer = NOISE_PERIOD[this.regs[2] & 15];
      const tap = this.regs[2] & 0x80 ? 6 : 1;
      this.shift = (this.shift >>> 1) | (((this.shift ^ (this.shift >>> tap)) & 1) << 14);
    }
  }
  clockLength(): void { if (this.length > 0 && !(this.regs[0] & 0x20)) this.length--; }
  sample(): number { return this.enabled && this.length > 0 && !(this.shift & 1) ? this.envelope.volume(this.regs[0]) : 0; }
}
/** Pulse, triangle, and noise synthesis; five-step frame sequencing, sweep, triangle linear counting, and DMC remain incomplete. */
export class Apu {
  static readonly STATE_SIZE = 57;
  readonly sampleRate = SAMPLE_HZ; private readonly pulse=[new Pulse(),new Pulse()]; private readonly noise=new Noise(); private readonly triangle=new Triangle(); private frac=0; private frame=0; private samples:number[]=[];
  write(address:number,value:number):void {
    value&=255;
    if(address>=0x4000&&address<0x4008)this.pulse[address<0x4004?0:1].write(address&3,value);
    else if(address>=0x4008&&address<0x400c)this.triangle.write(address&3,value);
    else if(address>=0x400c&&address<0x4010)this.noise.write(address&3,value);
    else if(address===0x4015){this.pulse[0].enabled=!!(value&1);this.pulse[1].enabled=!!(value&2);this.triangle.enabled=!!(value&4);this.noise.enabled=!!(value&8);if(!this.pulse[0].enabled)this.pulse[0].length=0;if(!this.pulse[1].enabled)this.pulse[1].length=0;if(!this.triangle.enabled)this.triangle.length=0;if(!this.noise.enabled)this.noise.length=0;}
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
    view.setUint16(45, this.frame, true);
    out[56] = 3; // APU snapshot format version.
    for (const [i, channel] of [...this.pulse, this.noise].entries()) {
      out.set([+channel.envelope.start, channel.envelope.divider, channel.envelope.decay], 47 + i * 3);
    }
    return out;
  }

  loadState(state: Uint8Array): void {
    if (state.length !== Apu.STATE_SIZE) throw new RangeError('Invalid APU state size');
    const view = new DataView(state.buffer, state.byteOffset, state.byteLength);
    const frac = view.getUint32(41, true), frame = view.getUint16(45, true);
    if (state[56] !== 3 || frac >= CPU_HZ || frame >= 29830
      || [47, 50, 53].some(offset => state[offset] > 1 || state[offset + 1] > 15 || state[offset + 2] > 15)
      || state[12] > 7 || state[13] > 7 || state[19] > 31
      || view.getUint16(14, true) > 0x7fff
      || [16, 17, 18, 36].some(offset => state[offset] > 1)
      || [24, 26, 28].some(offset => view.getUint16(offset, true) > 0x800)
      || view.getUint16(30, true) > 4068) throw new RangeError('Invalid APU state values');
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
    this.triangle.enabled = !!state[36]; this.pulse[0].sweepDivider=state[37]; this.pulse[1].sweepDivider=state[38]; this.pulse[0].sweepReload=!!state[39]; this.pulse[1].sweepReload=!!state[40];
    this.frac = frac;
    this.frame = frame;
    for (const [i, channel] of [...this.pulse, this.noise].entries()) {
      const offset = 47 + i * 3;
      channel.envelope.start = !!state[offset];
      channel.envelope.divider = state[offset + 1];
      channel.envelope.decay = state[offset + 2];
    }
    this.samples = [];
  }
  readStatus():number { return (this.pulse[0].length?1:0)|(this.pulse[1].length?2:0)|(this.triangle.length?4:0)|(this.noise.length?8:0); }
  step(cycles:number):void {for(let i=0;i<cycles;i++){for(const p of this.pulse)p.step();this.triangle.step();this.noise.step();this.clockFrame();this.frac+=SAMPLE_HZ;if(this.frac>=CPU_HZ){this.frac-=CPU_HZ;if(this.samples.length>=SAMPLE_HZ*2)this.samples.splice(0,1024); this.samples.push((this.pulse[0].sample()+this.pulse[1].sample()+this.triangle.sample()+this.noise.sample())*320-4096);}}}
  private clockFrame(): void {
    // NTSC four-step sequence, in CPU cycles. $4017 mode switching and frame IRQ are pending.
    this.frame++;
    if (this.frame === 7457 || this.frame === 14913 || this.frame === 22371 || this.frame === 29829) {
      for (const pulse of this.pulse) pulse.envelope.clock(pulse.regs[0]);
      this.pulse[0].clockSweep(1); this.pulse[1].clockSweep(2);
      this.noise.envelope.clock(this.noise.regs[0]);
    }
    if (this.frame === 14913 || this.frame === 29829) {
      for (const pulse of this.pulse) pulse.clockLength();
      this.triangle.clockLength();
      this.noise.clockLength();
    }
    if (this.frame === 29830) this.frame = 0;
  }
  drainSamples():Int16Array {const out=Int16Array.from(this.samples);this.samples=[];return out;}
  reset():void {this.frac=0;this.frame=0;this.samples=[];for(const p of this.pulse){p.envelope.reset();p.regs.fill(0);p.timer=0;p.phase=0;p.length=0;p.enabled=false;}this.triangle.regs.fill(0);this.triangle.timer=0;this.triangle.phase=0;this.triangle.length=0;this.triangle.enabled=false;this.noise.envelope.reset();this.noise.regs.fill(0);this.noise.timer=0;this.noise.shift=1;this.noise.length=0;this.noise.enabled=false;}
}
