// Small, allocation-free WASM host ABI. It executes common 6502 instructions;
// the TypeScript core remains the complete renderer and mapper implementation.
const ROM = new Uint8Array(0x80000), RAM = new Uint8Array(0x800), FRAME = new Uint32Array(256 * 240);
let romLength: i32 = 0, pc: i32 = 0, cycles: i32 = 0, a: i32 = 0, x: i32 = 0, y: i32 = 0, p: i32 = 0x24;
function read(address: i32): i32 { address &= 0xffff; if(address < 0x2000)return RAM[address&0x7ff]; if(address < 0x8000 || romLength < 16)return 0; const prg=romLength-16; let o=(address-0x8000)%prg+16; if(prg<=0x4000)o=(address-0x8000)%0x4000+16; return ROM[o]; }
function write(address: i32, value: i32): void { if((address&0xffff)<0x2000)RAM[address&0x7ff]=value&255; }
function fetch(): i32 { const v=read(pc); pc=(pc+1)&0xffff; return v; }
function nz(v: i32): void { p=(p&0x7d)|(v==0?2:0)|(v&0x80); }
export function romWrite(index:i32,value:i32):void{if(index>=0&&index<ROM.length)ROM[index]=value;}
export function loadRom(length:i32):void{romLength=length<0?0:length>ROM.length?ROM.length:length;}
export function reset():void{RAM.fill(0);FRAME.fill(0xff000000);cycles=0;a=0;x=0;y=0;p=0x24;pc=romLength>=0x4000?read(0xfffc)|(read(0xfffd)<<8):0x8000;}
export function step(count:i32):void{if(count<=0)return;const target=cycles+count;while(cycles<target){const op=fetch();let used=2,address:i32;switch(op){case 0xea:break;case 0xa9:a=fetch();nz(a);break;case 0xa2:x=fetch();nz(x);break;case 0xa0:y=fetch();nz(y);break;case 0x8d:address=fetch()|(fetch()<<8);write(address,a);used=4;break;case 0x8e:address=fetch()|(fetch()<<8);write(address,x);used=4;break;case 0x8c:address=fetch()|(fetch()<<8);write(address,y);used=4;break;case 0xad:address=fetch()|(fetch()<<8);a=read(address);nz(a);used=4;break;case 0xae:address=fetch()|(fetch()<<8);x=read(address);nz(x);used=4;break;case 0xac:address=fetch()|(fetch()<<8);y=read(address);nz(y);used=4;break;case 0xe8:x=(x+1)&255;nz(x);break;case 0xca:x=(x+255)&255;nz(x);break;case 0x4c:pc=fetch()|(fetch()<<8);used=3;break;case 0x69:a=(a+fetch()+(p&1))&255;nz(a);break;case 0x29:a&=fetch();nz(a);break;case 0x09:a|=fetch();nz(a);break;case 0x49:a^=fetch();nz(a);break;default:break;}cycles+=used;}}
export function cycleCount():i32{return cycles;}
export function programCounter():i32{return pc;}
export function framePointer():usize{return changetype<usize>(FRAME.buffer)+FRAME.byteOffset;}
export function frameLength():i32{return FRAME.length;}
