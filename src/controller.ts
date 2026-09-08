export const Button = { A:1, B:2, Select:4, Start:8, Up:16, Down:32, Left:64, Right:128 } as const;
export type ButtonMask = number;
export class Controller {
  private state=0; private latched=0; private index=0; private strobe=false;
  setButtons(mask: ButtonMask): void { this.state=mask&255; if(this.strobe)this.latch(); }
  write(value:number): void { const next=!!(value&1); if(next)this.latch(); else if(this.strobe)this.index=0; this.strobe=next; }
  read(): number { if(this.strobe)this.latch(); const bit=this.index<8 ? (this.latched>>this.index)&1 : 1; if(!this.strobe)this.index++; return bit; }
  private latch(){this.latched=this.state; this.index=0;}
}
