export type ConsoleType = 'nes' | 'vs' | 'playchoice' | 'extended';
export type Mirroring = 'horizontal' | 'vertical' | 'four-screen';
export interface RomImage { readonly mapper: number; readonly consoleType?: ConsoleType; readonly format: 'ines' | 'nes2'; readonly mirroring: Mirroring; readonly battery: boolean; readonly trainer?: Uint8Array; readonly prgRom: Uint8Array; readonly chrRom: Uint8Array; readonly chrRam: boolean; }

/** Parse iNES or NES 2.0 ROM sizes and mapper bits with bounds checks. */
export function parseRom(input: ArrayBuffer | Uint8Array): RomImage {
  const bytes = input instanceof Uint8Array ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
  if (bytes.length < 16 || bytes[0] !== 0x4e || bytes[1] !== 0x45 || bytes[2] !== 0x53 || bytes[3] !== 0x1a) throw new Error('Invalid iNES ROM header');
  const flags6 = bytes[6], flags7 = bytes[7];
  const format = flags7 & 0x0c;
  if (format !== 0 && format !== 8) throw new Error('Unsupported ROM format');
  const nes2 = format === 8;
  const consoleType: ConsoleType = (['nes', 'vs', 'playchoice', 'extended'] as const)[flags7 & 3];
  const prgUnits = nes2 ? (bytes[4] | ((bytes[9] & 0x0f) << 8)) : bytes[4];
  const chrUnits = nes2 ? (bytes[5] | ((bytes[9] >>> 4) << 8)) : bytes[5];
  const exponentSize = (value:number): number => { const exponent=value>>>2, multiplier=(value&3)*2+1; if(exponent>30)throw new Error('NES 2.0 ROM size is too large'); return 2**exponent*multiplier; };
  const prgSize = nes2 && (bytes[9] & 0x0f) === 0x0f ? exponentSize(bytes[4]) : prgUnits*0x4000;
  const chrSize = nes2 && (bytes[9] >>> 4) === 0x0f ? exponentSize(bytes[5]) : chrUnits*0x2000;
  const trainerSize = flags6 & 4 ? 512 : 0, start = 16 + trainerSize, end = start + prgSize + chrSize;
  if (!prgSize || end > bytes.length) throw new Error('Truncated iNES ROM');
  const mirroring: Mirroring = flags6 & 8 ? 'four-screen' : flags6 & 1 ? 'vertical' : 'horizontal';
  return { consoleType, format: nes2 ? 'nes2' : 'ines', mapper: (flags6 >>> 4) | (flags7 & 0xf0) | (nes2 ? ((bytes[8] & 0x0f) << 8) : 0), mirroring, battery: !!(flags6 & 2), trainer: trainerSize ? bytes.slice(16, start) : undefined, prgRom: bytes.slice(start, start + prgSize), chrRom: chrSize ? bytes.slice(start + prgSize, end) : new Uint8Array(0), chrRam: chrSize === 0 };
}
