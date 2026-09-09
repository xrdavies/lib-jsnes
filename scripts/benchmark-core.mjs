import { Nes, WasmCore } from '../dist/index.js';

// A deterministic, redistributable workload with background, sprites, four
// audio channels, controller polling and DMA.
export function workload() {
  const code = [], write = (a, v) => code.push(0xa9, v, 0x8d, a & 255, a >>> 8);
  write(0x2006, 0); write(0x2006, 0);
  for (const value of [...Array(8).fill(0xaa), ...Array(8).fill(0x55)]) write(0x2007, value);
  write(0x2006, 0x3f); write(0x2006, 0);
  for (let i = 0; i < 32; i++) write(0x2007, i + 1);
  for (let i = 0; i < 64; i++) {
    write(0x200 + 4 * i, (i * 17) % 230);
    write(0x203 + 4 * i, (i * 31) % 248);
  }
  write(0x4015, 15);
  for (const base of [0x4000, 0x4004, 0x4008, 0x400c]) {
    write(base, base === 0x4008 ? 0x82 : 0x7f);
    write(base + 2, base === 0x400c ? 3 : 99); write(base + 3, 8);
  }
  write(0x2001, 0x1e);
  const loop = 0x8000 + code.length;
  write(0x4014, 2); write(0x4016, 1); write(0x4016, 0);
  code.push(0xad, 0x16, 0x40, 0x85, 0, 0x4c, loop & 255, loop >>> 8);
  const rom = new Uint8Array(16 + 0x4000);
  rom.set([78, 69, 83, 26, 1, 0]); rom.set(code, 16); rom.set([0, 0x80], 16 + 0x3ffc);
  return rom;
}

// Both hosts execute identical work. Progress callbacks run outside timed regions.
export async function benchmark(rom, wasmBytes, progress = async () => {}) {
  async function pair() {
    const js = new Nes(rom), wasm = await WasmCore.from(wasmBytes);
    js.reset(); wasm.loadRom(rom); wasm.reset();
    return [js, wasm];
  }
  const warmupFrames = 60, measuredFrames = 180, rounds = 5;
  const [reference, candidate] = await pair();
  const equal = (a, b, label) => {
    if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`);
  };
  const equalArray = (a, b, label) => {
    equal(a.length, b.length, `${label} length`);
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) equal(a[i], b[i], `${label}[${i}]`);
    }
  };
  await progress('Checking 240 frames of CPU, pixel and PCM parity…');
  for (let frame = 0; frame < warmupFrames + measuredFrames; frame++) {
    reference.runFrame(); candidate.runFrame();
    for (const [index, name] of ['a', 'x', 'y', 'sp', 'p', 'pc'].entries()) {
      equal(candidate.exports.cpuRegister(index), reference.cpu[name], `Frame ${frame} CPU ${name}`);
    }
    equal(candidate.cycleCount, reference.cycleCount, `Frame ${frame} cycles`);
    equalArray(candidate.frame(), reference.frame, `Frame ${frame} pixels`);
    equalArray(candidate.audioSamples(), reference.audioSamples(), `Frame ${frame} PCM`);
  }
  equal(reference.cpu.jammed, false, 'TypeScript CPU jammed');
  equal(candidate.jammed, false, 'WASM CPU jammed');
  equal(reference.cpu.unknownOpcodes, 0, 'TypeScript unknown opcodes');
  equal(candidate.exports.unknownOpcodeCount(), 0, 'WASM unknown opcodes');
  const measurements = [[], []];
  let consumedSamples = 0;
  function run(core, frames) {
    for (let i = 0; i < frames; i++) {
      core.runFrame();
      consumedSamples += core.audioSamples().length;
    }
  }
  for (let round = 0; round < rounds; round++) {
    const cores = await pair();
    await progress(`Warming up round ${round + 1}/${rounds}…`);
    for (const core of cores) run(core, warmupFrames);
    // Alternate order so one engine is not always measured first.
    for (const index of round % 2 ? [1, 0] : [0, 1]) {
      await progress(`Timing ${index ? 'WASM' : 'TypeScript'}, round ${round + 1}/${rounds}…`);
      const start = performance.now(); run(cores[index], measuredFrames);
      measurements[index].push((performance.now() - start) / measuredFrames);
    }
  }
  await progress('Measurements complete.');
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const js = median(measurements[0]), wasm = median(measurements[1]);
  return {
    wasmBytes: wasmBytes.byteLength, warmupFrames, measuredFrames, rounds,
    parityFrames: warmupFrames + measuredFrames,
    medianMsPerFrame: { typescript: js, wasm }, wasmSpeedup: js / wasm,
    msPerFrameByRound: { typescript: measurements[0], wasm: measurements[1] },
    samplesConsumed: consumedSamples,
  };
}
