import type { Cartridge } from './cartridge.js';

export const NES_PALETTE = new Uint32Array([0x666666,0x002a88,0x1412a7,0x3b00a4,0x5c007e,0x6e0040,0x6c0700,0x561d00,0x333500,0x0b4800,0x005100,0x004b00,0x00402b,0x000000,0x000000,0x000000,0xaaaaaa,0x155fd9,0x4240ff,0x7527fe,0xa01acc,0xb71e7b,0xb53120,0x994e00,0x6b6d00,0x388700,0x0c9300,0x008b00,0x008268,0x000000,0x000000,0x000000,0xffffff,0x64b0ff,0x9290ff,0xb36aff,0xdf54ff,0xf053a4,0xf0705f,0xf1a33b,0xbdc52f,0x8bd53f,0x5eea6f,0x4de6ae,0x4dd2e6,0x4d4d4d,0x000000,0x000000,0xffffff,0xc0dfff,0xd3d2ff,0xe8c8ff,0xfbc2ff,0xfec4d7,0xfcc7b0,0xf9d89c,0xe6e89e,0xd5f0a3,0xc5f7c8,0xc5f7e1,0xc5e9f2,0xbcbcbc,0x000000,0x000000]);export class Ppu {
  constructor(private readonly cartridge: Cartridge) {}
  reset(): void { this.ctrl=0; this.mask=0; this.status=0; this.backgroundOpaque.fill(0); this.nmiPending=false; this.sprite0Hit=false; this.spriteOverflow=false; this.scrollX=0; this.scrollY=0; this.oamAddr=0; this.addr=0; this.latch=false; this.data=0; this.scanline=0; this.dot=0; this.scanlineTicks=0; this.frame.fill(0xff000000); }
  readonly vram = new Uint8Array(0x4000); readonly backgroundOpaque = new Uint8Array(256*240); readonly palette = new Uint8Array(32); readonly oam = new Uint8Array(256); readonly frame = new Uint32Array(256*240);
  private ctrl=0; private mask=0; private scanlineTicks=0; private nmiPending=false; private sprite0Hit=false; private spriteOverflow=false; private scrollX=0; private scrollY=0; private status=0; private oamAddr=0; private addr=0; private latch=false; private data=0; scanline=0; dot=0;
  readRegister(reg:number):number { switch(reg&7){case 2: {const v=this.status|(this.sprite0Hit?0x40:0)|(this.spriteOverflow?0x20:0); this.status&=0x7f; this.latch=false; return v;} case 4:return this.oam[this.oamAddr]; case 7:{const a=this.addr&0x3fff; const v=a>=0x3f00?this.palette[this.paletteIndex(a)]:this.data; if(a<0x3f00)this.data=this.readMemory(a); else this.data=this.readMemory((a-0x1000)&0x3fff); this.addr=(a+(this.ctrl&4?32:1))&0x3fff; return v;} default:return 0;} }
  writeRegister(reg:number,value:number):void {value&=255; switch(reg&7){case 0:{const was=this.ctrl;this.ctrl=value;if(!(was&0x80)&&(value&0x80)&&(this.status&0x80))this.nmiPending=true;break;}case 1:this.mask=value;break;case 3:this.oamAddr=value;break;case 4:this.oam[this.oamAddr++]=value;break;case 5:if(!this.latch)this.scrollX=value;else this.scrollY=value;this.latch=!this.latch;break;case 6:if(!this.latch)this.addr=(value&0x3f)<<8;else this.addr=(this.addr&0x3f00)|value;this.latch=!this.latch;break;case 7:{const a=this.addr&0x3fff; if(a>=0x3f00)this.palette[this.paletteIndex(a)]=value; else this.writeMemory(a,value); this.addr=(a+(this.ctrl&4?32:1))&0x3fff; break;}}}
  private renderBackground():void { if(!(this.mask&8)){this.backgroundOpaque.fill(0);this.frame.fill(0xff000000);return;} for(let y=0;y<240;y++)for(let x=0;x<256;x++){if(x<8&&!(this.mask&2)){this.backgroundOpaque[y*256+x]=0;this.frame[y*256+x]=0xff000000;continue;} const wx=x+this.scrollX, wy=y+this.scrollY, nx=Math.floor(wx/256)&1, ny=Math.floor(wy/240)&1, sx=((wx%256)+256)%256, sy=((wy%240)+240)%240, nt=((this.ctrl&3)+nx+ny*2)&3, tx=sx>>>3, ty=sy>>>3, table=0x2000+nt*0x400, tile=this.readMemory(table+ty*32+tx), attr=this.readMemory(table+0x3c0+(ty>>>2)*8+(tx>>>2)), shift=((ty&2)?4:0)+((tx&2)?2:0), palette=(attr>>shift)&3; const base=(this.ctrl&16?0x1000:0)+tile*16, row=sy&7, col=sx&7, lo=this.readMemory(base+row), hi=this.readMemory(base+row+8), c=((lo>>(7-col))&1)|(((hi>>(7-col))&1)<<1); this.backgroundOpaque[y*256+x]=c?1:0; this.frame[y*256+x]=0xff000000|this.color((palette*4+c)&63);}}
  private renderSprites():void { if(!(this.mask&16))return; const tall=!!(this.ctrl&32); const counts=new Uint8Array(240); for(let i=0;i<256;i+=4){const y=this.oam[i]+1, tile=this.oam[i+1], attr=this.oam[i+2], x=this.oam[i+3], height=tall?16:8, table=tall?(tile&1)*0x1000:((this.ctrl&8)?0x1000:0), base=table+(tall?(tile&0xfe)*16:tile*16); for(let py=0;py<height;py++){if(y+py>=0&&y+py<240&&++counts[y+py]===9)this.spriteOverflow=true; const sy=(attr&0x80)?height-1-py:py, tbase=base+(sy>=8&&tall?16:0), row=sy&7, lo=this.readMemory(tbase+row), hi=this.readMemory(tbase+row+8); for(let px=0;px<8;px++){const sx=(attr&0x40)?px:7-px, c=((lo>>sx)&1)|(((hi>>sx)&1)<<1); if(!c)continue; const dx=x+px, dy=y+py; if(dx>=256||dy>=240||((dx<8)&&!(this.mask&4)))continue; if(i===0&&this.backgroundOpaque[dy*256+dx])this.sprite0Hit=true; if(attr&0x20&&this.frame[dy*256+dx]!==0xff000000)continue; const pal=16+((attr&3)<<2); this.frame[dy*256+dx]=0xff000000|this.color((pal+c)&63);}}}}
  private color(index:number):number { let c=NES_PALETTE[index&63]; if(this.mask&1){const y=(((c>>>16)&255)*77+((c>>>8)&255)*150+(c&255)*29)>>8;c=(y<<16)|(y<<8)|y;} const e=(this.mask>>>5)&7; if(e){let r=c>>>16&255,g=c>>>8&255,b=c&255;if(e&1)r=Math.min(255,r+32);if(e&2)g=Math.min(255,g+32);if(e&4)b=Math.min(255,b+32);c=(r<<16)|(g<<8)|b;} return c; }
  private paletteIndex(address:number):number { const i=address&31; return (i&3)===0 ? (i&0x0f) : i; }

  private readMemory(address: number): number {
    return address < 0x2000 ? this.cartridge.readChr(address) : this.vram[this.map(address)];
  }

  private writeMemory(address: number, value: number): void {
    if (address < 0x2000) this.cartridge.writeChr(address, value);
    else this.vram[this.map(address)] = value;
  }

  private map(address: number): number {
    const relative = (address - 0x2000) & 0x0fff;
    let table = relative >>> 10;
    switch (this.cartridge.mirroring) {
      case 'single-lower': table = 0; break;
      case 'single-upper': table = 1; break;
      case 'horizontal': table >>>= 1; break;
      case 'vertical': table &= 1; break;
    }
    return 0x2000 + table * 0x400 + (relative & 0x3ff);
  }
  saveState(): Uint8Array { const out=new Uint8Array(0x4000+32+256+13+245760+61440+5); out.set(this.vram); out.set(this.palette,0x4000); out.set(this.oam,0x4020); out.set([this.ctrl,this.mask,this.status,this.oamAddr,this.addr&255,this.addr>>>8,this.latch?1:0,this.data,this.scanline&255,this.scanline>>>8,this.dot&255,this.dot>>>8,this.nmiPending?1:0],0x4120); out.set([this.scrollX,this.scrollY,this.sprite0Hit?1:0,this.spriteOverflow?1:0,this.scanlineTicks&255],0x412d); out.set(new Uint8Array(this.frame.buffer),0x4132); out.set(this.backgroundOpaque,0x4132+245760); return out; }
  consumeScanlines(): number { const n=this.scanlineTicks; this.scanlineTicks=0; return n; }
  consumeNmi(): boolean { const pending=this.nmiPending; this.nmiPending=false; return pending; }
  loadState(state: Uint8Array): void { if(state.length!==0x4000+32+256+13+245760+61440+5) throw new RangeError('Invalid PPU state'); this.vram.set(state.subarray(0,0x4000)); this.palette.set(state.subarray(0x4000,0x4020)); this.oam.set(state.subarray(0x4020,0x4120)); const v=state.subarray(0x4120); [this.ctrl,this.mask,this.status,this.oamAddr]=v; this.addr=v[4]|(v[5]<<8); this.latch=!!v[6]; this.data=v[7]; this.scanline=v[8]|(v[9]<<8); this.dot=v[10]|(v[11]<<8); this.nmiPending=!!v[12]; const extra=state.subarray(0x412d,0x4132); this.scrollX=extra[0]; this.scrollY=extra[1]; this.sprite0Hit=!!extra[2]; this.spriteOverflow=!!extra[3]; this.scanlineTicks=extra[4]; this.frame.set(new Uint32Array(state.slice(0x4132,0x4132+245760).buffer)); this.backgroundOpaque.set(state.subarray(0x4132+245760)); }
  dma(bytes: Uint8Array): void { for(let i=0;i<256;i++)this.oam[(this.oamAddr+i)&255]=bytes[i]; this.oamAddr=(this.oamAddr+256)&255; }
  step(dots = 1): boolean {
    let frame = false;
    while (dots-- > 0) {
      if (++this.dot === 341) {
        this.dot = 0;
        this.scanlineTicks++;
        if (++this.scanline === 262) {
          this.scanline = 0;
          // ponytail: rendering is still frame-batched; move fetches to individual dots for raster effects.
          this.renderBackground();
          this.renderSprites();
          if (this.sprite0Hit) this.status |= 0x40;
          frame = true;
        }
      }
      if (this.dot === 1) {
        if (this.scanline === 241) {
          this.status |= 0x80;
          if (this.ctrl & 0x80) this.nmiPending = true;
        } else if (this.scanline === 261) {
          this.status &= 0x1f;
          this.sprite0Hit = false;
          this.spriteOverflow = false;
        }
      }
    }
    return frame;
  }
}
