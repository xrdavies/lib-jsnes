const CPU_HZ=1789773, SAMPLE_HZ=44100;
class Pulse { regs=new Uint8Array(4); timer=0; phase=0; enabled=false; write(i:number,v:number){this.regs[i]=v&255; if(i===3)this.timer=(this.timer&0xff)|((v&7)<<8);} step(){if(this.timer--<=0){this.timer=(this.regs[2]|((this.regs[3]&7)<<8))+1;this.phase=(this.phase+1)&7;}} sample(){if(!this.enabled||!this.regs[2]&&!(this.regs[3]&7))return 0;const duty=[1,2,4,6][this.regs[0]>>6];return this.phase<duty?(this.regs[0]&15):0;}}
/** Small deterministic pulse mixer; envelope/sweep and triangle/noise/DMC are pending. */
export class Apu { private readonly pulse=[new Pulse(),new Pulse()]; private frac=0; private samples:number[]=[];
  write(address:number,value:number):void {if(address>=0x4000&&address<0x4008)this.pulse[address<0x4004?0:1].write(address&3,value); else if(address===0x4015){this.pulse[0].enabled=!!(value&1);this.pulse[1].enabled=!!(value&2);}}
  step(cycles:number):void {for(let i=0;i<cycles;i++){for(const p of this.pulse)p.step();this.frac+=SAMPLE_HZ;if(this.frac>=CPU_HZ){this.frac-=CPU_HZ;this.samples.push((this.pulse[0].sample()+this.pulse[1].sample())*512-4096);}}}
  drainSamples():Int16Array {const out=Int16Array.from(this.samples);this.samples=[];return out;}
  reset():void {this.frac=0;this.samples=[];for(const p of this.pulse){p.regs.fill(0);p.timer=0;p.phase=0;p.enabled=false;}}
}
