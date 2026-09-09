const CPU_HZ=1789773, SAMPLE_HZ=44100;
const LENGTH=[10,254,20,2,40,4,80,6,160,8,60,10,14,12,26,14,12,16,24,18,48,20,96,22,192,24,72,26,16,28,32,30];
const NOISE_PERIOD=[4,8,16,32,64,96,128,160,202,254,380,508,762,1016,2034,4068];
class Pulse { regs=new Uint8Array(4); timer=0; phase=0; length=0; enabled=false; write(i:number,v:number){this.regs[i]=v&255; if(i===3){this.length=LENGTH[v>>3]??0;this.timer=(this.timer&0xff)|((v&7)<<8);}} step(){if(this.timer--<=0){this.timer=(this.regs[2]|((this.regs[3]&7)<<8))+1;this.phase=(this.phase+1)&7;}} clockLength():void {if(this.length>0)this.length--;} sample(){if(!this.enabled||!this.length||(!this.regs[2]&&!(this.regs[3]&7)))return 0;return this.phase<[1,2,4,6][this.regs[0]>>6]?(this.regs[0]&15):0;}}
class Triangle { regs=new Uint8Array(4); timer=0; phase=0; length=0; enabled=false; write(i:number,v:number){this.regs[i]=v&255;if(i===3){this.length=LENGTH[v>>3]??0;this.timer=(v&7)<<8;}} step(){if(this.timer--<=0){this.timer=(this.regs[2]|((this.regs[3]&7)<<8))+1;this.phase=(this.phase+1)&31;}} clockLength():void {if(this.length>0)this.length--;} sample(){if(!this.enabled||!this.length)return 0;return this.phase<16?this.phase:31-this.phase;}}
class Noise { regs=new Uint8Array(4); timer=0; shift=1; length=0; enabled=false; step(){if(this.timer--<=0){this.timer=NOISE_PERIOD[this.regs[2]&15];const tap=(this.regs[2]&0x80)?6:1;this.shift=(this.shift>>1)|(((this.shift^(this.shift>>tap))&1)<<14);}} clockLength():void {if(this.length>0)this.length--;} sample(){return this.enabled&&this.length>0&&!(this.shift&1)?this.regs[0]&15:0;}}
/** Pulse, triangle, and noise synthesis; frame sequencing, envelopes, sweep, and DMC remain incomplete. */
export class Apu {
  static readonly STATE_SIZE = 44;
  readonly sampleRate = SAMPLE_HZ; private readonly pulse=[new Pulse(),new Pulse()]; private readonly noise=new Noise(); private readonly triangle=new Triangle(); private frac=0; private frame=0; private samples:number[]=[];
  write(address:number,value:number):void {
    value&=255;
    if(address>=0x4000&&address<0x4008)this.pulse[address<0x4004?0:1].write(address&3,value);
    else if(address>=0x4008&&address<0x400c)this.triangle.write(address&3,value);
    else if(address>=0x400c&&address<0x4010){this.noise.regs[address&3]=value;if((address&3)===3)this.noise.length=LENGTH[value>>3]??0;}
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
    out[36] = +this.triangle.enabled;
    view.setUint32(37, this.frac, true);
    view.setUint16(41, this.frame, true);
    out[43] = 1; // APU snapshot format version.
    return out;
  }

  loadState(state: Uint8Array): void {
    if (state.length !== Apu.STATE_SIZE) throw new RangeError('Invalid APU state size');
    const view = new DataView(state.buffer, state.byteOffset, state.byteLength);
    const frac = view.getUint32(37, true), frame = view.getUint16(41, true);
    if (state[43] !== 1 || frac >= CPU_HZ || frame >= 7457
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
    this.triangle.enabled = !!state[36];
    this.frac = frac;
    this.frame = frame;
    this.samples = [];
  }
  readStatus():number { return (this.pulse[0].length?1:0)|(this.pulse[1].length?2:0)|(this.triangle.length?4:0)|(this.noise.length?8:0); }
  step(cycles:number):void {for(let i=0;i<cycles;i++){for(const p of this.pulse)p.step();this.triangle.step();this.noise.step();if(++this.frame>=7457){this.frame=0;for(const p of this.pulse)p.clockLength();this.triangle.clockLength();this.noise.clockLength();}this.frac+=SAMPLE_HZ;if(this.frac>=CPU_HZ){this.frac-=CPU_HZ;if(this.samples.length>=SAMPLE_HZ*2)this.samples.splice(0,1024); this.samples.push((this.pulse[0].sample()+this.pulse[1].sample()+this.triangle.sample()+this.noise.sample())*320-4096);}}}
  drainSamples():Int16Array {const out=Int16Array.from(this.samples);this.samples=[];return out;}
  reset():void {this.frac=0;this.frame=0;this.samples=[];for(const p of this.pulse){p.regs.fill(0);p.timer=0;p.phase=0;p.length=0;p.enabled=false;}this.triangle.regs.fill(0);this.triangle.timer=0;this.triangle.phase=0;this.triangle.length=0;this.triangle.enabled=false;this.noise.regs.fill(0);this.noise.timer=0;this.noise.shift=1;this.noise.length=0;this.noise.enabled=false;}
}
