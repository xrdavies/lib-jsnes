export class Ppu {
  private mirroring:'horizontal'|'vertical'|'four-screen'='horizontal';
  setMirroring(mode:'horizontal'|'vertical'|'four-screen'):void { this.mirroring=mode; }
  readonly vram = new Uint8Array(0x4000); readonly palette = new Uint8Array(32); readonly oam = new Uint8Array(256); readonly frame = new Uint32Array(256*240);
  private ctrl=0; private mask=0; private status=0xa0; private oamAddr=0; private addr=0; private latch=false; private data=0; scanline=0; dot=0;
  readRegister(reg:number):number { switch(reg&7){case 2: {const v=this.status; this.status&=0x7f; this.latch=false; return v;} case 4:return this.oam[this.oamAddr]; case 7:{const a=this.addr&0x3fff, m=this.map(a); const v=a>=0x3f00?this.palette[a&31]:this.data; if(a<0x3f00)this.data=this.vram[m]; this.addr=(a+(this.ctrl&4?32:1))&0x3fff; return v;} default:return 0;} }
  writeRegister(reg:number,value:number):void {value&=255; switch(reg&7){case 0:this.ctrl=value;break;case 1:this.mask=value;break;case 3:this.oamAddr=value;break;case 4:this.oam[this.oamAddr++]=value;break;case 5:this.latch=!this.latch;break;case 6:if(!this.latch)this.addr=(value&0x3f)<<8;else this.addr=(this.addr&0x3f00)|value;this.latch=!this.latch;break;case 7:{const a=this.addr&0x3fff, m=this.map(a); if(a>=0x3f00)this.palette[a&31]=value; else this.vram[m]=value; this.addr=(a+(this.ctrl&4?32:1))&0x3fff; break;}}}
  private map(a:number):number { if(a<0x2000||a>=0x3f00)return a; const n=(a-0x2000)&0xfff, table=n>>>10, off=n&0x3ff; const t=this.mirroring==='four-screen'?table:this.mirroring==='vertical'?(table&1):(table>>>1); return 0x2000+(t<<10)+off; }
  dma(bytes: Uint8Array): void { this.oam.set(bytes); }
  step(dots=1):boolean {let frame=false; while(dots-->0){if(++this.dot>=341){this.dot=0;if(++this.scanline>=262){this.scanline=0;frame=true;} if(this.scanline===241)this.status|=0x80; if(this.scanline===261)this.status&=0x7f;}} return frame;}
}
