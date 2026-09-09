import type { Cartridge } from './cartridge.js';
export const PPU_STATE_SIZE = 0x4000 + 32 + 256 + 13 + 245760 + 61440 + 17 + 269 + 45;
// ponytail: fixed retention measured in scanlines; tune for chip/temperature models if needed.
const IO_DECAY_SCANLINES = 3 * 262;

export const NES_PALETTE = new Uint32Array([0x666666,0x002a88,0x1412a7,0x3b00a4,0x5c007e,0x6e0040,0x6c0700,0x561d00,0x333500,0x0b4800,0x005100,0x004b00,0x00402b,0x000000,0x000000,0x000000,0xaaaaaa,0x155fd9,0x4240ff,0x7527fe,0xa01acc,0xb71e7b,0xb53120,0x994e00,0x6b6d00,0x388700,0x0c9300,0x008b00,0x008268,0x000000,0x000000,0x000000,0xffffff,0x64b0ff,0x9290ff,0xb36aff,0xdf54ff,0xf053a4,0xf0705f,0xf1a33b,0xbdc52f,0x8bd53f,0x5eea6f,0x4de6ae,0x4dd2e6,0x4d4d4d,0x000000,0x000000,0xffffff,0xc0dfff,0xd3d2ff,0xe8c8ff,0xfbc2ff,0xfec4d7,0xfcc7b0,0xf9d89c,0xe6e89e,0xd5f0a3,0xc5f7c8,0xc5f7e1,0xc5e9f2,0xbcbcbc,0x000000,0x000000]);export class Ppu {
  constructor(private readonly cartridge: Cartridge) {}
  private ioLatch = 0;
  private readDelay = 0;
  private suppressVblank = false;
  private renderingEnabled = false;
  private readonly ioDecay = new Uint16Array(3); // Bits 0–4, bit 5, bits 6–7.
  private tempAddr = 0;
  private oddFrame = false;
  private bgLow = 0; private bgHigh = 0; private attrLow = 0; private attrHigh = 0;
  private nextTile = 0; private nextAttr = 0; private nextLow = 0; private nextHigh = 0;
  private readonly spriteLine = new Uint8Array(256);
  private lineOverflow = false;
  private readonly secondaryOam = new Uint8Array(32);
  private readonly spriteIds = new Uint8Array(8);
  private spriteCount = 0;
  private spriteEvalOam = 64;
  private spriteEvalByte = 0;
  private spriteEvalStarted = false;
  private spriteEvalCopying = false;
  private spriteLow = 0;
  private mapperAddress = 0;
  reset(): void { this.secondaryOam.fill(255); this.spriteIds.fill(255); this.spriteCount=0; this.spriteEvalOam=64; this.spriteEvalByte=0; this.spriteEvalStarted=false; this.spriteEvalCopying=false; this.spriteLow=0; this.bgLow=this.bgHigh=this.attrLow=this.attrHigh=this.nextTile=this.nextAttr=this.nextLow=this.nextHigh=0; this.spriteLine.fill(0); this.lineOverflow=false; this.readDelay=0; this.oddFrame=false; this.suppressVblank=false; this.renderingEnabled=false; this.ioLatch=0; this.ioDecay.fill(0); this.ctrl=0; this.mask=0; this.status=0; this.backgroundOpaque.fill(0); this.nmiPending=false; this.sprite0Hit=false; this.spriteOverflow=false; this.scrollX=0; this.scrollY=0; this.oamAddr=0; this.addr=0; this.tempAddr=0; this.latch=false; this.data=0; this.scanline=0; this.dot=0; this.scanlineTicks=0; this.frame.fill(0xff000000); }
  readonly vram = new Uint8Array(0x4000); readonly backgroundOpaque = new Uint8Array(256*240); readonly palette = new Uint8Array(32); readonly oam = new Uint8Array(256); readonly frame = new Uint32Array(256*240);
  private ctrl=0; private mask=0; private scanlineTicks=0; private nmiPending=false; private sprite0Hit=false; private spriteOverflow=false; private scrollX=0; private scrollY=0; private status=0; private oamAddr=0; private addr=0; private latch=false; private data=0; scanline=0; dot=0;
  readRegister(reg: number): number {
    switch (reg & 7) {
      case 2:
        if (this.scanline === 241 && this.dot === 0) this.suppressVblank = true;
        this.driveIoLatch((this.status & 0xe0) | (this.sprite0Hit ? 0x40 : 0)
          | (this.spriteOverflow ? 0x20 : 0), 0xe0);
        this.status &= 0x7f; this.nmiPending = false; this.latch = false;
        break;
      case 4: this.driveIoLatch(this.oam[this.oamAddr] & ((this.oamAddr & 3) === 2 ? 0xe3 : 0xff)); break;
      case 7: {
        if (this.readDelay) break;
        // ponytail: fixed six-dot recovery; phase-dependent buffer corruption needs a finer PPU model.
        this.readDelay = 6;
        const a = this.addr & 0x3fff;
        this.driveIoLatch(a >= 0x3f00 ? this.readPalette(a) : this.data, a >= 0x3f00 ? 0x3f : 0xff);
        const source = a >= 0x3f00 ? a - 0x1000 : a;
        this.data = this.readMemory(source);
        if (source < 0x2000) this.cartridge.clockA12(source);
        this.incrementDataAddress();
        break;
      }
    }
    return this.ioLatch;
  }
  private driveIoLatch(value: number, mask = 0xff): void {
    this.ioLatch = (this.ioLatch & ~mask) | (value & mask);
    if (mask & 0x1f) this.ioDecay[0] = IO_DECAY_SCANLINES;
    if (mask & 0x20) this.ioDecay[1] = IO_DECAY_SCANLINES;
    if (mask & 0xc0) this.ioDecay[2] = IO_DECAY_SCANLINES;
  }
  writeRegister(reg:number,value:number):void {value&=255; this.driveIoLatch(value); switch(reg&7){case 0:{const was=this.ctrl;this.ctrl=value;this.tempAddr=(this.tempAddr&~0x0c00)|((value&3)<<10);if(!(value&0x80))this.nmiPending=false;else if(!(was&0x80)&&(this.status&0x80))this.nmiPending=true;break;}case 1:this.mask=value;break;case 3:this.oamAddr=value;break;case 4:this.oam[this.oamAddr]=value;this.oamAddr=(this.oamAddr+1)&255;break;case 5:
      if (!this.latch) { this.scrollX=value; this.tempAddr=(this.tempAddr&~31)|(value>>>3); }
      else { this.scrollY=value; this.tempAddr=(this.tempAddr&~0x73e0)|((value&7)<<12)|((value&0xf8)<<2); }
      this.latch=!this.latch;break;case 6:
      if (!this.latch) this.tempAddr=(this.tempAddr&255)|((value&0x3f)<<8);
      else { this.tempAddr=(this.tempAddr&0x7f00)|value; this.addr=this.tempAddr&0x7fff; }
      this.latch=!this.latch;break;case 7:{const a=this.addr&0x3fff; if(a>=0x3f00)this.palette[this.paletteIndex(a)]=value; else { this.writeMemory(a,value); if(a<0x2000)this.cartridge.clockA12(a); } this.incrementDataAddress(); break;}}}
  private incrementX(): void {
    if ((this.addr & 31) === 31) this.addr = (this.addr & ~31) ^ 0x400;
    else this.addr++;
  }
  private incrementY(): void {
    if ((this.addr & 0x7000) !== 0x7000) { this.addr += 0x1000; return; }
    this.addr &= ~0x7000;
    let y = (this.addr >>> 5) & 31;
    if (y === 29) { y = 0; this.addr ^= 0x800; }
    else if (y === 31) y = 0;
    else y++;
    this.addr = (this.addr & ~0x3e0) | (y << 5);
  }
  private incrementDataAddress(): void {
    if (this.renderingEnabled && (this.scanline < 240 || this.scanline === 261)) {
      this.incrementX(); this.incrementY();
    } else this.addr = (this.addr + (this.ctrl & 4 ? 32 : 1)) & 0x7fff;
  }
  private clockBackground(): void {
    const fetch = (this.dot >= 1 && this.dot <= 256) || (this.dot >= 321 && this.dot <= 336);
    if (fetch) {
      this.bgLow = (this.bgLow << 1) & 0xffff; this.bgHigh = (this.bgHigh << 1) & 0xffff;
      this.attrLow = (this.attrLow << 1) & 0xffff; this.attrHigh = (this.attrHigh << 1) & 0xffff;
      switch (this.dot & 7) {
        case 1: this.nextTile = this.readMemory(0x2000 | (this.addr & 0xfff)); break;
        case 3: {
          const attr = this.readMemory(0x23c0 | (this.addr & 0xc00) | ((this.addr >>> 4) & 0x38) | ((this.addr >>> 2) & 7));
          this.nextAttr = (attr >>> (((this.addr >>> 4) & 4) | (this.addr & 2))) & 3; break;
        }
        case 5: this.nextLow = this.readMemory((this.ctrl & 16 ? 0x1000 : 0) + this.nextTile * 16 + ((this.addr >>> 12) & 7)); break;
        case 7: this.nextHigh = this.readMemory((this.ctrl & 16 ? 0x1000 : 0) + this.nextTile * 16 + ((this.addr >>> 12) & 7) + 8); break;
        case 0:
          this.bgLow |= this.nextLow; this.bgHigh |= this.nextHigh;
          this.attrLow |= this.nextAttr & 1 ? 255 : 0; this.attrHigh |= this.nextAttr & 2 ? 255 : 0;
          this.incrementX(); break;
      }
    }
    if (this.dot === 256) this.incrementY();
    if (this.dot === 257) this.addr = (this.addr & ~0x041f) | (this.tempAddr & 0x041f);
    if (this.scanline === 261 && this.dot >= 280 && this.dot <= 304) this.addr = (this.addr & ~0x7be0) | (this.tempAddr & 0x7be0);
    if (this.dot === 337 || this.dot === 339) this.readMemory(0x2000 | (this.addr & 0xfff));
  }

  private beginSpriteEvaluation(): void {
    this.secondaryOam.fill(255); this.spriteIds.fill(255); this.spriteCount = 0;
    this.spriteEvalOam = 0; this.spriteEvalByte = 0; this.spriteEvalStarted = true; this.spriteEvalCopying = false; this.lineOverflow = false;
  }
  private clockSpriteEvaluation(): void {
    if (!this.spriteEvalStarted || this.spriteEvalOam >= 64) return;
    const height = this.ctrl & 32 ? 16 : 8;
    const address = this.spriteEvalOam * 4 + this.spriteEvalByte;
    const value = this.oam[address];
    const target = this.scanline === 261 ? 0 : this.scanline + 1;
    // The final visible line is 239; evaluation on line 239 prepares the
    // off-screen line 240 and must not count Y=240 sprites.
    const inRange = target < 240 && (<number>value) <= target && target < (<number>value) + height;
    if (this.spriteEvalCopying || this.spriteCount < 8) {
      if (this.spriteEvalByte === 0 && inRange) {
        const slot = this.spriteCount++;
        this.secondaryOam[slot * 4] = value; this.spriteIds[slot] = this.spriteEvalOam;
        this.spriteEvalByte = 1; this.spriteEvalCopying = true;
      } else if (this.spriteEvalByte === 0) {
        this.spriteEvalOam++;
      } else {
        const slot = this.spriteCount - 1;
        this.secondaryOam[slot * 4 + this.spriteEvalByte] = value;
        if (++this.spriteEvalByte === 4) { this.spriteEvalByte = 0; this.spriteEvalOam++; this.spriteEvalCopying = false; }
      }
      return;
    }
    // Once full, every following byte is tested as if it were a Y coordinate.
    // This deliberate diagonal scan reproduces the hardware overflow quirk.
    if (inRange) { this.lineOverflow = true; this.spriteOverflow = true; }
    this.spriteEvalOam++; this.spriteEvalByte = (this.spriteEvalByte + 1) & 3;
  }
  private spriteAddress(slot: number): number {
    const height = this.ctrl & 32 ? 16 : 8;
    const tile: number = this.secondaryOam[slot * 4 + 1];
    const attr: number = this.secondaryOam[slot * 4 + 2];
    const y: number = this.secondaryOam[slot * 4];
    const targetLine = this.scanline === 261 ? 0 : this.scanline + 1;
    const row = (targetLine - y) & (height - 1);
    const sy = attr & 0x80 ? height - 1 - row : row;
    return height === 16 ? (tile & 1) * 0x1000 + ((tile & 0xfe) + (sy >>> 3)) * 16 + (sy & 7)
      : (this.ctrl & 8 ? 0x1000 : 0) + tile * 16 + sy;
  }
  private clockSprites(): void {
    if (this.dot < 257 || this.dot > 320) return;
    this.oamAddr = 0;
    const slot = (this.dot - 257) >>> 3, phase = (this.dot - 257) & 7;
    if (phase === 0 || phase === 2) { this.readMemory(0x2000 | (this.addr & 0xfff)); return; }
    if (phase === 4) { this.spriteLow = this.readMemory(this.spriteAddress(slot)); return; }
    if (phase !== 6) return;
    const hi = this.readMemory(this.spriteAddress(slot) + 8);
    if (slot >= this.spriteCount) return;
    const x: number = this.secondaryOam[slot * 4 + 3], attr: number = this.secondaryOam[slot * 4 + 2];
    for (let px = 0; px < 8 && x + px < 256; px++) {
      const dx = x + px; if (this.spriteLine[dx]) continue;
      const shift = attr & 0x40 ? px : 7 - px;
      const color = ((this.spriteLow >>> shift) & 1) | (((hi >>> shift) & 1) << 1);
      if (color) this.spriteLine[dx] = (16 + (attr & 3) * 4 + color) | (attr & 0x20) | (this.spriteIds[slot] === 0 ? 0x40 : 0);
    }
  }
  private renderPixel(x: number): void {
    const bit = 0x8000 >>> (this.scrollX & 7);
    const pattern = (this.bgLow & bit ? 1 : 0) | (this.bgHigh & bit ? 2 : 0);
    const background = (this.mask & 8) && (x >= 8 || (this.mask & 2)) && pattern
      ? pattern | (this.attrLow & bit ? 4 : 0) | (this.attrHigh & bit ? 8 : 0) : 0;
    const sprite: number = (this.mask & 16) && (x >= 8 || (this.mask & 4)) ? this.spriteLine[x] : 0;
    let color = !(this.mask & 0x18) && (this.addr & 0x3f00) === 0x3f00 ? this.addr & 31 : background;
    if (sprite) {
      if (background && (sprite & 0x40) && x < 255) { this.sprite0Hit = true; this.status |= 0x40; }
      if (!background || !(sprite & 0x20)) color = sprite & 31;
    }
    const pixel = this.scanline * 256 + x;
    this.backgroundOpaque[pixel] = background ? 1 : 0;
    this.frame[pixel] = 0xff000000 | this.color(color);
  }
  private color(index:number):number { let c=NES_PALETTE[this.readPalette(index)]; const e=(this.mask>>>5)&7; if(e){let r=c>>>16&255,g=c>>>8&255,b=c&255;if(e&1)r=Math.min(255,r+32);if(e&2)g=Math.min(255,g+32);if(e&4)b=Math.min(255,b+32);c=(r<<16)|(g<<8)|b;} return c; }
  private readPalette(address: number): number {
    return this.palette[this.paletteIndex(address)] & (this.mask & 1 ? 0x30 : 0x3f);
  }
  private paletteIndex(address:number):number { const i=address&31; return (i&3)===0 ? (i&0x0f) : i; }

  private readMemory(address: number): number {
    if (address < 0x2000) { this.mapperAddress = address; return this.cartridge.readChr(address); }
    return this.vram[this.map(address)];
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
  saveState(): Uint8Array {
    const out = new Uint8Array(PPU_STATE_SIZE), view = new DataView(out.buffer);
    out.set(this.vram); out.set(this.palette, 0x4000); out.set(this.oam, 0x4020);
    out[0x4120] = this.ctrl; out[0x4121] = this.mask; out[0x4122] = this.status; out[0x4123] = this.oamAddr;
    view.setUint16(0x4124, this.addr, true); out[0x4126] = this.latch ? 1 : 0; out[0x4127] = this.data;
    view.setUint16(0x4128, this.scanline, true); view.setUint16(0x412a, this.dot, true);
    out[0x412c] = this.nmiPending ? 1 : 0; out[0x412d] = this.scrollX; out[0x412e] = this.scrollY;
    out[0x412f] = this.sprite0Hit ? 1 : 0; out[0x4130] = this.spriteOverflow ? 1 : 0;
    out[0x4131] = this.scanlineTicks & 255;
    for (let i = 0; i < this.frame.length; i++) view.setUint32(0x4132 + i * 4, this.frame[i], true);
    out.set(this.backgroundOpaque, 0x4132 + 245760);
    out[PPU_STATE_SIZE - 326] = this.spriteEvalOam; out[PPU_STATE_SIZE - 325] = this.spriteEvalByte;
    out[PPU_STATE_SIZE - 324] = (this.spriteEvalStarted ? 1 : 0) | (this.spriteEvalCopying ? 2 : 0);
    out.set(this.secondaryOam, PPU_STATE_SIZE - 323); out.set(this.spriteIds, PPU_STATE_SIZE - 291);
    out[PPU_STATE_SIZE - 283] = this.spriteCount; out[PPU_STATE_SIZE - 282] = this.spriteLow;
    view.setUint16(PPU_STATE_SIZE - 281, this.bgLow, true); view.setUint16(PPU_STATE_SIZE - 279, this.bgHigh, true);
    view.setUint16(PPU_STATE_SIZE - 277, this.attrLow, true); view.setUint16(PPU_STATE_SIZE - 275, this.attrHigh, true);
    out[PPU_STATE_SIZE - 273] = this.nextTile; out[PPU_STATE_SIZE - 272] = this.nextAttr;
    out[PPU_STATE_SIZE - 271] = this.nextLow; out[PPU_STATE_SIZE - 270] = this.nextHigh;
    out.set(this.spriteLine, PPU_STATE_SIZE - 269);
    out[PPU_STATE_SIZE - 13] = this.lineOverflow ? 1 : 0;
    out[PPU_STATE_SIZE - 12] = this.readDelay;
    out[PPU_STATE_SIZE - 11] = (this.suppressVblank ? 1 : 0) | (this.renderingEnabled ? 2 : 0);
    for (let i = 0; i < 3; i++) view.setUint16(PPU_STATE_SIZE - 10 + i * 2, this.ioDecay[i], true);
    view.setUint16(PPU_STATE_SIZE - 4, this.tempAddr, true);
    out[PPU_STATE_SIZE - 2] = this.ioLatch; out[PPU_STATE_SIZE - 1] = this.oddFrame ? 1 : 0;
    return out;
  }
  consumeScanlines(): number { const n=this.scanlineTicks; this.scanlineTicks=0; return n; }
  consumeNmi(): boolean { const pending=this.nmiPending; this.nmiPending=false; return pending; }
  static validateState(state: Uint8Array): void {
    if (state.length !== PPU_STATE_SIZE || state[PPU_STATE_SIZE-1] > 1 || state[PPU_STATE_SIZE-3] > 0x7f || state[PPU_STATE_SIZE-11] > 3 || state[PPU_STATE_SIZE-12] > 6 || state[PPU_STATE_SIZE-13] > 1) throw new RangeError('Invalid PPU state');
    for (let i = 0; i < 256; i++) {
      if (state[PPU_STATE_SIZE - 269 + i] > 127) throw new RangeError('Invalid PPU line state');
    }
    if (state[PPU_STATE_SIZE - 326] > 64 || state[PPU_STATE_SIZE - 325] > 3 || state[PPU_STATE_SIZE - 324] > 3) throw new RangeError('Invalid PPU sprite evaluation state');
    if (state[PPU_STATE_SIZE - 283] > 8) throw new RangeError('Invalid PPU sprite count');
    for (let i = 0; i < 8; i++) {
      const id = state[PPU_STATE_SIZE - 291 + i];
      if (id > 63 && id !== 255) throw new RangeError('Invalid PPU sprite ID');
    }
    if (state[PPU_STATE_SIZE - 272] > 3) throw new RangeError('Invalid PPU attribute state');
    const view = new DataView(state.buffer, state.byteOffset, state.byteLength);
    for (let i = 0; i < 3; i++) {
      const count: number = view.getUint16(PPU_STATE_SIZE - 10 + i * 2, true);
      if (count > IO_DECAY_SCANLINES) throw new RangeError('Invalid PPU I/O decay state');
    }
    const v = state.subarray(0x4120);
    if (v[5] > 0x7f || v[6] > 1 || view.getUint16(0x4128, true) > 261
      || view.getUint16(0x412a, true) > 340 || v[12] > 1 || v[15] > 1 || v[16] > 1) {
      throw new RangeError('Invalid PPU state values');
    }
  }
  loadState(state: Uint8Array): void {
    Ppu.validateState(state);
    const view = new DataView(state.buffer, state.byteOffset, state.byteLength);
    this.vram.set(state.subarray(0, 0x4000)); this.palette.set(state.subarray(0x4000, 0x4020));
    this.oam.set(state.subarray(0x4020, 0x4120));
    this.ctrl = state[0x4120]; this.mask = state[0x4121]; this.status = state[0x4122]; this.oamAddr = state[0x4123];
    this.addr = view.getUint16(0x4124, true); this.latch = !!state[0x4126]; this.data = state[0x4127];
    this.scanline = view.getUint16(0x4128, true); this.dot = view.getUint16(0x412a, true);
    this.nmiPending = !!state[0x412c]; this.scrollX = state[0x412d]; this.scrollY = state[0x412e];
    this.sprite0Hit = !!state[0x412f]; this.spriteOverflow = !!state[0x4130]; this.scanlineTicks = state[0x4131];
    for (let i = 0; i < this.frame.length; i++) this.frame[i] = view.getUint32(0x4132 + i * 4, true);
    this.backgroundOpaque.set(state.subarray(0x4132 + 245760, PPU_STATE_SIZE - 326));
    this.spriteEvalOam = state[PPU_STATE_SIZE - 326]; this.spriteEvalByte = state[PPU_STATE_SIZE - 325];
    this.spriteEvalStarted = !!(state[PPU_STATE_SIZE - 324] & 1);
    this.spriteEvalCopying = !!(state[PPU_STATE_SIZE - 324] & 2);
    this.secondaryOam.set(state.subarray(PPU_STATE_SIZE - 323, PPU_STATE_SIZE - 291));
    this.spriteIds.set(state.subarray(PPU_STATE_SIZE - 291, PPU_STATE_SIZE - 283));
    this.spriteCount = state[PPU_STATE_SIZE - 283]; this.spriteLow = state[PPU_STATE_SIZE - 282];
    this.bgLow = view.getUint16(PPU_STATE_SIZE - 281, true); this.bgHigh = view.getUint16(PPU_STATE_SIZE - 279, true);
    this.attrLow = view.getUint16(PPU_STATE_SIZE - 277, true); this.attrHigh = view.getUint16(PPU_STATE_SIZE - 275, true);
    this.nextTile = state[PPU_STATE_SIZE - 273]; this.nextAttr = state[PPU_STATE_SIZE - 272];
    this.nextLow = state[PPU_STATE_SIZE - 271]; this.nextHigh = state[PPU_STATE_SIZE - 270];
    this.spriteLine.set(state.subarray(PPU_STATE_SIZE - 269, PPU_STATE_SIZE - 13));
    this.lineOverflow = !!state[PPU_STATE_SIZE - 13];
    this.readDelay = state[PPU_STATE_SIZE - 12]; this.suppressVblank = !!(state[PPU_STATE_SIZE - 11] & 1);
    this.renderingEnabled = !!(state[PPU_STATE_SIZE - 11] & 2);
    for (let i = 0; i < 3; i++) this.ioDecay[i] = view.getUint16(PPU_STATE_SIZE - 10 + i * 2, true);
    this.tempAddr = view.getUint16(PPU_STATE_SIZE - 4, true);
    this.ioLatch = state[PPU_STATE_SIZE - 2]; this.oddFrame = !!state[PPU_STATE_SIZE - 1];
  }
  dma(bytes: Uint8Array): void { for(let i=0;i<256;i++)this.oam[(this.oamAddr+i)&255]=bytes[i]; this.oamAddr=(this.oamAddr+256)&255; }
  step(dots = 1): boolean {
    let frame = false;
    while (dots-- > 0) {
      // Preserve status, line rendering, mapper clocks and line boundaries when skipping.
      const rendering = (this.mask & 0x18) !== 0;
      const mapperLine = this.renderingEnabled && (this.scanline < 240 || this.scanline === 261);
      const skipOddDot = this.oddFrame && this.scanline === 261 && this.renderingEnabled;
      let next = this.dot === 0 ? 1 : this.scanline < 240 && this.dot < 256 ? this.dot + 1
        : mapperLine && this.dot < 280 ? 280 : skipOddDot && this.dot < 339 ? 339 : 341;
      if (mapperLine) next = this.dot + 1;
      // Rendering starts/stops after one dot; preserve that transition when batching.
      if (rendering !== this.renderingEnabled) next = Math.min(next, this.dot + 1);
      const skip = Math.min(Math.floor(dots), next - this.dot - 1);
      this.readDelay -= Math.min(this.readDelay, (skip > 0 ? skip : 0) + 1);
      if (skip > 0) {
        for (let i = 0; i < Math.min(skip, 3); i++) this.cartridge.clockA12(0);
        this.dot += skip; dots -= skip;
      }
      // Decide the odd-frame skip on entering 339, before any later mask write.
      this.dot++;
      if (this.dot === 341) {
        this.dot = 0;
        for (let i = 0; i < 3; i++) {
          if (this.ioDecay[i] > 0 && --this.ioDecay[i] === 0) this.ioLatch &= ~(i === 0 ? 0x1f : i === 1 ? 0x20 : 0xc0);
        }
        this.scanlineTicks++;
        if (++this.scanline === 262) {
          this.scanline = 0;
          this.oddFrame = !this.oddFrame;
          frame = true;
        }
      }
      if (this.scanline < 240 && this.dot > 0 && this.dot <= 256) {
        this.renderPixel(this.dot - 1);

      }
      if (this.dot === 1 && (this.scanline < 240 || this.scanline === 261)) {
        if (mapperLine) this.beginSpriteEvaluation();
        else { this.spriteEvalOam = 64; this.spriteEvalByte = 0; this.spriteEvalStarted = false; this.spriteEvalCopying = false; this.spriteCount = 0; }
      }
      this.mapperAddress = 0;
      if (mapperLine) { this.clockBackground(); this.clockSprites(); }
      // Sprite evaluation advances one OAM byte every two PPU dots during
      // the 192-dot evaluation window.
      if (mapperLine && this.dot >= 65 && this.dot <= 256 && (this.dot & 1)) this.clockSpriteEvaluation();
      if (this.dot === 256 && (this.scanline < 240 || this.scanline === 261)) {
        this.spriteLine.fill(0);
        if (!mapperLine) this.spriteCount = 0;
      }
      this.cartridge.clockA12(this.mapperAddress);
      if (this.dot === 1) {
        if (this.scanline === 241) {
          if (!this.suppressVblank) {
            this.status |= 0x80;
            if (this.ctrl & 0x80) this.nmiPending = true;
          }
          this.suppressVblank = false;
        } else if (this.scanline === 261) {
          this.status &= 0x1f;
          this.nmiPending = false;
          this.sprite0Hit = false;
          this.spriteOverflow = false;
        }
      }
      if (this.dot === 339 && skipOddDot) this.dot = 340;
      this.renderingEnabled = rendering;
    }
    return frame;
  }
}
