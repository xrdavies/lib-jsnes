export type Mirroring = 'horizontal' | 'vertical' | 'four-screen';
export interface RomImage { readonly mapper: number; readonly mirroring: Mirroring; readonly battery: boolean; readonly trainer?: Uint8Array; readonly prgRom: Uint8Array; readonly chrRom: Uint8Array; readonly chrRam: boolean; }

/** Parse an iNES 1.0 image with bounds checks at the trust boundary. */
export function parseRom(input: ArrayBuffer | Uint8Array): RomImage {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 16 || bytes[0] !== 0x4e || bytes[1] !== 0x45 || bytes[2] !== 0x53 || bytes[3] !== 0x1a) throw new Error('Invalid iNES ROM header');
  const flags6 = bytes[6], flags7 = bytes[7];
  if ((flags7 & 0x0c) === 0x08) throw new Error('NES 2.0 ROMs are not supported yet');
  const prgSize = bytes[4] * 0x4000, chrSize = bytes[5] * 0x2000;
  const trainerSize = flags6 & 4 ? 512 : 0, start = 16 + trainerSize, end = start + prgSize + chrSize;
  if (!prgSize || end > bytes.length) throw new Error('Truncated iNES ROM');
  const mirroring: Mirroring = flags6 & 8 ? 'four-screen' : flags6 & 1 ? 'vertical' : 'horizontal';
  return { mapper: (flags6 >>> 4) | (flags7 & 0xf0), mirroring, battery: !!(flags6 & 2), trainer: trainerSize ? bytes.slice(16, start) : undefined, prgRom: bytes.slice(start, start + prgSize), chrRom: chrSize ? bytes.slice(start + prgSize, end) : new Uint8Array(0), chrRam: chrSize === 0 };
}
