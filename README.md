# lib-jsnes

A new TypeScript NES emulator core for browsers and Node.js. The package ships an ESM entry point for modern bundlers and Node.js. The implementation is independent from the C/C++ reference project while following the same NES hardware contracts.

## Development

```sh
npm install
npm test
npm run build:wasm
```

`npm test` builds TypeScript and WASM and runs the built-in Node test suite. `npm run build:wasm` compiles the AssemblyScript browser ABI to `dist-wasm/lib-jsnes.wasm`; the generated binary is intentionally ignored. The WASM ABI accepts a ROM through `romWrite`/`loadRom`, resets from its vector, executes the shared 6502 core through `step`, and exposes the frame buffer pointer. Both cores are in development. WASM executes the shared CPU and PPU, including background/sprite rendering, OAM DMA, and VBlank NMI. WASM also supports both standard controllers. WASM exposes the shared pulse/triangle/noise/DMC APU as mono PCM, including frame and DMC IRQs. The broader TypeScript mapper set is still missing from WASM.

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

For the browser benchmark, run `npm test`, then serve the repository root:

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

Open `http://127.0.0.1:8000/scripts/benchmark.html` and select **Run benchmark**.
Keep the tab visible; a run that observes a hidden tab is rejected. The browser
and Node entry points share the synthetic ROM, parity checks and timing loop.
Both compare all six CPU registers, cycles, every pixel and every PCM sample
before timing. Results include individual rounds, medians and WASM speedup
(TypeScript time divided by WASM time; above 1 means WASM was faster).
The browser page also records its user-agent string. Progress updates and browser
event-loop yields occur outside the timed regions. No game file is uploaded.
This measures core execution; it does not measure canvas or Web Audio performance.

On the development macOS arm64 machine (Node 24.15.0), tile-row fetch reuse reduced
the synthetic median from about 1.99 to 0.87 ms/frame in TypeScript and from 4.55
to 2.30 ms/frame in WASM. The optimized binary is about 50.6 kB versus 62.6 kB.
WASM remains slower than TypeScript in this measurement. Browser performance
must be measured separately; faster WASM execution is not yet established.

The PPU now skips idle dots between the events implemented by its current timing
model. On the same Node/macOS arm64 setup, a before/after synthetic run measured
about 0.97 to 0.86 ms/frame in TypeScript and 2.48 to 2.31 ms/frame in WASM.
Boundary tests compare batch advances against individual dots, including VBlank,
NMI, scanline counts and multiple frame wraps. This optimization preserves the
existing frame-batched renderer; it does not add raster-effect accuracy.

Profiling also identified repeated per-pixel color conversion and per-cycle APU
frame-sequencer dispatch. The renderer now builds its 32 packed colors once per
frame, and the APU dispatches only at its next sequencer event while continuing
to clock oscillators every CPU cycle. Recent synthetic Node runs on this machine
changed from roughly 0.85 to 0.67 ms/frame in TypeScript and 2.29 to 1.90 ms/frame
in WASM. Both derived caches are rebuilt after their inputs change or snapshots
are restored; snapshot sizes are unchanged. Tests cover palette/mask changes,
reset and restoration around each sequencer boundary. These remain Node results,
and WASM remains slower in this workload.

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
CHR RAM cartridges append their 8 KiB of pattern memory to the cartridge section;
CHR ROM cartridges retain the existing section size. `cartridge.stateSize` gives
the actual section length, while `Cartridge.STATE_SIZE` is the fixed register/PRG
RAM prefix. Old CHR RAM snapshots that omitted pattern memory are rejected.
Restoring copies both RAM regions, including currently hidden CHR banks, so
subsequent frames redraw from the saved tiles. This applies to `Nes` snapshots;
the WASM wrapper does not yet expose a snapshot API.
`Nes` snapshots also append an eight-byte little-endian DMA stall counter after
CPU RAM. Restoring mid-transfer keeps the CPU halted for the remaining cycles
while PPU and APU clocks advance. Older snapshots without this field are rejected.
OAM bytes are still copied at the DMA request; per-cycle DMA bus transfers remain
outside the current timing model.
Pulse channels implement all four duty patterns, CPU/2 timer clocks, and half-frame
sweeps with channel-specific negate and target-overflow muting. Tests check output
frequency, duty ratios, sweep timing, and snapshot continuation. Audio remains
incomplete: exact frame edge timing and the nonlinear mixer are not implemented.

