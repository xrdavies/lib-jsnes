import { readFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { benchmark, workload } from './benchmark-core.mjs';

const args = process.argv.slice(2);
if (args.length > 2) throw new Error('Usage: node scripts/benchmark.mjs [ROM] [WASM]');
const rom = args[0] ? new Uint8Array(await readFile(args[0])) : workload();
const wasmBytes = await readFile(args[1] ?? new URL('../dist-wasm/lib-jsnes.wasm', import.meta.url));
console.log(JSON.stringify({
  node: process.version, platform: platform(), arch: arch(),
  workload: args[0] ? 'local ROM' : 'synthetic NROM',
  ...await benchmark(rom, wasmBytes),
}, null, 2));
