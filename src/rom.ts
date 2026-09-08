export type Mirroring = 'horizontal' | 'vertical' | 'four-screen';
export interface RomImage { readonly mapper: number; readonly format: 'ines' | 'nes2'; readonly mirroring: Mirroring; readonly battery: boolean; readonly trainer?: Uint8Array; readonly prgRom: Uint8Array; readonly chrRom: Uint8Array; readonly chrRam: boolean; }

/** Parse an iNES 1.0 image with bounds checks at the trust boundary. */
export function parseRom(input: ArrayBuffer | Uint8Array): RomImage {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 16 || bytes[0] !== 0x4e || bytes[1] !== 0x45 || bytes[2] !== 0x53 || bytes[3] !== 0x1a) throw new Error('Invalid iNES ROM header');
  const flags6 = bytes[6], flags7 = bytes[7];
  const nes2 = (flags7 & 0x0c) === 0x08;
  const prgUnits = nes2 ? (bytes[4] | ((bytes[9] & 0x0f) << 8)) : bytes[4];
  const chrUnits = nes2 ? (bytes[5] | ((bytes[9] >>> 4) << 8)) : bytes[5];
  if (nes2 && ((bytes[4] & 0x3f) === 0x3f || (bytes[5] & 0x3f) === 0x3f)) throw new Error('NES 2.0 exponent ROM sizes are not supported yet');
  const prgSize = prgUnits * 0x4000, chrSize = chrUnits * 0x2000;
  const trainerSize = flags6 & 4 ? 512 : 0, start = 16 + trainerSize, end = start + prgSize + chrSize;
  if (!prgSize || end > bytes.length) throw new Error('Truncated iNES ROM');
  const mirroring: Mirroring = flags6 & 8 ? 'four-screen' : flags6 & 1 ? 'vertical' : 'horizontal';
  return { format: nes2 ? 'nes2' : 'ines', mapper: (flags6 >>> 4) | (flags7 & 0xf0) | (nes2 ? ((bytes[8] & 0x0f) << 8) : 0), mirroring, battery: !!(flags6 & 2), trainer: trainerSize ? bytes.slice(16, start) : undefined, prgRom: bytes.slice(start, start + prgSize), chrRom: chrSize ? bytes.slice(start + prgSize, end) : new Uint8Array(0), chrRam: chrSize === 0 };
}
