// Experimental WASM CPU core; rendering and audio are not implemented yet.
const ROM = new Uint8Array(0x80000), RAM = new Uint8Array(0x800), FRAME = new Uint32Array(256 * 240);
const PRG_RAM = new Uint8Array(0x2000);
let prgStart: i32 = 0, prgBanks: i32 = 0;
let mapper: i32 = 0, bank: i32 = 0, pc: i32 = 0, cycles: i32 = 0, a: i32 = 0, x: i32 = 0, y: i32 = 0, sp: i32 = 0xfd, p: i32 = 0x24;
function read(address: i32): i32 {
  address &= 0xffff;
  if (address < 0x2000) return RAM[address & 0x7ff];
  if (address < 0x6000 || prgBanks == 0) return 0;
  if (address < 0x8000) return PRG_RAM[address - 0x6000];
  const selected = mapper == 2
    ? (address < 0xc000 ? bank : prgBanks - 1)
    : ((address - 0x8000) >>> 14) % prgBanks;
  return ROM[prgStart + selected * 0x4000 + (address & 0x3fff)];
}
function write(address: i32, value: i32): void {
  address &= 0xffff;
  if (address < 0x2000) RAM[address & 0x7ff] = value & 255;
  else if (address >= 0x6000 && address < 0x8000) PRG_RAM[address - 0x6000] = value & 255;
  else if (address >= 0x8000 && mapper == 2 && prgBanks > 0) bank = (value & 255) % prgBanks;
}
function push(value: i32): void { write(0x100 | sp, value); sp=(sp+255)&255; }
function pop(): i32 { sp=(sp+1)&255; return read(0x100 | sp); }
function fetch(): i32 { const v=read(pc); pc=(pc+1)&0xffff; return v; }
function nz(v: i32): void { p=(p&0x7d)|(v==0?2:0)|(v&0x80); }
export function romWrite(index:i32,value:i32):void{if(index>=0&&index<ROM.length)ROM[index]=value;}
export function loadRom(length: i32): void {
  prgBanks = 0;
  if (length < 16 || length > ROM.length) throw new RangeError('Invalid ROM length');
  if (ROM[0] != 78 || ROM[1] != 69 || ROM[2] != 83 || ROM[3] != 26) throw new Error('Invalid iNES header');
  if ((ROM[7] & 0x0c) != 0) throw new Error('WASM requires iNES 1.0');
  const selectedMapper = (ROM[6] >>> 4) | (ROM[7] & 0xf0);
  if (selectedMapper != 0 && selectedMapper != 2) throw new Error('Unsupported WASM mapper');
  const banks: i32 = ROM[4];
  if (banks == 0 || (selectedMapper == 0 && banks > 2)) throw new Error('Invalid PRG size');
  const start = 16 + ((ROM[6] & 4) != 0 ? 512 : 0);
  if (start + banks * 0x4000 + <i32>ROM[5] * 0x2000 > length) throw new Error('Truncated iNES ROM');
  prgStart = start;
  prgBanks = banks;
  mapper = selectedMapper;
  bank = 0;
  PRG_RAM.fill(0);
  if (start > 16) for (let i = 0; i < 512; i++) PRG_RAM[0x1000 + i] = ROM[16 + i];
}
export function reset():void{RAM.fill(0);FRAME.fill(0xff000000);cycles=0;a=0;x=0;y=0;sp=0xfd;p=0x24;bank=0;pc=prgBanks>0?read(0xfffc)|(read(0xfffd)<<8):0x8000;}
export function step(count:i32):void{if(count<=0)return;const target=cycles+count;while(cycles<target){const op=fetch();let used=2,address:i32,offset:i32;switch(op){case 0xea:break;case 0xa9:a=fetch();nz(a);break;case 0xa2:x=fetch();nz(x);break;case 0xa0:y=fetch();nz(y);break;case 0x85:write(fetch(),a);used=3;break;case 0xa5:a=read(fetch());nz(a);used=3;break;case 0xe6:address=fetch();write(address,read(address)+1);nz(read(address));used=5;break;case 0x8d:address=fetch()|(fetch()<<8);write(address,a);used=4;break;case 0x8e:address=fetch()|(fetch()<<8);write(address,x);used=4;break;case 0x8c:address=fetch()|(fetch()<<8);write(address,y);used=4;break;case 0xad:address=fetch()|(fetch()<<8);a=read(address);nz(a);used=4;break;case 0xae:address=fetch()|(fetch()<<8);x=read(address);nz(x);used=4;break;case 0xac:address=fetch()|(fetch()<<8);y=read(address);nz(y);used=4;break;case 0xe8:x=(x+1)&255;nz(x);break;case 0xca:x=(x+255)&255;nz(x);break;case 0x4c:pc=fetch()|(fetch()<<8);used=3;break;case 0x20:address=fetch()|(fetch()<<8);push((pc-1)>>>8);push(pc-1);pc=address;used=6;break;case 0x60:pc=(pop()|(pop()<<8))+1;used=6;break;case 0x48:push(a);used=3;break;case 0x68:a=pop();nz(a);used=4;break;case 0x69:a=(a+fetch()+(p&1))&255;nz(a);break;case 0x29:a&=fetch();nz(a);break;case 0x09:a|=fetch();nz(a);break;case 0x49:a^=fetch();nz(a);break;case 0xd0:offset=fetch();if(!(p&2)){pc=(pc+(offset&128?offset-256:offset))&0xffff;used=3;}break;case 0xf0:offset=fetch();if(p&2){pc=(pc+(offset&128?offset-256:offset))&0xffff;used=3;}break;default:break;}cycles+=used;}}
export function cycleCount():i32{return cycles;}
export function programCounter():i32{return pc;}
export function ramRead(index:i32):i32{return index>=0&&index<RAM.length?RAM[index]:0;}
export function framePointer():usize{return changetype<usize>(FRAME.buffer)+FRAME.byteOffset;}
export function frameLength():i32{return FRAME.length;}