The triangle timer runs every CPU cycle and advances its 32-step sequencer once
per programmed period plus one, gated by the length and linear counters. Tests
check timer boundaries and emitted PCM frequency in both builds. Output DAC
behavior while gated and other analog audio details remain approximate.

Noise timer table entries are CPU-cycle intervals. The LFSR keeps running while
the channel is disabled, and period/mode writes preserve the current countdown
and shift register. Tests check all 16 NTSC periods with both feedback taps,
snapshot continuation, and matching PCM from the TypeScript and WASM builds.

DMC implements the 16 NTSC sample rates, one-byte prefetch, LSB-first delta
output, seven-bit DAC limits, address wrap, looping, and completion IRQs. Both
system cores read samples through their current CPU cartridge mapping and charge
four stall cycles per fetch. This is an instruction-level DMA approximation:
read-cycle alignment, OAM/DMC arbitration, and controller-read glitches are not
modeled. The output uses a provisional linear gain; analog mixing/filtering is
still incomplete.

`new Apu()` remains valid for standalone synthesis, including direct `$4011` DAC
writes. For DMC sample playback, supply `new Apu({ readDmc(address) { ... } })`;
the host supplies memory and accounts for fetch stalls. `Nes` and `WasmCore`
connect this bus automatically. Reading `$4015` clears only the frame IRQ;
writing `$4015` or disabling IRQ in `$4010` acknowledges DMC IRQ. Stopping the
reader leaves buffered output and the current DAC level intact.

The APU snapshot is now 78 bytes and includes the DMC reader, prefetch byte,
shift register, timer, DAC, and IRQ. Previous 62-byte APU snapshots are rejected.
DMC tests cover all rates, maximum length, mapper wrap, output limits, CPU IRQs,
continued output after stopping, and snapshot replay in TypeScript, with PCM and
CPU parity checks in WASM.

The CPU advances the APU after each instruction, DMA stall, and interrupt entry.
Audio register changes and status reads therefore take effect within a host
`step()` call. Timing within individual CPU instructions is still approximate.

## Cartridge support

The current mapper layer supports NROM (0), MMC1 (1), UxROM (2), CNROM (3), MMC3 bank switching (4), AxROM (7), mapper 15, mapper 79, mapper 87, mapper 113, mapper 140, mapper 177, mapper 225, mapper 241, and GxROM (66). MMC3 scanline IRQ counting is available; advanced mapper variants and exact edge timing remain in progress.

MMC3 CHR tests cover all eight 1 KiB windows in both inversion modes, aligned
R0/R1 pairs, all register-byte values, CHR RAM writes, snapshot restoration,
and rendered pixels. This covers bank mapping, not cycle-accurate MMC3 IRQs.
The MMC3 counter continues while its IRQ output is disabled. Once asserted, the
IRQ remains pending across CPU masking and counter reloads until `$E000` clears
it. The cartridge snapshot stores this latch in reserved byte 25 without changing
section length. `clockScanline()` returns the current IRQ level; the CPU polls
`cartridge.irqPending` at instruction boundaries. Clocking is still scanline-based,
so PPU A12 filtering and MMC3 revision-specific IRQ edge behavior remain incomplete.

The WASM module exports `memory`; read `frameLength()` 32-bit pixels beginning at
`framePointer()` with a `Uint32Array(memory.buffer, framePointer(), frameLength())`.
Its cartridge path accepts iNES 1.0 NROM, MMC1, UxROM, CNROM, MMC3, AxROM, mapper 15, and GxROM (mappers 0, 1, 2, 3, 4, 7, 15, and 66), including
16 KiB NROM mirroring and optional trainer data. PRG mapping excludes CHR bytes.
NES 2.0 linear-size headers are accepted; exponent-size encodings and other unsupported mappers are rejected by this experimental WASM core.
`parseRom()` handles both NES 2.0 size encodings: byte 9's low/high nibble selects
PRG/CHR exponent encoding when it equals 15. Other values extend the linear bank
count. The parser preserves the 12-bit mapper number; WASM validates these high
bits before accepting a cartridge. Parsing a layout does not imply support for
its board, submapper, or extended RAM configuration.
The TypeScript core supports the broader mapper list above.

