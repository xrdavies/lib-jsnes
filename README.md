# lib-jsnes

A new TypeScript NES emulator core for browsers and Node.js. The package ships an ESM entry point for modern bundlers and Node.js. The implementation is independent from the C/C++ reference project while following the same NES hardware contracts.

## Development

```sh
npm install
npm test
npm run build:wasm
```

`npm test` builds TypeScript and WASM and runs the built-in Node test suite. `npm run build:wasm` compiles the AssemblyScript browser ABI to `dist-wasm/lib-jsnes.wasm`; the generated binary is intentionally ignored. The WASM ABI accepts a ROM through `romWrite`/`loadRom`, resets from its vector, executes the shared 6502 core through `step`, and exposes the frame buffer pointer. Both cores are in development. WASM executes the shared CPU and PPU, including background/sprite rendering, OAM DMA, and VBlank NMI. WASM also supports both standard controllers. WASM exposes the shared pulse/triangle/noise/DMC APU as mono PCM, including frame and DMC IRQs. Both builds support the same 15 mapper IDs listed below. The build takes a short directory lock so concurrent test, publish and manual builds do not delete each other's generated source files.

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

The benchmark has changed as the renderer and runtime have evolved. Run
`node scripts/benchmark.mjs` on the current checkout for reproducible numbers;
it reports exact binary size and per-round medians instead of embedding
hardware-specific measurements in this document.

The PPU now skips idle dots between the events implemented by its current timing
model. On the same Node/macOS arm64 setup, a before/after synthetic run measured
about 0.97 to 0.86 ms/frame in TypeScript and 2.48 to 2.31 ms/frame in WASM.
Boundary tests compare batch advances against individual dots, including VBlank,
NMI, scanline counts and multiple frame wraps. This optimization preserves the
event ordering; the renderer now completes individual scanlines as described below.

Profiling also identified repeated per-pixel color conversion and per-cycle APU
frame-sequencer dispatch. The renderer now builds its 32 packed colors once per
scanline, and the APU dispatches only at its next sequencer event while continuing
to clock oscillators every CPU cycle. Recent synthetic Node runs on this machine measured roughly 0.67 ms/frame in
TypeScript and 0.55 ms/frame in WASM. The current optimized binary is about 40 kB;
exact values vary with Node and host hardware. Both derived caches are rebuilt after their inputs change or snapshots
are restored; snapshot sizes are unchanged. Tests cover palette/mask changes,
reset and restoration around each sequencer boundary. These measurements also used the incremental runtime.

The current build uses AssemblyScript's `minimal` runtime, with explicit garbage
collection after roughly 29,780 emulated CPU cycles, after audio drains and after
reset. Collection runs after device execution returns, when all live core objects
are reachable from module globals. It also runs inside large `step()` calls;
hosts do not need to call `__collect()`. Runtime assertions and bounds checks remain
enabled. Hosts using the raw allocation exports must pin managed objects they
retain, since collection traces globals and pinned objects, not host pointers or
WASM stack locals. Frame, battery RAM and current audio buffers are rooted by the
core; previously documented view lifetimes still apply.

With explicit collection, the synthetic Node median is about 0.55 ms/frame in
WASM versus about 0.67 ms/frame in TypeScript (about 1.21× WASM speedup). These
are Node 24.15.0 results on macOS arm64, not browser measurements or a universal
speedup.
In both debug and optimized builds, a stress test runs one large step spanning
3,000 frames without audio drains after a 300-frame warmup, checks CPU/pixel/PCM
parity and verifies that linear memory does not keep growing. The optimized run
plateaued at 2.5 MiB. Another test repeatedly resets and drains a stopped core,
checking reclamation and the lifetime of host-owned PCM copies.

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
`Nes.loadState()` copies and validates all sections before modifying live state.
An invalid snapshot leaves CPU/device state, RAM, pending DMA and queued PCM
intact. PPU restoration rejects out-of-range addresses, scanlines, dots and boolean
flags; controller restoration rejects invalid serial indices and strobe flags.
The same validators are used by direct component restores. These checks do not
change snapshot sizes or identify which ROM produced a snapshot; hosts must still
associate saves with the correct cartridge.
The CPU snapshot is now `Cpu6502.STATE_SIZE` (15 bytes): seven bytes for registers
and PC followed by an eight-byte little-endian Float64 cycle count. This preserves
nonnegative safe-integer counts beyond 2³², where the former four-byte encoding
wrapped after roughly 40 minutes of emulated NTSC time. Non-finite, fractional,
negative and unsafe cycle counts are rejected before restoring state. Previous
11-byte CPU snapshots and full `Nes` snapshots containing that CPU layout are
rejected. Full snapshots are four bytes larger; other component layouts are
unchanged. Boundary tests seed long-running counts and verify continuation through
pending DMA after restore.
CHR RAM cartridges append their 8 KiB of pattern memory to the cartridge section;
CHR ROM cartridges do not append pattern memory. `cartridge.stateSize` gives
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
incomplete: exact frame edge timing and analog output filters are not implemented.

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
modeled. The output feeds the shared nonlinear mixer; analog filtering remains incomplete.

