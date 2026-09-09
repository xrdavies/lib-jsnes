import { Nes, WasmCore } from '../dist/index.js';

/** Exercise actual browser presentation APIs outside the benchmark's timed region. */
export async function verifyBrowserOutput(rom, binary, canvases) {
  const js = new Nes(rom), wasm = await WasmCore.from(binary);
  js.reset(); wasm.loadRom(rom); wasm.reset();
  const results = [];
  let referencePixels, referencePcm;
  for (const [index, core] of [js, wasm].entries()) {
    for (let frame = 0; frame < 4; frame++) core.runFrame();
    const rgba = core.frameRgba(), pcm = core.audioSamples();
    const context = canvases[index].getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable');
    context.putImageData(new ImageData(rgba, 256, 240), 0, 0);
    const rendered = context.getImageData(0, 0, 256, 240).data;
    for (let i = 0; i < rendered.length; i++) {
      if (rendered[i] !== rgba[i]) throw new Error(`Canvas byte ${i} differs for core ${index}`);
      if (referencePixels && rendered[i] !== referencePixels[i]) throw new Error(`Canvas parity failed at byte ${i}`);
    }
    if (!pcm.length || !pcm.some(value => value !== 0)) throw new Error('Synthetic PCM is empty or silent');
    if (referencePcm && (pcm.length !== referencePcm.length || pcm.some((v, i) => v !== referencePcm[i]))) {
      throw new Error('Presentation PCM parity failed');
    }
    const rate = index === 0 ? js.apu.sampleRate : wasm.sampleRate;
    const audio = new OfflineAudioContext(1, pcm.length, rate);
    const buffer = audio.createBuffer(1, pcm.length, rate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;
    const source = audio.createBufferSource(); source.buffer = buffer;
    source.connect(audio.destination); source.start(0);
    const output = (await audio.startRendering()).getChannelData(0);
    let maxAudioError = 0;
    for (let i = 0; i < output.length; i++) {
      if (!Number.isFinite(output[i])) throw new Error(`Non-finite audio sample ${i}`);
      maxAudioError = Math.max(maxAudioError, Math.abs(output[i] - channel[i]));
    }
    if (maxAudioError > 0.000001) throw new Error(`Offline Web Audio changed PCM for core ${index}`);
    source.disconnect();
    results.push({ core: index === 0 ? 'typescript' : 'wasm', canvasBytes: rendered.length,
      audioSamples: output.length, sampleRate: rate, maxAudioError });
    referencePixels = rendered; referencePcm = pcm;
  }
  return results;
}
