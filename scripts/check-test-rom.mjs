import { readFile } from 'node:fs/promises';
import { Nes, WasmCore } from '../dist/index.js';

const [romPath, frameLimit = '3600', ...extra] = process.argv.slice(2);
const maxFrames = Number(frameLimit);
if (!romPath || extra.length || !Number.isSafeInteger(maxFrames) || maxFrames < 1) {
  throw new Error('Usage: node scripts/check-test-rom.mjs ROM [MAX_FRAMES=3600]');
}
const rom = await readFile(romPath);
const js = new Nes(rom);
const wasm = await WasmCore.from(await readFile(new URL('../dist-wasm/lib-jsnes.wasm', import.meta.url)));
wasm.loadRom(rom);
const results = {};
for (const [name, core] of [['typescript', js], ['wasm', wasm]]) {
  core.reset();
  let resetAt = 0, resets = 0, message = '';
  results[name] = { status: null, frames: maxFrames, resets, message, timeout: true };
  for (let frame = 1; frame <= maxFrames; frame++) {
    core.runFrame(); core.audioSamples();
    // Inspect backing RAM without disturbing CPU open bus or mapper read gates.
    const ram = core.saveBatteryRam();
    if (ram[1] !== 0xde || ram[2] !== 0xb0 || ram[3] !== 0x61) continue;
    const end = ram.indexOf(0, 4);
    message = new TextDecoder().decode(ram.subarray(4, end < 0 ? ram.length : end));
    if (ram[0] < 0x80) {
      results[name] = { status: ram[0], frames: frame, resets, message, timeout: false };
      break;
    }
    if (ram[0] === 0x81) {
      // The protocol requires at least 100 ms before reset: seven NTSC frames.
      if (!resetAt) resetAt = frame + 7;
      if (frame >= resetAt) { core.reset(); resets++; resetAt = 0; }
    } else resetAt = 0;
    results[name].message = message;
    results[name].resets = resets;
  }
}
console.log(JSON.stringify(results, null, 2));
process.exitCode = Object.values(results).every(result => result.status === 0) ? 0 : 1;
