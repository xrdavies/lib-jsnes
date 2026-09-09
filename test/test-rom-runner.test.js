import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function image(status, signature = true) {
  const code = [], write = (a, v) => code.push(0xa9, v, 0x8d, a & 255, a >>> 8);
  if (signature) [0xde, 0xb0, 0x61].forEach((v, i) => write(0x6001 + i, v));
  write(0x6004, 0x4f); write(0x6005, 0x4b); write(0x6006, 0);
  if (status === 0x81) {
    code.push(0xad, 0, 0x60, 0xc9, 0x81, 0xf0, 8); // Reset resumes with retained RAM.
    write(0x6000, 0x81);
    const wait = 0x8000 + code.length;
    code.push(0x4c, wait & 255, wait >>> 8);
    status = 0;
  }
  write(0x6000, status);
  const wait = 0x8000 + code.length; code.push(0x4c, wait & 255, wait >>> 8);
  const rom = new Uint8Array(16 + 16384);
  rom.set([78, 69, 83, 26, 1, 0]); rom.set(code, 16);
  rom.set([0, 0x80], 16 + 0x3ffc);
  return rom;
}

test('test-ROM CLI reports real status, rejects absent signatures, times out and honors delayed reset', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lib-jsnes-test-rom-'));
  try {
    const path = join(directory, 'synthetic.nes');
    for (const [status, signature] of [[0, true], [7, true], [0x80, true], [0x81, true], [0, false]]) {
      await writeFile(path, image(status, signature));
      const run = spawnSync(process.execPath, ['scripts/check-test-rom.mjs', path, '12'], { encoding: 'utf8' });
      assert.equal(run.status, signature && (status === 0 || status === 0x81) ? 0 : 1, run.stderr);
      const result = JSON.parse(run.stdout);
      for (const core of ['typescript', 'wasm']) {
        const report = result[core];
        assert.equal(report.timeout, !signature || status === 0x80);
        assert.equal(report.status, !signature || status === 0x80 ? null : status === 0x81 ? 0 : status);
        assert.equal(report.message, signature ? 'OK' : '');
        assert.equal(report.resets, status === 0x81 ? 1 : 0);
        if (status === 0x81) assert.ok(report.frames >= 9, 'reset must wait at least 100 ms');
      }
    }
    const invalid = spawnSync(process.execPath, ['scripts/check-test-rom.mjs', path, '0'], { encoding: 'utf8' });
    assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /Usage:/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
