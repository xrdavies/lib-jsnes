export interface CpuBus { read(address: number): number; write(address: number, value: number): void; }
const C=1,Z=2,I=4,D=8,B=16,U=32,V=64,N=128;
export class Cpu6502 {
  a=0; x=0; y=0; sp=0xfd; p=U|I; pc=0; cycles=0;
  constructor(private readonly bus: CpuBus) {}
  reset(): void { this.sp=0xfd; this.p=U|I; this.pc=this.read16(0xfffc); this.cycles=0; }
  step(): number { const op=this.fetch(); let used=2; switch(op){
    case 0xea: break; case 0xa9: this.a=this.imm(); used=2; break; case 0xa2: this.x=this.imm(); used=2; break; case 0xa0: this.y=this.imm(); used=2; break;
    case 0x8d: this.bus.write(this.abs(),this.a); used=4; break; case 0x8e: this.bus.write(this.abs(),this.x); used=4; break; case 0x8c: this.bus.write(this.abs(),this.y); used=4; break;
    case 0xad: this.a=this.bus.read(this.abs()); this.nz(this.a); used=4; break; case 0xbd: {const b=this.abs()+this.x; this.a=this.bus.read(b); this.nz(this.a); used=4+(b>0xffff?0:0); break;}
    case 0xe8: this.x=(this.x+1)&255; this.nz(this.x); used=2; break; case 0xca: this.x=(this.x-1)&255; this.nz(this.x); used=2; break;
    case 0x4c: this.pc=this.abs(); used=3; break; case 0x20: {const d=this.abs(); this.push((this.pc-1)>>>8); this.push(this.pc-1); this.pc=d; used=6; break;}
    case 0x60: this.pc=(this.pop()|(this.pop()<<8))+1; used=6; break; case 0x00: this.p|=B; used=7; break;
    case 0x69: this.adc(this.imm()); used=2; break; case 0xe9: this.adc(this.imm()^255); used=2; break;
    case 0xd0: used=this.branch(!(this.p&Z)); break; case 0xf0: used=this.branch(!!(this.p&Z)); break; case 0x10: used=this.branch(!(this.p&N)); break; case 0x30: used=this.branch(!!(this.p&N)); break;
    default: used=2; break;
  } this.cycles+=used; return used; }
  private fetch(){const v=this.bus.read(this.pc); this.pc=(this.pc+1)&0xffff; return v;}
  private imm(){const v=this.fetch(); this.nz(v); return v;}
  private abs(){const lo=this.fetch(), hi=this.fetch(); return lo|(hi<<8);}
  private read16(a:number){return this.bus.read(a)|(this.bus.read((a+1)&0xffff)<<8);}
  private push(v:number){this.bus.write(0x100|this.sp,v); this.sp=(this.sp-1)&255;}
  private pop(){this.sp=(this.sp+1)&255; return this.bus.read(0x100|this.sp);}
  private nz(v:number){this.p=(this.p&~(N|Z))|(v?0:Z)|(v&128);}
  private adc(v:number){const sum=this.a+v+(this.p&C?1:0); this.p=(this.p&~(C|V))|(sum>255?C:0)|((~(this.a^v)&(this.a^sum)&128)?V:0); this.a=sum&255; this.nz(this.a);}
  private branch(ok:boolean){if(!ok)return 2; const off=(this.fetch()<<24)>>24; const old=this.pc; this.pc=(this.pc+off)&0xffff; return 3+(old&0xff00)!==(this.pc&0xff00)?1:0;}
}
