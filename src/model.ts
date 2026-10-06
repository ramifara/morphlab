import { decodeImageMask, IMAGE_WIDTH, IMAGE_HEIGHT } from './seed-image';

export interface Parameters { feed: number; kill: number; diffusionA: number; diffusionB: number }
export interface Brush { x: number; y: number; radius: number; mode: number; amount: number }
export const seedModes = ['empty', 'scatter', 'center', 'spot', 'ring', 'line', 'grid', 'image'] as const;
export type SeedMode = typeof seedModes[number];
export interface SeedOptions { count: number; radius: number; amount: number; x: number; y: number; imageMask?: string; imageScale: number; spread?: number }
export interface StartSettings extends SeedOptions { mode: SeedMode; grown: boolean; paused: boolean }
export const seedCount = (mode: SeedMode) => mode === 'scatter' ? 390 : mode === 'center' ? 7 : mode === 'spot' ? 1 : mode === 'grid' ? 64 : 48;
export const defaultStart = (mode: SeedMode = 'scatter'): StartSettings => ({ mode, count: seedCount(mode), radius: 7, amount: .25, x: .5, y: .5, imageScale: .75, grown: true, paused: false });
export interface Palette { name: string; background: string; foreground: string }
export interface View { x: number; y: number }
export interface Look { background?: string; foreground?: string; threshold?: number; speed?: number; zoom?: number }
export interface Preset { name: string; subtitle: string; feed: number; kill: number; seed: 'scatter' | 'center'; look?: Look; art?: string }
export const presets: Preset[] = [
  { name: 'Coral', subtitle: 'Organic & branching', feed: .0545, kill: .062, seed: 'scatter' },
  { name: 'Fingerprint', subtitle: 'A little human', feed: .037, kill: .060, seed: 'scatter' },
  { name: 'Mitosis', subtitle: 'Divide. Repeat.', feed: .0367, kill: .0649, seed: 'scatter' },
  { name: 'Spots', subtitle: 'Wild by nature', feed: .03, kill: .062, seed: 'scatter' },
  { name: 'Worms', subtitle: 'Beautifully restless', feed: .062, kill: .0609, seed: 'scatter' },
  { name: 'Bloom', subtitle: 'Start something small', feed: .025, kill: .055, seed: 'center' },
  { name: 'Pulse', subtitle: 'Alive. Loops forever.', feed: .0329, kill: .0556, seed: 'scatter', look: { threshold: .3, speed: 24, zoom: .49 }, art: '/presets/pulse.png' },
];
export const palettes: Palette[] = [
  { name: 'Ivory', background: '#20221d', foreground: '#e3e5cc' },
  { name: 'Acid', background: '#182019', foreground: '#d4ef82' },
  { name: 'Cobalt', background: '#1226a6', foreground: '#dbedff' },
  { name: 'Ember', background: '#29191a', foreground: '#ff936d' },
  { name: 'Orchid', background: '#302137', foreground: '#e6b8e4' },
  { name: 'Ink', background: '#efeee7', foreground: '#252722' },
];
export const idleBrush: Brush = { x: -1000, y: -1000, radius: 10, mode: 0, amount: .25 };
export function rgb(hex: string): number[] {
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
}
export function makeSeed(width: number, height: number, seed = 42, mode: SeedMode = 'scatter', options: Partial<SeedOptions> = {}): Float32Array {
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const data = new Float32Array(width * height * 2);
  for (let i = 0; i < data.length; i += 2) data[i] = 1;
  if (mode === 'empty') return data;
  if (mode === 'image') {
    const mask = decodeImageMask(options.imageMask);
    if (!mask) return data;
    const scale = options.imageScale ?? .75, w = width * scale, h = height * scale;
    const left = (options.x ?? .5) * width - w / 2, top = (options.y ?? .5) * height - h / 2;
    for (let y = Math.ceil(top); y < top + h; y++) for (let x = Math.ceil(left); x < left + w; x++) {
      const pixel = Math.floor((y - top) / h * IMAGE_HEIGHT) * IMAGE_WIDTH + Math.floor((x - left) / w * IMAGE_WIDTH);
      if (!(mask[pixel >> 3] & (1 << (pixel & 7)))) continue;
      const i = (((y % height + height) % height) * width + ((x % width + width) % width)) * 2;
      data[i] = .5 + random() * .02; data[i + 1] = Math.min(1, (options.amount ?? .25) + random() * .02);
    }
    return data;
  }
  const count = mode === 'spot' ? 1 : Math.max(1, Math.min(1000, Math.round(options.count ?? (mode === 'scatter' ? width * height / 420 : seedCount(mode)))));
  const anchorX = (options.x ?? .5) * width, anchorY = (options.y ?? .5) * height;
  const columns = Math.ceil(Math.sqrt(count * width / height)), rows = Math.ceil(count / columns);
  for (let j = 0; j < count; j++) {
    let cx: number, cy: number;
    if (mode === 'scatter') { cx = random() * width; cy = random() * height; }
    else if (mode === 'center') { cx = anchorX + (random() - .5) * (options.spread ?? 26); cy = anchorY + (random() - .5) * (options.spread ?? 26); }
    else if (mode === 'ring') { const angle = j / count * Math.PI * 2; const r = Math.min(width, height) * .22; cx = anchorX + Math.cos(angle) * r; cy = anchorY + Math.sin(angle) * r; }
    else if (mode === 'line') { cx = anchorX + (count === 1 ? 0 : j / (count - 1) - .5) * width * .6; cy = anchorY; }
    else if (mode === 'grid') { cx = ((j % columns) + .5) / columns * width; cy = (Math.floor(j / columns) + .5) / rows * height; }
    else { cx = anchorX; cy = anchorY; }
    const maxRadius = options.radius ?? 7;
    const radius = mode === 'scatter' || mode === 'center' ? Math.min(2, maxRadius) + random() * Math.max(0, maxRadius - 2) : maxRadius;
    for (let y = Math.floor(cy - radius); y <= cy + radius; y++) {
      for (let x = Math.floor(cx - radius); x <= cx + radius; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 > radius ** 2) continue;
        const i = ((((y % height) + height) % height) * width + ((x % width + width) % width)) * 2;
        data[i] = .5 + random() * .02;
        data[i + 1] = Math.min(1, (options.amount ?? .25) + random() * .02);
      }
    }
  }
  return data;
}

/** Add chemical only where the seed mask has B, preserving the rest of the field. */
export function addSeeds(field: Float32Array, seeds: Float32Array): Float32Array {
  if (field.length !== seeds.length) throw new Error('Seed and field dimensions must match.');
  const result = field.slice();
  for (let i = 0; i < result.length; i += 2) if (seeds[i + 1] > 0) {
    result[i] = Math.min(result[i], seeds[i]);
    result[i + 1] = Math.min(1, result[i + 1] + seeds[i + 1]);
  }
  return result;
}
