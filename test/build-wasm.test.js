import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, delimiter } from 'node:path';
import { spawn } from 'node:child_process';

test('isolated WASM builds tolerate concurrency and stale locks, preserving output on failure', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'lib-jsnes-build-'));
  try {
    for (const name of ['src', 'wasm', 'scripts']) await cp(resolve(name), join(fixture, name), { recursive: true });
    await symlink(resolve('node_modules'), join(fixture, 'node_modules'), 'dir');
    await mkdir(join(fixture, 'dist-wasm/.build.lock'), { recursive: true });
    await mkdir(join(fixture, '.wasm-build-abandoned'));
    const env = { ...process.env, PATH: resolve('node_modules/.bin') + delimiter + process.env.PATH };
    const build = () => new Promise((resolveResult, reject) => {
      const child = spawn(process.execPath, ['scripts/build-wasm.mjs'], { cwd: fixture, env, timeout: 30000 });
      let output = '';
      child.stdout.on('data', data => { output += data; });
      child.stderr.on('data', data => { output += data; });
      child.on('error', reject);
      child.on('close', (code, signal) => resolveResult({ code, signal, output }));
    });
    const results = await Promise.all([build(), build()]);
    for (const result of results) assert.equal(result.code, 0, result.output);
    const binaryPath = join(fixture, 'dist-wasm/lib-jsnes.wasm');
    const binary = await readFile(binaryPath);
    assert.ok(WebAssembly.validate(binary));
    assert.deepEqual(binary, await readFile('dist-wasm/lib-jsnes.wasm'), 'random staging paths must not change the binary');
    const sourcePath = join(fixture, 'wasm/index.ts'), source = await readFile(sourcePath, 'utf8');
    await writeFile(sourcePath, source + '\nthis is not valid AssemblyScript;\n');
    const failed = await build();
    assert.notEqual(failed.code, 0); assert.equal(failed.signal, null);
    assert.deepEqual(await readFile(binaryPath), binary, 'failed builds must not replace usable output');
    await writeFile(sourcePath, source);
    const retry = await build(); assert.equal(retry.code, 0, retry.output);
    assert.deepEqual(await readFile(binaryPath), binary);
    assert.deepEqual((await readdir(fixture)).filter(name => name.startsWith('.wasm-build-')), ['.wasm-build-abandoned']);
    assert.deepEqual(await readdir(join(fixture, 'dist-wasm')), ['.build.lock', 'lib-jsnes.wasm']);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