The mixer uses generated transfer-curve tables: `95.52 / (8128 / p + 100)`
for the sum of the two pulse DACs, and `163.67 / (24329 / tnd + 100)` for
`tnd = 3 * triangle + 2 * noise + dmc`, with zero input mapped to zero.
This weighted TND lookup is an approximation of the analog circuit, following
the reference core's mixing model. Each table is scaled by 32767 and truncated
before summing, keeping TypeScript and WASM PCM identical. Tests cover all 31
pulse sums and 203 weighted TND inputs, compression and DMC-dependent gain.
The old linear gains and fixed negative bias are removed. Samples use Int16Array
storage but are currently unipolar (zero to positive full scale); DC removal and
analog high/low-pass filters are not yet modeled. Snapshot layout is unchanged,
but replaying an older snapshot now generates the new mix rather than old PCM.

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

`WasmCore.step(cycles)` and `runFrame(cycles)` accept integer budgets from 1 to
2,147,483,647 per call. Larger values are rejected before entering WASM, preventing
the signed 32-bit ABI from silently truncating them. Split longer runs into
multiple calls; the cumulative cycle count remains a JavaScript number rather
than a 32-bit counter. Raw callers of `exports.step` must enforce this bound
before crossing the ABI, where the original JavaScript value is no longer available.
`Nes.step()` applies the same cumulative safe-integer guard: a budget that would
make its CPU cycle counter exceed `Number.MAX_SAFE_INTEGER` is rejected before
any CPU, PPU, APU, DMA or audio state changes.
The guard reserves 14 additional cycles: up to seven for the final instruction's
budget overshoot and seven for a following NMI or IRQ entry. The raw WASM step
function checks the same cumulative limit. Tests exercise an eight-cycle SLO
followed by NMI or IRQ, verifying rejection without partial changes and exact
execution at the last permitted starting count.

## Cartridge support

The current mapper layer supports NROM (0), MMC1 (1), UxROM (2), CNROM (3), MMC3 bank switching (4), AxROM (7), mapper 15, mapper 79, mapper 87, mapper 113, mapper 140, mapper 177, mapper 225, mapper 241, and GxROM (66). MMC3 scanline IRQ counting is available; advanced mapper variants and exact edge timing remain in progress.

MMC3 CHR tests cover all eight 1 KiB windows in both inversion modes, aligned
R0/R1 pairs, all register-byte values, CHR RAM writes, snapshot restoration,
and rendered pixels. This covers bank mapping, not cycle-accurate MMC3 IRQs.
The MMC3 counter continues while its IRQ output is disabled. Once asserted, the
IRQ remains pending across CPU masking and counter reloads until `$E000` clears
it. The cartridge snapshot stores this latch in reserved byte 25 without changing
section length. The PPU clocks MMC3 at dot 280 only when background or sprite
rendering is enabled and the line is visible or pre-render; VBlank and disabled
rendering do not decrement the counter. `clockScanline()` remains available for
direct mapper tests, while the CPU polls `cartridge.irqPending` at instruction
boundaries. Qualified A12 edges and MMC3 revision-specific behavior remain
incomplete. Tests cover rendering masks, VBlank exclusion, DMA and snapshot replay.

