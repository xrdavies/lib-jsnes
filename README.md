# lib-jsnes

A new TypeScript NES emulator core for browsers and Node.js. The implementation is independent from the C/C++ reference project while following the same NES hardware contracts.

## Development

```sh
npm install
npm test
npm run build:wasm
```

`npm test` builds TypeScript and runs the built-in Node test suite. `npm run build:wasm` compiles the AssemblyScript browser ABI to `dist-wasm/lib-jsnes.wasm`; the generated binary is intentionally ignored.

## API

```ts
import { Nes } from 'lib-jsnes';
const nes = new Nes(await fetch('/game.nes').then(r => r.arrayBuffer()));
nes.reset();
const frame = nes.runFrame(); // 256x240 packed pixels
const rgba = nes.frameRgba(); // stable RGBA bytes for ImageData
const pcm = nes.audioSamples(); // signed 16-bit PCM at 44.1 kHz
```

Controllers use `nes.setController(1, Button.A | Button.Start)` with the exported `Button` constants. `saveState()` and `loadState()` preserve CPU, mapper, PPU, audio, controller, and RAM state.

## Cartridge support

The current mapper layer supports NROM (0), MMC1 (1), UxROM (2), CNROM (3), MMC3 bank switching (4), AxROM (7), and GxROM (66). MMC3 scanline IRQ counting is available; advanced mapper variants and exact edge timing remain in progress.

## Publishing

Run `npm test` and `npm run build:wasm`, then update the version with `npm version <major|minor|patch>`. Publish the generated npm package with `npm publish`. Releases should be published from a clean, tagged commit.
