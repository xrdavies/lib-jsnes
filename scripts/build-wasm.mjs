import { spawnSync } from 'node:child_process';
const result = spawnSync('asc', ['wasm/index.ts', '--outFile', 'dist-wasm/lib-jsnes.wasm', '--exportRuntime', '--exportTable'], { stdio: 'inherit' });
if (result.error) { console.error('WASM build requires AssemblyScript: npm install'); process.exit(1); }
process.exit(result.status ?? 1);