The WASM module exports `memory`; read `frameLength()` 32-bit pixels beginning at
`framePointer()` with a `Uint32Array(memory.buffer, framePointer(), frameLength())`.
Its cartridge path accepts iNES 1.0 NROM, MMC1, UxROM, CNROM, MMC3, AxROM, mapper 15, GxROM, and mappers 79, 87, 113, 140, 177, 225 and 241 (mappers 0, 1, 2, 3, 4, 7, 15, 66, 79, 87, 113, 140, 177, 225 and 241), including
16 KiB NROM mirroring and optional trainer data. PRG mapping excludes CHR bytes.
NES 2.0 linear and exponent-size headers are accepted for supported mappers; unsupported boards and malformed layouts are rejected by this experimental WASM core.
Exponent sizes are computed with a widened integer and checked against capacity
before conversion to WASM's 32-bit indices. The current WASM bank implementation
requires PRG sizes divisible by 16 KiB and nonzero CHR ROM sizes divisible by
1 KiB for MMC3, 4 KiB for MMC1, or 8 KiB for other supported mappers. Smaller or
partial banks remain unsupported even when `parseRom()` can parse their layout.
The wrapper checks these constraints before replacing a running cartridge; the
native loader enforces the same constraints for raw ABI users. Tests cover all
four exponent multipliers, truncated headers that previously overflowed, and
rejection of unsupported layouts without modifying the wrapper's active ROM.
`WasmCore.loadRom()` now allocates ROM storage to fit the input and copies it in
one bulk transfer. The former fixed 512 KiB capacity no longer rejects layouts
such as 512 KiB PRG plus 256 KiB CHR. `MAX_ROM_SIZE` is the largest supported
linear header layout (16-byte header, optional 512-byte trainer, 3839 PRG units
and 3839 CHR units), not an eagerly allocated buffer. Mapper and board restrictions
still apply. CNROM/GxROM CHR selection uses the decoded full size, including NES
2.0 extension bits. Tests cover large MMC3 banking, all CNROM register values
with 256 CHR banks, invalid replacements and repeated large/small reloads.

Raw WASM hosts can call `romAllocate(length)` to obtain a pointer, copy bytes into
the new buffer, then call `loadRom(length)` and `reset()`. Finish that sequence
before stepping; allocation replaces the previous ROM storage. Acquire the memory
view after allocation, since memory may grow. `romWrite(index, value)` remains
available, with an initial 512 KiB buffer for existing raw hosts. The typed wrapper
validates the ROM before allocation and copies any input view backed by its own
WASM memory before growth or collection can invalidate it. Use the wrapper and
binary from the same build; older binaries do not export `romAllocate`.

`parseRom()` handles both NES 2.0 size encodings: byte 9's low/high nibble selects
PRG/CHR exponent encoding when it equals 15. Other values extend the linear bank
count. The parser preserves the 12-bit mapper number; WASM validates these high
bits before accepting a cartridge. Parsing a layout does not imply support for
its board, submapper, or extended RAM configuration.
Both cores support the same mapper IDs; board variants and accepted ROM layouts can still differ.

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

