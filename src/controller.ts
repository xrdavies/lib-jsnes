export const Button = { A:1, B:2, Select:4, Start:8, Up:16, Down:32, Left:64, Right:128 } as const;
export type ButtonMask = number;
export class Controller {
  private state=0; private latched=0; private index=0; private strobe=false;
  saveState(): Uint8Array {
    const out = new Uint8Array(4);
    out[0] = this.state; out[1] = this.latched; out[2] = this.index; out[3] = this.strobe ? 1 : 0;
    return out;
  }
  static validateState(v: Uint8Array): void { if (v.length !== 4 || v[2] > 8 || v[3] > 1) throw new RangeError('Invalid controller state'); }
  loadState(v:Uint8Array):void { Controller.validateState(v); this.state=v[0]; this.latched=v[1]; this.index=v[2]; this.strobe=!!v[3]; }
  setButtons(mask: ButtonMask): void { this.state=mask&255; if(this.strobe)this.latch(); }
  write(value:number): void { const next=!!(value&1); if(next)this.latch(); else if(this.strobe)this.index=0; this.strobe=next; }
  read(): number { if(this.strobe)this.latch(); const bit=this.index<8 ? (this.latched>>this.index)&1 : 1; if(!this.strobe && this.index<8)this.index++; return bit; }
  private latch(){this.latched=this.state; this.index=0;}
}
