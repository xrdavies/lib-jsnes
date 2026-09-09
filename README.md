# lib-jsnes

A new TypeScript NES emulator core for browsers and Node.js. The package ships an ESM entry point for modern bundlers and Node.js. The implementation is independent from the C/C++ reference project while following the same NES hardware contracts.

## Development

```sh
npm install
npm test
npm run build:wasm
```

`npm test` builds TypeScript and WASM and runs the built-in Node test suite. `npm run build:wasm` compiles the AssemblyScript browser ABI to `dist-wasm/lib-jsnes.wasm`; the generated binary is intentionally ignored. The WASM ABI accepts a ROM through `romWrite`/`loadRom`, resets from its vector, executes the shared 6502 core through `step`, and exposes the frame buffer pointer. Both cores are in development. WASM executes the shared CPU and PPU, including background/sprite rendering, OAM DMA, and VBlank NMI. WASM also supports both standard controllers. WASM exposes the shared pulse/triangle/noise/DMC APU as mono PCM, including frame and DMC IRQs. Both builds support the same 15 mapper IDs listed below. Each WASM build uses an isolated temporary directory and atomically replaces the output only after successful compilation.

Concurrent WASM builds do not share generated sources or wait on a directory lock.
A failed build preserves the previous binary. If a process is forcibly terminated,
its ignored `.wasm-build-*` directory may remain, but it cannot block later builds
or enter the npm package. Tests exercise concurrent builds, stale directories,
compiler failure, retry, and byte-identical output from independent staging paths.
When builds target the same output, the last successful completion wins; run the
optimized build after debug experiments before packaging.

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
After timing, the page displays synthetic frames from both cores and verifies a
Canvas `ImageData` round trip. It also converts signed PCM to a mono Web Audio
buffer, renders it through `OfflineAudioContext` and checks the resulting samples.
These browser output checks play no sound and are excluded from timing. Results
include the number of checked bytes/samples and maximum audio error. They verify
format integration, not real-time audio scheduling or device playback latency.

For a minimal game screen, open `examples/browser.html` from the same server and
choose a local `.nes` file. It loads the ESM entry point, lets you select the
WASM core (default) or TypeScript fallback, renders `frameRgba()` into a 256×240
Canvas, and schedules frames at the NTSC rate. It cancels the previous animation
when a new ROM is selected, pauses while the tab is hidden, and drains audio while
muted. Click **Enable audio** to create a Web Audio context after the browser's
user-gesture requirement is satisfied. The example schedules each drained mono
PCM buffer with `AudioBufferSourceNode`; it does not persist an audio device or
implement latency recovery. Arrow keys, Z/X, Enter and Shift control player 1.
Losing window focus releases all keys.
Leaving the page cancels the loop and suspends Web Audio.
It has no gamepad policy; applications should wire `setController()` and schedule
`audioSamples()` according to their own input and Web Audio pipeline.

The benchmark has changed as the renderer and runtime have evolved. Run
`node scripts/benchmark.mjs` on the current checkout for reproducible numbers;
it reports exact binary size and per-round medians instead of embedding
hardware-specific measurements in this document.

The PPU skips idle dots between the events implemented by its current timing
model. CPU accesses now divide each cycle into two PPU dots before the access
and one after it, so older instruction-at-once benchmark numbers are not comparable.
Boundary tests compare batch advances against individual dots, including VBlank,
NMI, scanline counts and multiple frame wraps. This optimization preserves the
event ordering; the renderer now completes individual scanlines as described below.

Profiling also identified repeated per-pixel color conversion and per-cycle APU
frame-sequencer dispatch. The renderer now builds its 32 packed colors once per
scanline, and the APU dispatches only at its next sequencer event while continuing
to clock oscillators every CPU cycle. Both derived caches are rebuilt after their
inputs change or snapshots are restored. Tests cover palette/mask changes, reset
and restoration around each sequencer boundary.

