import assert from 'node:assert/strict';
import { parseRom, Nes } from '../dist/index.js';
const image = new Uint8Array(16 + 0x4000 + 0x2000); image.set([0x4e,0x45,0x53,0x1a,1,1,1,0]);
const rom = parseRom(image); assert.equal(rom.prgRom.length, 0x4000); assert.equal(rom.mirroring, 'vertical');
const nes = new Nes(image); nes.reset(); nes.runFrame(); assert.equal(nes.cycleCount, 29780); assert.throws(() => parseRom(new Uint8Array(16)), /Invalid/);
console.log('rom tests passed');
