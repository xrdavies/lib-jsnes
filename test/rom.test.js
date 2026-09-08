import assert from 'node:assert/strict';
import { parseRom, Nes } from '../dist/index.js';
const image = new Uint8Array(16 + 0x4000 + 0x2000); image.set([0x4e,0x45,0x53,0x1a,1,1,1,0]);
const rom = parseRom(image); assert.equal(rom.prgRom.length, 0x4000); assert.equal(rom.mirroring, 'vertical');
const nes = new Nes(image); nes.reset(); nes.runFrame(); assert.ok(nes.cycleCount >= 29780); const rgba=nes.frameRgba(); assert.equal(rgba.length,256*240*4); assert.equal(rgba[3],255); assert.throws(() => parseRom(new Uint8Array(16)), /Invalid/);
console.log('rom tests passed');
const { Button } = await import('../dist/index.js'); nes.controller1.setButtons(Button.A | Button.Start); nes.write(0x4016, 1); nes.write(0x4016, 0); assert.deepEqual([nes.read(0x4016), nes.read(0x4016), nes.read(0x4016), nes.read(0x4016)], [1,0,0,1]);
nes.write(0x4000, 0x4f); nes.write(0x4002, 0x20); nes.write(0x4003, 0); nes.write(0x4015, 1); nes.step(1000); assert.ok(nes.audioSamples().length > 0);