Mapper 15 now uses all four address-selected PRG modes in both cores: a
sequential 32 KiB window, a switchable 16 KiB window with a fixed upper bank
within its 128 KiB group, one 8 KiB bank repeated four times, and one 16 KiB
bank repeated twice. Register bit 6 controls horizontal/vertical mirroring;
bit 7 selects the 8 KiB half in mode 2. Mode 3 protects CHR RAM writes. Reset
selects mode 0, bank zero and vertical mirroring while retaining RAM.
This follows the compatibility behavior documented by the
[FCEUX mapper 15 implementation](https://github.com/TASEmulators/fceux/blob/master/src/boards/15.cpp).
Board variants differ in bit-7 behavior outside mode 2 and mode-0 CHR write
protection; those variants are not distinguished here. CPU-driven synthetic tests
check every register byte, all four PRG windows, address aliases, smaller ROM
wrapping, nametable mirroring and CHR protection in both builds. TypeScript
snapshots now store the raw data latch in cartridge byte 22 and mode (0–3) in
byte 23. Previous mapper-15 snapshots containing a bank shift (13/14) are
rejected; other mapper snapshot layouts are unchanged.

WASM MMC3 implements both PRG/CHR bank modes, CHR RAM, mapper mirroring and
four-screen boards, plus the same coarse scanline IRQ latch as TypeScript.
CPU-driven tests compare memory, rendered frames, PCM, and interrupt handling.
Both cores implement `$A001` PRG RAM enable (bit 7) and write protection (bit 6).
Disabled RAM reads currently return zero rather than CPU open-bus data. Reset
deterministically enables writable RAM without discarding its contents; this is
an emulator initialization choice, not a guarantee about hardware power-on state.
The TypeScript cartridge snapshot packs RAM-disable/write-protect into bits 1/2
of byte 25 alongside IRQ pending in bit 0. A12 edge filtering and revision-specific
IRQ behavior remain incomplete.

WASM MMC1 supports serial register writes, all four PRG modes, aligned 8 KiB and
split 4 KiB CHR banks, four mirroring modes, and PRG RAM disable. Tests execute
register writes through the CPU and compare mapped bytes and rendered frames.
Extended MMC1 boards (over 256 KiB PRG or 128 KiB CHR) are rejected by both
cores. Consecutive-cycle MMC1 write suppression and board variants remain
unimplemented; instruction-level bank tests do not establish cycle accuracy.

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
PPUMASK grayscale masks palette codes with `$30` for rendering and palette-port
reads, preserving the stored colors for later color output. Tests cover all 64
palette codes, background/sprite output, and WASM parity. Color emphasis and
analog video output remain approximations.

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

`WasmCore.saveBatteryRam()` and `loadBatteryRam(bytes)` use the same raw 8 KiB
PRG RAM format as `Nes`. Save returns an independent `Uint8Array`; load copies
an exactly sized array and rejects other lengths before writing. Restore after
`loadRom()`, which clears cartridge RAM; `reset()` retains it. Host persistence
accesses stored RAM even when the mapper disables CPU access or protects writes,
and does not change those mapper controls. The host chooses storage and associates
data with the correct cartridge, using `parseRom(bytes).battery` when appropriate.
This is battery RAM persistence, not a full emulator snapshot.

Raw WASM hosts can use `batteryRamPointer()` and `batteryRamLength()` with exported
`memory`. As with frame views, obtain a fresh view after memory growth. The typed
wrapper copies bytes so callers need not retain a view into WASM memory.

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
lacks a nonlinear mixer, and its frame-edge timing remains approximate.


## Publishing

From a clean checkout, run `npm ci`, `npm test`, and `npm run build:wasm`. Inspect the package with `npm pack --dry-run`, then run `npm version <major|minor|patch>` to create the release commit and tag. Authenticate with `npm login` (or configure a publish token), verify the target with `npm whoami`, and publish with `npm publish --access public`. Push the commit and tag with `git push origin main --follow-tags`. A published version cannot be replaced, so verify the version and package contents before publishing.
