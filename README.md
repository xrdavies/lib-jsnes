# lib-jsnes

A new TypeScript NES emulator core designed for browsers and Node.js. The public API accepts standard iNES ROM bytes and exposes deterministic frame stepping; CPU, PPU, APU, mappers, and WebAssembly bindings are being added incrementally.

## Development

```sh
npm install
npm test
npm run build:wasm
```

## WASM

`npm run build:wasm` compiles the browser ABI to `dist-wasm/lib-jsnes.wasm`. The TypeScript implementation is the reference runtime; the WASM ABI is expanded alongside it. The generated file is intentionally ignored and should be produced during packaging or CI. Call `romWrite` for each ROM byte, then `loadRom(length)`, `reset()`, and `step(cycles)`; read the frame through the exported linear memory.

## API

```ts
import { Nes } from 'lib-jsnes';
const nes = new Nes(await fetch('/game.nes').then(r => r.arrayBuffer()));
nes.reset();
const frame = nes.runFrame(); // 256x240 packed pixels
const rgba = nes.frameRgba(); // stable RGBA bytes for ImageData
const pcm = nes.audioSamples(); // signed 16-bit PCM at 44.1 kHz
```

## Publishing

Run `npm test`, update the version with `npm version`, then publish the generated package with `npm publish`. CI should publish only from tagged releases.
