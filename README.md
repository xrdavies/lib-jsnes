# lib-jsnes

A new TypeScript NES emulator core for browsers and Node.js. The package ships an ESM entry point for modern bundlers and Node.js. The implementation is independent from the C/C++ reference project while following the same NES hardware contracts.

## Development

```sh
npm install
npm test
npm run build:wasm
```

`npm test` builds TypeScript and WASM and runs the built-in Node test suite. `npm run build:wasm` compiles the AssemblyScript browser ABI to `dist-wasm/lib-jsnes.wasm`; the generated binary is intentionally ignored. The WASM ABI accepts a ROM through `romWrite`/`loadRom`, resets from its vector, executes the shared 6502 core through `step`, and exposes the frame buffer pointer. Both cores are in development. WASM executes the shared CPU and PPU, including background/sprite rendering, OAM DMA, and VBlank NMI. WASM also supports both standard controllers. WASM exposes the shared pulse/triangle/noise APU as mono PCM, including frame IRQs. The broader TypeScript mapper set is still missing from WASM.

## Performance

The default WASM build uses AssemblyScript optimization level 3, retaining runtime
assertions and array bounds checks. `npm run build:wasm -- --debug` generates an
unoptimized debug binary; run the default build again before packaging.

After `npm test`, run `node scripts/benchmark.mjs`. The synthetic workload includes
backgrounds, sprites, audio, controller polling, and DMA. It checks 240 frames of
CPU/pixel/PCM parity before timing five alternating rounds, each with 60 warmup
frames and 180 measured frames. Timing includes frame execution and audio drains,
but excludes module loading, RGBA conversion, display, and audio playback.
Optional arguments select a local ROM and WASM binary; paths and ROM names are
not printed. Timing is informational and is not a CI pass/fail threshold.

On the development macOS arm64 machine (Node 24.15.0), tile-row fetch reuse reduced
the synthetic median from about 1.99 to 0.87 ms/frame in TypeScript and from 4.55
to 2.30 ms/frame in WASM. The optimized binary is about 50.6 kB versus 62.6 kB.
WASM remains slower than TypeScript in this measurement. Browser performance
must be measured separately; faster WASM execution is not yet established.

## API

```ts
import { Nes } from 'lib-jsnes';
const nes = new Nes(await fetch('/game.nes').then(r => r.arrayBuffer()));
nes.reset();
const frame = nes.runFrame(); // 256x240 packed pixels
// Pass a different cycle budget to runFrame(cycles) when the host clock requires it
const rgba = nes.frameRgba(); // stable RGBA bytes for ImageData
const pcm = nes.audioSamples(); // signed 16-bit PCM
const sampleRate = nes.apu.sampleRate; // 44.1 kHz
// FRAME_WIDTH, FRAME_HEIGHT, and NTSC_FRAME_RATE are exported for the host render loop
```

Controllers use `nes.setController(1, Button.A | Button.Start)` with the exported `Button` constants. `saveState()` and `loadState()` preserve CPU, mapper, PPU, audio, controller, and RAM state. Use `saveBatteryRam()` and `loadBatteryRam()` to persist cartridge battery RAM in browser storage or Node.

Snapshot bytes are an evolving development format. The current APU snapshot stores
all implemented oscillator registers, timers, lengths, and sampling/frame phases;
older snapshots with previous APU sections are rejected. Restoring discards queued
PCM from the abandoned timeline and preserves the phase of newly generated audio.
Pulse channels implement all four duty patterns, CPU/2 timer clocks, and half-frame
sweeps with channel-specific negate and target-overflow muting. Tests check output
frequency, duty ratios, sweep timing, and snapshot continuation. Audio remains
incomplete: DMC, exact frame edge timing, and the nonlinear mixer are not
implemented.

The CPU advances the APU after each instruction, DMA stall, and interrupt entry.
Audio register changes and status reads therefore take effect within a host
`step()` call. Timing within individual CPU instructions is still approximate.

## Cartridge support

The current mapper layer supports NROM (0), MMC1 (1), UxROM (2), CNROM (3), MMC3 bank switching (4), AxROM (7), mapper 15, mapper 79, mapper 87, mapper 113, mapper 140, mapper 177, mapper 225, mapper 241, and GxROM (66). MMC3 scanline IRQ counting is available; advanced mapper variants and exact edge timing remain in progress.

The WASM module exports `memory`; read `frameLength()` 32-bit pixels beginning at
`framePointer()` with a `Uint32Array(memory.buffer, framePointer(), frameLength())`.
Its cartridge path accepts iNES 1.0 NROM, UxROM, CNROM, AxROM, and GxROM (mappers 0, 2, 3, 7, and 66), including
16 KiB NROM mirroring and optional trainer data. PRG mapping excludes CHR bytes.
NES 2.0 linear-size headers are accepted; exponent-size encodings and other unsupported mappers are rejected by this experimental WASM core.
`parseRom()` handles both NES 2.0 size encodings: byte 9's low/high nibble selects
PRG/CHR exponent encoding when it equals 15. Other values extend the linear bank
count. The parser preserves the 12-bit mapper number; WASM validates these high
bits before accepting a cartridge. Parsing a layout does not imply support for
its board, submapper, or extended RAM configuration.
The TypeScript core supports the broader mapper list above.