Mapper 225 now uses aligned even/odd 16 KiB bank pairs in 32 KiB mode and
repeats the selected 16 KiB bank in both windows in mirrored mode. Address bit 14
extends both PRG and CHR selection, bit 13 selects mirroring, and bit 12 selects
the PRG mode. Write data does not affect these selectors. Reset selects PRG banks
0/1, CHR bank zero and vertical mirroring while retaining RAM. Both cores also
implement four 4-bit registers mirrored across `$5800–$5FFF`, addressed by the low
two address bits, as described by the
[FCEUX mapper 225 implementation](https://github.com/TASEmulators/fceux/blob/master/src/boards/225.cpp).
Unmapped expansion reads still return zero rather than CPU open-bus data.
Tests sweep every selector address through the CPU, including outer banks and
small-ROM wrapping, and check nibble-register aliases, reset and PPU output.
TypeScript mapper-225 snapshots append four register bytes after any CHR RAM;
older snapshots lacking these bytes are rejected. Other mapper section sizes
are unchanged. Matching mapper IDs does not establish complete game compatibility.

Both cores distinguish mapper 79 (NINA-03/06) from mapper 113: mapper 79 uses
bit 3 for its 32 KiB PRG selector and bits 0–2 for its 8 KiB CHR selector,
retaining header mirroring. Mapper 113 uses bits 3–5 for PRG, bits 0–2 plus bit 6
for CHR, and bit 7 for vertical (set) or horizontal (clear) mirroring. Writes
are decoded only when `(address & 0xE100) === 0x4100`, including the aliases in
`$4100–$5FFF`. The distinction is also documented in
[Mesen's NINA implementation](https://github.com/SourMesen/Mesen2/blob/master/Core/NES/Mappers/Unlicensed/Nina03_06.h).
Previously TypeScript incorrectly applied mapper 113's extra selector bits to
mapper 79. The fix also masks these bits when reading older mapper-79 snapshots;
section size is unchanged. Tests cover every register byte, aliases, ignored
addresses, PRG mirroring, CHR RAM, mapper-controlled nametables and rendered pixels
in both builds. Reset selects bank zero; mapper 113 initializes vertical mirroring.

WASM also supports mapper 87's swapped CHR selector bits, mapper 140's combined
PRG/CHR selector at `$6000–$7FFF`, and mapper 177/241's 32 KiB PRG selectors at
`$8000–$FFFF`. Mapper 177 controls nametable mirroring; the other three retain
header mirroring. Register writes on 87/140 do not modify stored PRG RAM.
Tests execute all 256 register values through the CPU in both builds, including
address aliases, ignored writes, small-ROM wrapping, CHR RAM, reset and rendered
pixels. Reset returns selectors to zero and retains RAM; mapper 177 returns to
vertical mirroring. TypeScript mappers 79, 113, 140, 177 and 241 now also mirror
16 KiB PRG images across both CPU windows instead of reading past the ROM.
Board-specific bus conflicts and extended variants remain outside this coverage.

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

Taken branches now perform their discarded opcode fetch, and page-crossing
branches also read the provisional address using the old page and target low
byte. These accesses reach the CPU bus so mapped-device read side effects occur;
untaken branches only fetch their operand. Tests verify the read order for all
eight branch opcodes, forward/backward crossings and 16-bit wrap, with a real
PPUSTATUS side-effect check and WASM cycle/PC regression coverage. Devices still
advance after each instruction, so this does not establish cycle-exact bus timing.

Absolute-X, absolute-Y and indirect-Y stores and read-modify-write instructions
also perform the mandatory provisional-address read, even without a page crossing.
The address combines the original high byte with the indexed low byte. Their
cycle counts remain fixed; indexed read instructions retain their conditional
page-cross penalty. Tests check access order for all implemented instructions
using these write modes, including 16-bit wrap, and verify PPUSTATUS/APU status
side effects through CPU-driven programs in both builds.

Zero-page X/Y indexing and indexed-indirect `(zp,X)` now read the original
zero-page address before adding the index. The discarded value is not used as
data or as a pointer byte. A shared helper covers reads, writes, read-modify-write
instructions and indexed NOPs without changing their cycle counts. Bus-trace tests
cover every implemented opcode using these modes, zero indices, zero-page wrap
and pointer-high-byte wrap at `$FF`.

Stack instructions now include discarded instruction/stack reads. JSR fetches
the target high byte after pushing the return address, so executing JSR from
overlapping stack memory sees the written value. RTS reads the saved return
address before incrementing it; BRK fetches its padding byte; accepted IRQ/NMI
entries perform two discarded PC reads without advancing PC. Tests check access
order, stack/address wrap and status flags, including JSR stack overlap in WASM.
The system still advances devices at instruction boundaries, so interrupt polling
and bus-cycle alignment remain approximate.

Two-cycle implied and accumulator instructions also perform the discarded read
at the next PC before changing registers or flags, without advancing PC again.
This includes the one-byte unofficial NOPs. Tests check all 28 implemented opcodes,
PC wrap and discarded-data independence; a CPU program executing through the PPU
I/O latch verifies the PPUSTATUS side effect in TypeScript and WASM.

The shared CPU also implements ALR (`$4B`), ARR (`$6B`) and AXS (`$CB`) immediate
instructions, in addition to ANC (`$0B/$2B`) and the SBC alias (`$EB`). They consume
the operand and take two cycles. ARR sets carry from result bit 6 and overflow
from bits 6 XOR 5; AXS subtracts the operand from A AND X without an incoming
borrow, stores X, and retains A and overflow. As on the NES CPU, setting the
decimal flag does not enable decimal arithmetic. Tests exhaust operand pairs and
carry/decimal inputs in TypeScript and WASM, check AXS with varying A/X, and
include the SBC alias in the exhaustive arithmetic checks. Unstable undocumented
instructions and CPU jam behavior remain outside this coverage.

Synthetic ROMs compare complete frames between the two builds and assert known
background/sprite pixels, nametable mirroring, OAM wrapping, and NMI counts.
WASM uses the same scanline renderer as TypeScript: within-line raster effects,
exact sprite evaluation, and per-bus-cycle PPU timing remain incomplete. Frame views
use packed `0xAARRGGBB` pixels; they are not RGBA byte views for `ImageData`.
Each visible line is drawn at dot 256 using the current scroll, nametables,
pattern banks, palette, mask and OAM. Later register writes affect subsequent
lines and leave completed lines intact, allowing vertical splits and mapper IRQ
bank changes within a frame. The visible image is complete before VBlank begins.
Sprite-zero hit and overflow are set during the relevant line's rendering and
cleared at pre-render dot 1. This is still a line-level approximation: writes
within a line apply to that whole line, sprite-hit timing is at dot 256, and the
PPU does not yet implement the hardware's per-dot fetch/scroll pipeline.
Tests cover mid-frame palette, scroll, mask and CHR changes, partial-frame
snapshot replay, status timing and CPU-driven split-frame parity in WASM.
The frame view updates progressively as the PPU advances; hosts should display it
after their frame step. Snapshot size is unchanged; completed rows are saved
alongside the current PPU position. Palette and sprite scratch buffers are rebuilt
for each line, so they do not need separate serialization.

The NTSC PPU skips the final pre-render dot on odd frames when either background
or sprite rendering is enabled at the skip boundary (dot 339). Frame lengths
therefore alternate between 89,342 and 89,341 PPU clocks during rendering; with
both layers disabled they remain 89,342 clocks. Parity advances even while
rendering is disabled, and reset starts on an even frame. Tests cover mask changes
at the boundary, single-dot versus batched advancement, snapshots and the 200th
VBlank deadline in both builds. PPU snapshots append a parity byte after the I/O
latch; previous PPU and full-system snapshots lacking that byte are rejected.
`runFrame(cycles)` still advances the requested CPU budget rather than waiting
for a PPU frame boundary.

PPUMASK grayscale masks palette codes with `$30` for rendering and palette-port
reads, preserving the stored colors for later color output. Tests cover all 64
palette codes, background/sprite output, and WASM parity. Color emphasis and
analog video output remain approximations.

Both builds now retain a PPU I/O bus latch. Writes to every PPU register, including
the read-only status port and register mirrors, refresh it. Reads of write-only
ports return the retained value; PPUSTATUS combines its status flags with the
latched low five bits, then clears VBlank as before. OAMDATA and buffered PPUDATA
reads refresh the latch. Palette PPUDATA reads drive only the low six bits (with
grayscale applied), preserving the latch's high two bits and refreshing the read
buffer from the underlying nametable. Rendering does not update this CPU-facing
latch. Analog decay and DMA bus details remain unmodeled; reset initializes it
to zero. CPU-driven tests cover every written byte, mirrored ports, read-buffer
interactions and status acknowledgement in both builds. TypeScript PPU snapshots
append one latch byte; older PPU and full-system snapshots without it are rejected.

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

`WasmCore.from()` also accepts a precompiled `WebAssembly.Module`. Browsers can
pass the result of `WebAssembly.compileStreaming()` and reuse it for multiple
cores without recompiling the binary. The module must still export the complete
lib-jsnes ABI; invalid modules fail before a core is created.

`WasmCore.from()` validates the required exports and memory object immediately.
Passing a valid but unrelated WebAssembly module fails with a clear ABI error
before any ROM or emulator state is created. Use a binary produced by the matching
`build:wasm` script; older binaries without `romAllocate` are intentionally
rejected.
The validation covers every public typed-wrapper operation, including controller,
audio, CPU diagnostics, frame, CHR and battery-RAM exports, so a partially
compatible module fails at construction rather than during a later call.

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
periods, mixed PCM, and DMA/NMI/IRQ timing between builds. The shared APU uses nonlinear mixing; analog filters and exact frame-edge timing remain incomplete.


## Publishing

From a clean checkout, run `npm ci`, `npm test`, and `npm run build:wasm`. Inspect the package with `npm pack --dry-run`, then run `npm version <major|minor|patch>` to create the release commit and tag. Authenticate with `npm login` (or configure a publish token), verify the target with `npm whoami`, and publish with `npm publish --access public`. Push the commit and tag with `git push origin main --follow-tags`. A published version cannot be replaced, so verify the version and package contents before publishing.
