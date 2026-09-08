# lib-jsnes

A new TypeScript NES emulator core designed for browsers and Node.js. The public API accepts standard iNES ROM bytes and exposes deterministic frame stepping; CPU, PPU, APU, mappers, and WebAssembly bindings are being added incrementally.

## Development

```sh
npm install
npm test
```

## API

```ts
import { Nes } from 'lib-jsnes';
const nes = new Nes(await fetch('/game.nes').then(r => r.arrayBuffer()));
nes.reset();
const frame = nes.runFrame(); // 256x240 RGBA pixels as Uint32Array
```

## Publishing

Run `npm test`, update the version with `npm version`, then publish the generated package with `npm publish`. CI should publish only from tagged releases.
