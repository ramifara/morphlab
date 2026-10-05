export interface Parameters { feed: number; kill: number; diffusionA: number; diffusionB: number }
export interface Brush { x: number; y: number; radius: number; mode: number }
export interface Palette { name: string; background: string; foreground: string }
export interface View { x: number; y: number }
export interface Look { background: string; foreground: string; threshold?: number; speed?: number; zoom?: number }
export interface Preset { name: string; subtitle: string; feed: number; kill: number; seed: 'scatter' | 'center'; look?: Look }
export const presets: Preset[] = [
  { name: 'Coral', subtitle: 'Organic & branching', feed: .0545, kill: .062, seed: 'scatter' },
  { name: 'Fingerprint', subtitle: 'A little human', feed: .037, kill: .060, seed: 'scatter' },
  { name: 'Mitosis', subtitle: 'Divide. Repeat.', feed: .0367, kill: .0649, seed: 'scatter' },
  { name: 'Spots', subtitle: 'Wild by nature', feed: .03, kill: .062, seed: 'scatter' },
  { name: 'Worms', subtitle: 'Beautifully restless', feed: .062, kill: .0609, seed: 'scatter' },
  { name: 'Bloom', subtitle: 'Start something small', feed: .025, kill: .055, seed: 'center' },
  { name: 'Pulse', subtitle: 'Alive. Loops forever.', feed: .0329, kill: .0556, seed: 'scatter', look: { background: '#29191a', foreground: '#ff936d', threshold: .3, speed: 24, zoom: .49 } },
];
export const palettes: Palette[] = [
  { name: 'Ivory', background: '#20221d', foreground: '#e3e5cc' },
  { name: 'Acid', background: '#182019', foreground: '#d4ef82' },
  { name: 'Cobalt', background: '#1226a6', foreground: '#dbedff' },
  { name: 'Ember', background: '#29191a', foreground: '#ff936d' },
  { name: 'Orchid', background: '#302137', foreground: '#e6b8e4' },
  { name: 'Ink', background: '#efeee7', foreground: '#252722' },
];
export const idleBrush: Brush = { x: -1000, y: -1000, radius: 10, mode: 0 };
export function rgb(hex: string): number[] {
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
}
export function makeSeed(width: number, height: number, seed = 42, mode = 'scatter'): Float32Array {
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const data = new Float32Array(width * height * 2);
  for (let i = 0; i < data.length; i += 2) data[i] = 1;
  const count = mode === 'center' ? 7 : Math.round(width * height / 420);
  for (let j = 0; j < count; j++) {
    const cx = mode === 'center' ? width / 2 + (random() - .5) * 26 : random() * width;
    const cy = mode === 'center' ? height / 2 + (random() - .5) * 26 : random() * height;
    const radius = 2 + random() * 5;
    for (let y = Math.floor(cy - radius); y <= cy + radius; y++) {
      for (let x = Math.floor(cx - radius); x <= cx + radius; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 > radius ** 2) continue;
        const i = (((y + height) % height) * width + ((x + width) % width)) * 2;
        data[i] = .5 + random() * .02;
        data[i + 1] = .25 + random() * .02;
      }
    }
  }
  return data;
}