The current build uses AssemblyScript's `minimal` runtime, with explicit garbage
collection after roughly 29,780 emulated CPU cycles, after audio drains and after
reset. Collection runs at instruction/DMA boundaries, after device execution
returns and when all live core objects
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
// runFrame() completes the current PPU frame; runFrame(cycles) uses an explicit CPU budget
const rgba = nes.frameRgba(); // stable RGBA bytes for ImageData
const pcm = nes.audioSamples(); // signed 16-bit PCM
const sampleRate = nes.apu.sampleRate; // 44.1 kHz
// FRAME_WIDTH, FRAME_HEIGHT, and NTSC_FRAME_RATE are exported for the host render loop
```

Controllers use `nes.setController(1, Button.A | Button.Start)` with the exported `Button` constants. `saveState()` and `loadState()` preserve CPU, mapper, PPU, audio, controller, and RAM state. Use `saveBatteryRam()` and `loadBatteryRam()` to persist cartridge battery RAM in browser storage or Node.

CPU reads and writes retain the external data-bus byte in both cores. Unmapped
reads and disabled MMC1/MMC3 RAM return that byte. Standard NES controller ports
retain bits 5–7, so ordinary absolute reads return `$40` or `$41`; indexed dummy
reads can leave different upper bits. Read bit 0 for the serial button value.
`$4015` retains bit 5 and leaves the external bus unchanged. The PPU's I/O latch
is separate. Host `Nes.read()` and `write()` are bus operations with these side
effects; WASM diagnostic `ramRead()` inspects RAM without a bus access. Tests cover
operand/dummy reads, both controller ports, disabled RAM and OAM DMA transfers.
This models the standard NES ports; Famicom expansion devices and external CPU bus
decay are not modeled. Full `Nes` snapshots store the bus byte before the OAM DMA
section; the NMI latch is part of the CPU flags byte.

Both cores preserve A/X/Y on `reset()`, following the shared CPU reset behavior.
They reset PC from the cartridge vector, SP to `$FD`, status to `$24`, cycle count
to zero and clear JAM. A new `Nes` instance and a successful WASM `loadRom()` start
A/X/Y at zero. Previously WASM also cleared these registers on warm reset, which
could make a game restart differently between cores. Tests cover repeated resets,
JAM recovery and observing incoming registers at the reset vector. This is the
library's reset contract, not a model of every hardware power-on/reset bus cycle.

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

Node `Buffer` inputs are supported, including subviews with nonzero offsets.
`parseRom()` returns independently owned trainer/PRG/CHR arrays, so changing or
reusing the input buffer does not change a running cartridge. Full-system and
direct PPU snapshot restores copy the intended bytes rather than the Buffer's
entire backing allocation. WASM loading also copies Buffer views backed by its
own linear memory before allocating replacement ROM storage. No Node-specific
dependency is required by the browser build.
The CPU snapshot is now `Cpu6502.STATE_SIZE` (16 bytes): seven bytes for registers
and PC, an eight-byte little-endian Float64 cycle count, and a flags byte holding
JAM in bit 0 and latched NMI in bit 1. This preserves
nonnegative safe-integer counts beyond 2³², where the former four-byte encoding
wrapped after roughly 40 minutes of emulated NTSC time. Non-finite, fractional,
negative and unsafe cycle counts are rejected before restoring state. Previous
11-byte and 15-byte CPU snapshots and full `Nes` snapshots containing those layouts
are rejected. Older 16-byte CPU snapshots with only a JAM bit restore with no
pending NMI. The
full-system format removes the separate NMI byte previously stored after CPU RAM,
so previous full-system snapshots are rejected by size. Boundary tests seed long-running counts and verify continuation through
pending DMA after restore.
CHR RAM cartridges append their 8 KiB of pattern memory to the cartridge section;
CHR ROM cartridges do not append pattern memory. `cartridge.stateSize` gives
the actual section length, while `Cartridge.STATE_SIZE` is the fixed register/PRG
RAM prefix. Old CHR RAM snapshots that omitted pattern memory are rejected.
Restoring copies both RAM regions, including currently hidden CHR banks, so
subsequent frames redraw from the saved tiles. This applies to `Nes` snapshots;
the WASM wrapper does not yet expose a snapshot API.
OAM DMA now alternates one CPU-bus read and one OAMDATA write per CPU cycle,
after one or two halt/alignment cycles. Relative to this core's cycle count, an
odd-cycle `$4014` write takes 513 DMA cycles and an even-cycle write takes 514;
DMA reads complete on odd cycles and writes on even cycles. Source bytes are read
when their transfer cycle occurs; OAM fills progressively instead of changing
immediately on `$4014`. The source page, byte index, read latch, alignment count
and read/write phase are stored in a six-byte snapshot section after CPU RAM,
the CPU bus byte, followed by a three-byte DMC DMA address/phase section. Earlier full-system
snapshots lacking the new section are rejected. Tests restore every transfer
phase, check read/write parity, change source memory mid-transfer and check
CPU-visible OAM in both builds. DMA accesses use the same two-before/one-after
PPU dot ordering as CPU accesses. NMI edges are latched during DMA and survive
later PPUSTATUS acknowledgement and snapshot restoration.
Repeated host writes before stepping replace the pending page rather than queue
multiple transfers. The standalone `Ppu.dma(bytes)` utility remains an immediate
copy; CPU `$4014` writes use the shared DMA state machine.
DMC halt/dummy clocks overlap ongoing OAM cycles. A ready DMC fetch owns the next
odd read cycle; OAM retains its buffered byte or waits, and an empty even write
cycle is skipped. A fetch in the middle of an OAM transfer therefore adds two
cycles instead of four. CPU-specific aborts and internal-register bus conflicts
remain incomplete.
OAM alignment now uses the parity of the actual CPU write access, including
the extra cycle in indexed stores and the second write of RMW instructions.
The CPU bus passes this as a fourth `oddCycle` argument to `write`; custom hosts
forwarding to `Nes.write()` should preserve it. Hosts that ignore extra arguments
remain valid. Direct `Nes.write()` calls use the current CPU cycle parity by
default. Tests cover write modes, both parities, large cycle counts and DMA
snapshot continuation. Both devices now advance on each timed CPU bus access.
The APU advances one CPU clock and the PPU advances two dots before the access,
then one afterward. This applies to opcode, operand, dummy and stack accesses,
including interrupt entry. Host stepping still finishes the current instruction.
`CpuBus.read()` receives a second `cpuCycle` argument and `write()` a fifth;
these are true for timed accesses and false for reset-vector reads. Existing
hosts may ignore extra arguments; forwarding hosts must preserve them to use
`Nes` device clocks. Direct `Nes.read()`/`write()` calls remain untimed by default.
`Cpu6502.busCycles` counts accesses in the latest instruction or interrupt;
JAM and unsupported-opcode fallback clocks are supplied separately by the host.
The CPU snapshot retains the NMI latch, and the PPU section stores one
timing-flags byte before its decay counters. Earlier full-system layouts
are rejected; validation happens before any live state or queued PCM changes.
Pulse channels implement all four duty patterns, CPU/2 timer clocks, and half-frame
sweeps with channel-specific negate and target-overflow muting. Tests check output
frequency, duty ratios, sweep timing, and snapshot continuation. Audio remains
approximate: DMC arbitration, band-limited resampling and board-specific analog
characteristics remain incomplete.

The pulse CPU/2 divider runs independently of the frame sequencer. Writes to
`$4017` restart frame sequencing without shifting the pulse timer clock phase.
Reset initializes the divider; snapshot byte 78 preserves it independently of
the frame counter. Tests cover both clock parities, both frame modes and repeated
CPU-driven `$4017` writes in both builds. `$4017` writes apply the new mode and restart the sequence after three APU CPU
clocks at even phase or four at odd phase. IRQ inhibition and acknowledgement
are immediate. Five-step mode clocks quarter/half units on delayed completion,
unless a normal frame clock just occurred. Repeated writes replace the pending
reset, and snapshots preserve the pending delay. Tests cover both phases, modes,
clock collisions and restoration during the delay. CPU writes now reach the
APU during their actual bus cycle.

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
system cores request DMA rather than fetching immediately. The CPU can be halted
only on a read; the transfer performs halt, dummy, optional alignment and sample
read cycles. Standalone transfers take three or four cycles. Operand and dummy
reads can be stalled inside an instruction, and the CPU retains correct write
parity afterward. The final fetch uses the current cartridge mapping and only
then updates the buffer, address, remaining length and completion IRQ.
Enabling a sample schedules its initial request after two or three clocks;
buffer reloads request immediately when the output unit consumes the byte.
The default divider accounts for the seven reset cycles excluded from the host
counter. DMA repeats the held CPU read; standard NES controller ports are clocked
only on the first held read. Revision-specific abort/duplication and bus-conflict
quirks remain unimplemented. The output feeds the shared nonlinear mixer and
three-stage filter chain.

The mixer uses generated transfer-curve tables: `95.52 / (8128 / p + 100)`
for the sum of the two pulse DACs, and `163.67 / (24329 / tnd + 100)` for
`tnd = 3 * triangle + 2 * noise + dmc`, with zero input mapped to zero.
This weighted TND lookup is an approximation of the analog circuit, following
the reference core's mixing model. Each table is scaled by 32767 and truncated
before summing, keeping TypeScript and WASM PCM identical. Tests cover all 31
pulse sums and 203 weighted TND inputs, compression and DMC-dependent gain.
The old linear gains and fixed negative bias are removed. The unipolar mix passes through one-pole 90 Hz and 440 Hz high-pass stages, then
a 14 kHz low-pass stage before signed Int16 PCM conversion. Coefficients use the
bilinear transform with `c = sampleRate / (PI * cutoff)`: high-pass feed-forward
gains are `c / (c + 1)` and its negation; low-pass gains are both `1 / (c + 1)`.
Each stage feeds back `(c - 1) / (c + 1)` times its previous output. History keeps
Float64 precision, and only the final output is rounded and saturated to Int16.
Draining audio does not reset this history. This follows the reference core's
three-stage approximation rather than a transistor-level model. Tests check DC
step/release behavior, gain against analytic transfer functions from 20 Hz to
20 kHz, saturation, snapshot continuation and JS/WASM PCM parity.

`new Apu()` remains valid for standalone synthesis, including direct `$4011` DAC
writes. For DMC sample playback, supply `new Apu({ readDmc(address) { ... } })`;
the host may return a byte immediately, or return `256` and later supply the byte
through `apu.completeDmc(value)`. Deferred requests are not repeated while pending.
`Nes` and `WasmCore` connect and clock this bus automatically. Reading `$4015` clears only the frame IRQ;
writing `$4015` or disabling IRQ in `$4010` acknowledges DMC IRQ. Stopping the
reader leaves buffered output and the current DAC level intact.

The APU snapshot is now 131 bytes and includes the DMC reader, prefetch byte,
shift register, timer, DAC, IRQ, independent pulse-clock phase and filter history.
The three previous-input/output pairs are little-endian Float64 values at
offsets 79/87, 95/103 and 111/119. Bytes 127–129 store the pending frame-write delay, pending mode and clock
suppression state. Byte 130 stores the DMC start delay; bit 2 of byte 67 records
a pending fetch. The three-byte system DMA section stores the requested address
and halt/dummy/read phase, replacing the former eight-byte stall count. Earlier
APU/system snapshots are rejected; inconsistent pending-request sections are
rejected before any live state changes.
DMC tests cover all rates, maximum length, mapper wrap, output limits, CPU IRQs,
continued output after stopping, and snapshot replay in TypeScript, with PCM and
CPU parity checks in WASM.

The CPU advances the APU on each bus cycle, including interrupt entry, and during
DMA stalls.
In four-step NTSC mode, the frame IRQ latch is asserted on sequence cycles
29,828, 29,829 and 29,830. Reading `$4015` clears the current latch, but the next
terminal clock can assert it again. IRQ inhibition suppresses all three clocks;
five-step mode generates no frame IRQ. Tests cover each terminal clock, snapshot
restoration around the window, and CPU-driven status reads in both builds.
The APU snapshot layout is unchanged from the current 131-byte format. Status reads occur on their bus cycle,
so reading during the terminal window can observe a subsequent IRQ reassertion.

`WasmCore.step(cycles)` and `runFrame(cycles)` accept integer budgets from 1 to
2,147,483,647 per call. Larger values are rejected before entering WASM, preventing
the signed 32-bit ABI from silently truncating them. Split longer runs into
multiple calls; the cumulative cycle count remains a JavaScript number rather
than a 32-bit counter. Raw callers of `exports.step` must enforce this bound
before crossing the ABI, where the original JavaScript value is no longer available.
`Nes.step()` applies the same cumulative safe-integer guard: a budget that would
make its CPU cycle counter exceed `Number.MAX_SAFE_INTEGER` is rejected before
any CPU, PPU, APU, DMA or audio state changes.
The guard reserves 22 additional cycles: up to seven for the final instruction's
budget overshoot, eight for initial/refill DMC fetches and seven for a following NMI or IRQ entry. The raw WASM step
function checks the same cumulative limit. Tests exercise an eight-cycle SLO
with two intervening DMC fetches and NMI or IRQ, verifying rejection without partial changes and exact
execution at the last permitted starting count.

## Cartridge support

`parseRom()` now reports `consoleType` (`nes`, `vs`, `playchoice`, or `extended`)
from the header's console flags. Both system cores accept only standard NES/Famicom
hardware; VS System, PlayChoice and extended-console images are rejected instead
of silently running with incorrect PPU/input hardware. Parsing still exposes their
layout for inspection. Reserved format markers (header byte 7 bits 2–3 equal to
4 or 12) are rejected consistently. Programmatically constructed legacy `RomImage`
objects may omit `consoleType`, in which case `Cartridge` assumes standard NES.


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
Unmapped expansion reads retain CPU open-bus data.
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
Disabled RAM reads retain CPU open-bus data. Reset
deterministically enables writable RAM without discarding its contents; this is
an emulator initialization choice, not a guarantee about hardware power-on state.
The TypeScript cartridge snapshot packs RAM-disable/write-protect into bits 1/2
of byte 25 alongside IRQ pending in bit 0. A12 edge filtering and revision-specific
IRQ behavior remain incomplete.

WASM MMC1 supports serial register writes, all four PRG modes, aligned 8 KiB and
split 4 KiB CHR banks, four mirroring modes, and PRG RAM disable. Tests execute
register writes through the CPU and compare mapped bytes and rendered frames.
Extended MMC1 boards (over 256 KiB PRG or 128 KiB CHR) are rejected by both
cores. Both cores suppress the second consecutive write of CPU read-modify-write
instructions to MMC1, including when the first write completes the serial latch
or the second carries the reset bit. The CPU bus supplies a third `consecutive`
boolean argument to `write`; two-argument host implementations remain valid and
may ignore it. Custom hosts forwarding writes to `Cartridge.writeCpu()` should
forward this marker too (direct calls default to false). Other mappers and devices
still receive both writes. Tests exercise all absolute RMW instructions, following
serial transfers and snapshot continuation. Arbitrary external bus schedules and
board variants remain outside this model.

AxROM and GxROM tests cover every bank-register value, both PRG halves, the full CHR window,
smaller ROM mirroring, CHR RAM, reset, and rendered pixels. CNROM and GxROM reset
both PRG and CHR selectors. AxROM reset selects PRG bank zero and the lower
single-screen nametable while retaining CHR RAM and nametable contents.
Bus conflicts and board-specific variants remain
outside the current WASM mapper model.

WASM builds compile the execution methods from `src/cpu.ts`, `src/ppu.ts`, `src/apu.ts`, `src/controller.ts`, and `src/dma.ts`, using the installed
TypeScript compiler to supply AssemblyScript integer annotations. The generated
source is temporary and is not shipped. There is no separately maintained WASM
opcode switch or renderer. Tests compare all 151 official opcodes and the 52 stable LAX, SAX,
SLO, RLA, SRE, RRA, DCP, and ISC encodings against the TypeScript CPU
(registers, RAM, and cycles) and independently check every ADC/SBC operand pair.
These checks establish CPU parity, not complete hardware compatibility; board
conflicts and unstable undocumented opcodes remain incomplete.
`core.exports.unknownOpcodeCount()` reports encounters with unimplemented opcodes.

Taken branches now perform their discarded opcode fetch, and page-crossing
branches also read the provisional address using the old page and target low
byte. These accesses reach the CPU bus so mapped-device read side effects occur;
untaken branches only fetch their operand. Tests verify the read order for all
eight branch opcodes, forward/backward crossings and 16-bit wrap, with a real
PPUSTATUS side-effect check and WASM cycle/PC regression coverage. Each discarded
read advances device clocks and can observe a different register state.

A taken branch that stays on the same page uses the interrupt sample from one
cycle earlier than an ordinary instruction. A late IRQ or NMI therefore waits
until the instruction at the branch target completes. Untaken and page-crossing
branches use the normal poll. `Cpu6502.interruptPollEarly` exposes that selection
to custom hosts; the system keeps the two recent samples. IRQ must also remain
asserted at the normal poll, so clearing the line cannot revive a stale request.
Tests cover every
branch condition, compare IRQ timing with a three-cycle JMP, and restore a
snapshot while an NMI is waiting after a branch. Snapshot layout is unchanged.

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
Devices advance during these accesses as they do for ordinary instructions.
BRK and IRQ select their vector after pushing PC, before pushing status. A latched
NMI at that point takes over the vector while preserving the original stack
semantics, including BRK's B bit. Later NMI edges remain pending until the first
handler instruction has executed. The CPU owns `nmiPending`; custom clocking
hosts can set it when sampling an edge. `interruptEntry` marks a completed entry;
custom hosts must skip ordinary post-instruction dispatch for that step to avoid
entering NMI immediately after BRK. Tests cover every entry cycle, vector reads,
stack bytes and snapshot continuation with a late NMI.

System IRQ polling now uses the I flag from before CLI, SEI or PLP, so CLI/PLP
unmasking takes effect after the following instruction and SEI/PLP cannot suppress
an IRQ polled during their own execution. RTI uses the flags it has restored.
The status pushed by interrupt entry still reflects the completed instruction.
Custom CPU hosts can use `irqAfterInstruction()` to poll a pending line immediately
after `step()`; `irq()` retains its direct, current-I-bit behavior. The system
finishes this poll before returning to its host, and the next instruction replaces
the temporary sampled mask, so snapshot layout is unchanged. Tests cover both
I-bit values, CLI snapshot continuation and an APU IRQ arising during SEI/PLP in
TypeScript and WASM, including IRQ assertion before versus after the final poll.
NMI edges are latched separately from the PPU output and polled on the following
cycle. Enabling NMI on a final write cycle therefore waits for the next instruction.
A status read or disabling NMI can cancel an unsampled PPU edge, while a CPU-latched
edge survives. Reading PPUSTATUS at scanline 241 dot 0 suppresses that frame's
VBlank flag and NMI; pre-render clearing also removes unsampled output.

Two-cycle implied and accumulator instructions also perform the discarded read
at the next PC before changing registers or flags, without advancing PC again.
This includes the one-byte unofficial NOPs. Tests check all 28 implemented opcodes,
PC wrap and discarded-data independence; a CPU program executing through the PPU
I/O latch verifies the PPUSTATUS side effect in TypeScript and WASM.

The shared CPU also implements ALR (`$4B`), ARR (`$6B`), LAX (`$AB`) and AXS (`$CB`) immediate
instructions, in addition to ANC (`$0B/$2B`) and the SBC alias (`$EB`). They consume
the operand and take two cycles. ARR sets carry from result bit 6 and overflow
from bits 6 XOR 5; AXS subtracts the operand from A AND X without an incoming
borrow, stores X, and retains A and overflow. As on the NES CPU, setting the
decimal flag does not enable decimal arithmetic. Tests exhaust operand pairs and
carry/decimal inputs in TypeScript and WASM, check AXS with varying A/X, and
include the SBC alias in the exhaustive arithmetic checks. Immediate LAX uses
the deterministic LDA/TAX behavior: it loads A and X and updates N/Z. Analog
chip-dependent variations remain outside this model.

SHY (`$9C`, absolute-X) and SHX (`$9E`, absolute-Y) take five cycles, including
the provisional-address read, and leave registers and flags unchanged. They mask
Y or X with the unindexed address's high byte plus one. A page crossing also
replaces the write address's high byte with that masked value. Tests check both
cores, non-crossing stores, corrupted addresses and wrap at `$FFFF`. DMA changing
the mask during the dummy read still requires per-cycle CPU arbitration.

LAS (`$BB`, absolute-Y) reads memory AND SP into A, X and SP, updates N/Z and
preserves other status flags. It takes four cycles plus an indexed page-cross
cycle, including the provisional-address read. Tests exhaust all SP/memory byte
pairs in both cores and check bus order, address wrap and snapshot preservation.

KIL (`$02/$12/$22/$32/$42/$52/$62/$72/$92/$B2/$D2/$F2`) now jams the CPU,
instead of falling through to unknown-opcode handling and running later bytes.
`nes.cpu.jammed` and `core.jammed` report the condition; raw WASM hosts can use
`cpuJammed()`. Interrupts cannot release the jam, while reset or loading a running
TypeScript snapshot can. Device clocks and audio continue during system stepping.
The initial instruction takes two cycles and retains PC at the following byte;
subsequent CPU steps advance one halted cycle. The detailed repeating electrical
bus sequence during JAM is not modeled. KIL is recognized even in strict CPU mode
and does not increment unknown-opcode diagnostics. Tests cover all 12 encodings,
interrupt rejection, reset, snapshot replay and JS/WASM device-clock parity.

Synthetic ROMs compare complete frames between the two builds and assert known
background/sprite pixels, nametable mirroring, OAM wrapping, and NMI counts.
WASM uses the same scanline renderer as TypeScript: within-line raster effects,
exact sprite evaluation, and per-bus-cycle PPU timing remain incomplete. Frame views
use packed `0xAARRGGBB` pixels; they are not RGBA byte views for `ImageData`.
PPUADDR (`$2006`) uses a temporary address: its first write replaces the high
six bits without changing the active PPUDATA address, and its second write
commits the completed address. PPUCTRL updates temporary nametable bits;
PPUSCROLL updates temporary coarse/fine scroll fields. Both ports share the
write toggle cleared by reading PPUSTATUS. PPUDATA increments the active address
without overwriting the temporary one. Tests cover half-written addresses,
interleaved register writes, mirrors and snapshot replay in both builds.
PPU snapshots add two temporary-address bytes before the I/O latch and parity
bytes; older PPU/system snapshots are rejected. The renderer still uses its
scanline scroll model; timed v/t copies and the full per-dot scroll pipeline
remain unimplemented.

Each visible line is drawn at dot 256 using the current scroll, nametables,
pattern banks, palette, mask and OAM. Later register writes affect subsequent
lines and leave completed lines intact, allowing vertical splits and mapper IRQ
bank changes within a frame. The visible image is complete before VBlank begins.
Sprite-zero hit is set at dot x + 1 for the first opaque overlap, respecting
rendering masks, flips, sprite size and the x=255 exclusion. Overlap uses current
memory rather than hardware fetch buffers. Overflow is set during line rendering;
both flags clear at pre-render dot 1. Drawing is still a line-level approximation:
writes within a line apply to that whole line, and the PPU does not yet implement
the hardware's per-dot fetch/scroll pipeline.
Tests cover mid-frame palette, scroll, mask and CHR changes, partial-frame
snapshot replay, status timing and CPU-driven split-frame and sprite-hit polling
parity in WASM.
The frame view updates progressively as the PPU advances; hosts should display it
after their frame step. Snapshot size is unchanged; completed rows are saved
alongside the current PPU position. Palette and sprite scratch buffers are rebuilt
for each line, so they do not need separate serialization.

The NTSC PPU skips the final pre-render dot on odd frames when either background
or sprite rendering is enabled on entering dot 339. The rendering gate changes
one PPU dot after a PPUMASK write; writes after the sampling point cannot change
that frame's skip decision. Frame lengths
therefore alternate between 89,342 and 89,341 PPU clocks during rendering; with
both layers disabled they remain 89,342 clocks. Parity advances even while
rendering is disabled, and reset starts on an even frame. Tests cover mask changes
at the boundary, single-dot versus batched advancement, snapshots and the 200th
VBlank deadline in both builds. PPU snapshots append a parity byte after the I/O
latch; previous PPU and full-system snapshots lacking that byte are rejected.
`runFrame()` without an argument now finishes the current PPU frame, accounting
for odd-frame skipping. From a partial frame it draws only the remaining lines;
from a frame boundary it runs the next frame. CPU instructions and interrupt entry
are not split, so a few dots of the next frame may elapse. Explicit
`runFrame(cycles)` retains budget-based stepping. `WasmCore.FRAME_CYCLES` remains
29780 for callers wanting the old nominal budget, while `NTSC_FRAME_RATE` is now
approximately 60.0988 Hz. Tests verify 200 consecutive frame boundaries, NMI
counts, partial-frame entry and snapshot continuation in both builds. Load the
wrapper and WASM binary from the same build; the wrapper now requires the native
`runFrame` export.

PPUMASK grayscale masks palette codes with `$30` for rendering and palette-port
reads, preserving the stored colors for later color output. Tests cover all 64
palette codes, background/sprite output, and WASM parity. Color emphasis and
analog video output remain approximations.

With both background and sprite rendering disabled, a VRAM address in
`$3F00–$3FFF` selects the forced-blank output color from that palette entry,
including palette mirrors and grayscale. Otherwise the backdrop remains palette
entry zero. PPUDATA address increments can change the selected color. This uses
the current scanline renderer, so changes affect subsequent line draws rather
than individual pixels. Tests cover all palette addresses, rendering gates,
snapshot continuation and known CPU-driven pixels in TypeScript and WASM.

Both builds now retain a PPU I/O bus latch. Writes to every PPU register, including
the read-only status port and register mirrors, refresh it. Reads of write-only
ports return the retained value; PPUSTATUS combines its status flags with the
latched low five bits, then clears VBlank as before. OAMDATA and buffered PPUDATA
reads refresh the latch. Palette PPUDATA reads drive only the low six bits (with
grayscale applied), preserving the latch's high two bits and refreshing the read
buffer from the underlying nametable. Rendering does not update this CPU-facing
latch. Undriven bits now decay to zero after approximately three NTSC frames,
counted in scanlines. Bits 0–4, bit 5 and bits 6–7 retain separate countdowns:
status reads refresh only bits 5–7, palette reads only bits 0–5, and ordinary
data/OAM reads and all writes refresh every bit. Reading a write-only register
does not extend retention. Reset clears the latch and countdowns. This is a
deterministic approximation; actual retention varies with chip and temperature.
The calibration constant is `IO_DECAY_SCANLINES` in `src/ppu.ts`.
CPU-driven tests cover mirrored ports, partial refresh, read-buffer interactions
and polling until decay in both builds. PPU snapshots add three little-endian
16-bit countdowns immediately before the temporary-address/latch/parity tail.
Older PPU/full-system snapshots lacking these six bytes are rejected, as are
out-of-range countdowns; failed restoration leaves live state and queued PCM intact.

An accepted PPUDATA read starts a six-PPU-dot recovery window. Reads during
that window return the current I/O latch without refilling the data buffer,
incrementing the address, refreshing the latch or extending the deadline. This
also applies to register mirrors and DMA/dummy reads. Host code calling the
untimed `Nes.read()` or `Ppu.readRegister()` directly must advance `ppu.step(6)`
between independent data-port reads; normal CPU accesses already advance clocks.
Writes still take effect during recovery. The fixed window represents one
deterministic CPU/PPU alignment; chip-dependent buffer corruption is not modeled.
PPU snapshots add one recovery-countdown byte before the timing flags. Previous
PPU/system layouts are rejected, and restoring preserves a partially elapsed window.

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

For test ROMs using blargg's `$6000` result protocol, run:

```sh
node scripts/check-test-rom.mjs /path/to/test.nes
# Optional total frame budget per core (default: 3600)
node scripts/check-test-rom.mjs /path/to/test.nes 6000
```

The runner executes JS and WASM independently and reports each ROM's status,
message, elapsed frames and reset count as JSON. It checks the `$DE/$B0/$61`
signature, honors reset requests after at least 100 ms, drains PCM and exits
nonzero for a failure or timeout. Neither matching cores nor missing result data
count as a pass. ROMs are supplied locally and are not bundled or downloaded by
the runner. Screen-only and other result protocols are not supported.

Development results using
[nes-test-roms revision 95d8f62](https://github.com/christopherpow/nes-test-roms/tree/95d8f621ae55cee0d09b91519a8989ae0e64753b)
in both cores:

| Suite | Result |
| --- | --- |
| `instr_test-v5/official_only.nes` | All 16 subtests pass |
| `instr_test-v5/all_instrs.nes` | All 16 subtests pass, including its unofficial instructions |
| `apu_test/rom_singles/` | All 8 tests pass |
| `ppu_vbl_nmi/rom_singles/` | All 10 tests pass |
| `ppu_open_bus/ppu_open_bus.nes` | Passes, including decay and partial-refresh checks |
| `cpu_interrupts_v2/rom_singles/` | All 5 tests pass |
| `cpu_dummy_reads/cpu_dummy_reads.nes` | Screen output: `Passed` |
| `sprdma_and_dmc_dma/` | Both combined-DMA timing tests pass |
| `dmc_dma_during_read4/` | Screen/serial protocol; not supported by the `$6000` runner (see below) |

The full instruction suite exposed missing immediate LAX and SHY/SHX support;
those instructions are now implemented. The PPU suite exposed instruction-at-once
clocking, NMI sampling, VBlank suppression and rendering-gate timing errors;
those checks now pass. The scanline renderer, DMA arbitration and MMC3 A12
approximation still limit compatibility. These results do not establish full
PPU or game compatibility.
The additional CPU interrupt suite passes NMI takeover of BRK/IRQ vectoring and
the OAM DMA boundary after correcting DMA bus parity. The combined DMC/OAM tests
also pass with deferred fetching, shared preparation clocks and read-cycle priority.
The older `dmc_dma_during_read4` ROMs report through the screen and serial output,
not `$6000`. A runner timeout therefore does not establish an emulation failure.
After 600 frames, `dma_2007_write`, `dma_4016_read` and `read_write_2007` print
`Passed`. `dma_2007_read` prints checksum `159A7A8F`, one of the two accepted
CPU/PPU alignments in its source. `double_2007_read` now prints the accepted
checksum `F018C287` after implementing consecutive-read recovery. These observations use the test's ASCII
nametable output, with matching final pixels, CPU state and PCM in both cores;
they are separate from the automated `$6000` result checks.

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
periods, mixed PCM, and DMA/NMI/IRQ timing between builds. The shared APU uses
nonlinear mixing and the three-stage output filter; DMA arbitration and
band-limited resampling remain incomplete.


## Publishing

From a clean checkout, run `npm ci`, `npm test`, and `npm run build:wasm`. Inspect the package with `npm pack --dry-run`, then update the version without creating an automatic commit or tag:

```sh
npm version <major|minor|patch> --no-git-tag-version
git add package.json package-lock.json
git commit -m "chore: release v<version>"
git tag -a "v<version>" -m "v<version>"
```

Authenticate with `npm login` (or configure a publish token), verify the target
with `npm whoami`, and publish with `npm publish --access public`. Push the
Conventional Commit and tag with `git push origin main --follow-tags`. A published
version cannot be replaced, so verify the version and package contents before
publishing.