AxROM and GxROM tests cover every bank-register value, both PRG halves, the full CHR window,
smaller ROM mirroring, CHR RAM, reset, and rendered pixels. CNROM and GxROM reset
both PRG and CHR selectors. AxROM reset selects PRG bank zero and the lower
single-screen nametable while retaining CHR RAM and nametable contents.
Bus conflicts and board-specific variants remain
outside the current WASM mapper model.

WASM builds compile the execution methods from `src/cpu.ts`, `src/ppu.ts`, `src/apu.ts`, and `src/controller.ts`, using the installed
TypeScript compiler to supply AssemblyScript integer annotations. The generated
source is temporary and is not shipped. There is no separately maintained WASM
opcode switch or renderer. Tests compare all 151 official opcodes and the 52 stable LAX, SAX,
SLO, RLA, SRE, RRA, DCP, and ISC encodings against the TypeScript CPU
(registers, RAM, and cycles) and independently check every ADC/SBC operand pair.
These checks establish CPU parity, not complete hardware compatibility; CPU bus
access timing remains approximate and undocumented opcode coverage is partial.
`core.exports.unknownOpcodeCount()` reports encounters with unimplemented opcodes.

Synthetic ROMs compare complete frames between the two builds and assert known
background/sprite pixels, nametable mirroring, OAM wrapping, and NMI counts.
WASM uses the same frame-batched renderer as TypeScript: raster effects, exact
sprite evaluation, and per-bus-cycle PPU timing remain incomplete. Frame views
use packed `0xAARRGGBB` pixels; they are not RGBA byte views for `ImageData`.
Obtain a fresh view from `core.frame()` after stepping, since WASM memory growth
can invalidate an older view.

To check both CPU builds against a local NROM reference trace (such as `nestest`),
build with `npm test`, then run:

```sh
node scripts/check-cpu-trace.mjs /path/to/test.nes /path/to/test.log
```

The checker accepts the `nestest` log format, starts at its first PC with reset
registers, and compares every recorded CPU register and cycle count. It also
compares final CPU RAM between builds. Input files are read locally and are not
modified or bundled. PPU timing columns are not checked. Both builds matched all
8,991 states in the development reference trace; this does not establish full
game compatibility or support for unstable undocumented opcodes.
For a typed wrapper, load the generated bytes with `WasmCore.from()`:

```ts
import { WasmCore, Button } from 'lib-jsnes';
const core = await WasmCore.from(await fetch('/lib-jsnes.wasm'));
core.loadRom(new Uint8Array(await fetch('/game.nes').then(r => r.arrayBuffer())));
core.reset();
core.setController(1, Button.Start); // Replace player 1's held buttons.
core.runFrame();
core.setController(1, 0); // Release all buttons.
const pixels = core.frame();
const rgba = core.frameRgba(); // ImageData-compatible bytes
const pcm = core.audioSamples(); // Owned Int16Array; drains the queued mono samples.
const sampleRate = core.sampleRate; // 44100 Hz.
```

`setController(player, mask)` accepts player 1 or 2 and the same `Button` masks
as `Nes`. The CPU reads the shared serial controller implementation at `$4016`
and `$4017`; writing `$4016` latches both controllers. Host button changes affect
the next latch, or live A-button reads while strobe is high.

`audioSamples()` copies the queued PCM into a host-owned array, so later steps,
drains, or WASM memory growth do not overwrite it. Reset discards queued samples.
Drain regularly; the queue retains at most two seconds when the host falls behind.
For Web Audio, divide each sample by 32768 when filling a mono `AudioBuffer`.

`frameRgba()` returns an independent `Uint8ClampedArray` in the byte order expected by `new ImageData(rgba, 256, 240)`.
Raw ABI consumers call `audioDrain()` to obtain the sample count, then use
`audioPointer()` and exported `memory` to read signed 16-bit samples; copy that
view before the next drain, reset, or memory growth. `sampleRate()` returns Hz.

Audio tests compare both frame modes, each implemented channel, full-width timer
periods, mixed PCM, and DMA/NMI/IRQ timing between builds. The shared APU still
lacks DMC and a nonlinear mixer, and its frame-edge timing remains approximate.


## Publishing

From a clean checkout, run `npm ci`, `npm test`, and `npm run build:wasm`. Inspect the package with `npm pack --dry-run`, then run `npm version <major|minor|patch>` to create the release commit and tag. Authenticate with `npm login` (or configure a publish token), verify the target with `npm whoami`, and publish with `npm publish --access public`. Push the commit and tag with `git push origin main --follow-tags`. A published version cannot be replaced, so verify the version and package contents before publishing.
