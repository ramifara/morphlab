import { decodeImageMask, IMAGE_WIDTH, IMAGE_HEIGHT } from './seed-image';
import type { StartSettings } from './model';

export type VolumeShape = 'sphere' | 'box';
export const volumeResolutions = [1, 2, 3, 4] as const;
export function parseVolumeResolution(value: unknown): 1 | 2 | 3 | 4 {
  const n = Number(value); return volumeResolutions.includes(n as 1 | 2 | 3 | 4) ? n as 1 | 2 | 3 | 4 : 1;
}
export function volumeGridSize(resolution: number) {
  const n = 64 * resolution; return { width: n * 8, height: n * (n / 8) };
}
export const volumeSize = (width: number) => width / 8;
/** Eight columns of Z slices, with enough rows for the volume depth. No adjacent atlas tile is a spatial neighbor. */
export function voxelIndex(x: number, y: number, z: number, n: number) {
  return ((Math.floor(z / 8) * n + y) * n * 8 + z % 8 * n + x) * 2;
}
export function insideVolume(x: number, y: number, z: number, n: number, shape: VolumeShape) {
  return shape === 'box' || Math.hypot((x + .5) / n * 2 - 1, (y + .5) / n * 2 - 1, (z + .5) / n * 2 - 1) < .98;
}
export function makeVolumeSeed(width: number, seed: number, settings: StartSettings, shape: VolumeShape) {
  const n = volumeSize(width), data = new Float32Array(n ** 3 * 2);
  for (let i = 0; i < data.length; i += 2) data[i] = 1;
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const put = (x: number, y: number, z: number) => {
    if (x < 0 || y < 0 || z < 0 || x >= n || y >= n || z >= n || !insideVolume(x, y, z, n, shape)) return;
    const i = voxelIndex(x, y, z, n); data[i] = .5; data[i + 1] = settings.amount + random() * .02;
  };
  if (settings.mode === 'empty') return data;
  if (settings.mode === 'image') {
    const mask = decodeImageMask(settings.imageMask); if (!mask) return data;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const u = ((x / n - settings.x) / settings.imageScale + .5), v = ((y / n - settings.y) / settings.imageScale + .5);
      if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
      const pixel = Math.floor(v * IMAGE_HEIGHT) * IMAGE_WIDTH + Math.floor(u * IMAGE_WIDTH);
      if (mask[pixel >> 3] & (1 << (pixel & 7))) for (let z = Math.floor(n * 29 / 64); z < n * 35 / 64; z++) put(x, y, z);
    }
    return data;
  }
  const count = settings.mode === 'spot' ? 1 : settings.count;
  const columns = Math.ceil(Math.cbrt(count));
  for (let j = 0; j < count; j++) {
    let x = settings.x * n, y = settings.y * n, z = n / 2;
    if (settings.mode === 'scatter') { x = random() * n; y = random() * n; z = random() * n; }
    else if (settings.mode === 'center') { x += (random() - .5) * n * .15; y += (random() - .5) * n * .15; z += (random() - .5) * n * .15625; }
    else if (settings.mode === 'ring') { x += Math.cos(j / count * Math.PI * 2) * n * .25; z += Math.sin(j / count * Math.PI * 2) * n * .25; }
    else if (settings.mode === 'line') x += (count === 1 ? 0 : j / (count - 1) - .5) * n * .6;
    else if (settings.mode === 'grid') { x = (j % columns + .5) / columns * n; y = (Math.floor(j / columns) % columns + .5) / columns * n; z = (Math.floor(j / columns ** 2) + .5) / columns * n; }
    const radius = Math.max(1, settings.radius * n / 128);
    for (let iz = Math.floor(z - radius); iz <= z + radius; iz++) for (let iy = Math.floor(y - radius); iy <= y + radius; iy++) for (let ix = Math.floor(x - radius); ix <= x + radius; ix++) {
      if ((ix - x) ** 2 + (iy - y) ** 2 + (iz - z) ** 2 <= radius ** 2) put(ix, iy, iz);
    }
  }
  return data;
}

/** Resize in XYZ, not in the 2D storage atlas. Clamp at the closed volume boundary. */
export function resizeVolume(field: Float32Array, oldN: number, nextN: number) {
  if (oldN === nextN) return field;
  if (field.length !== oldN ** 3 * 2) throw new Error('Invalid source volume.');
  const result = new Float32Array(nextN ** 3 * 2);
  const lower = new Int32Array(nextN), upper = new Int32Array(nextN), weight = new Float32Array(nextN);
  for (let i = 0; i < nextN; i++) {
    const source = (i + .5) * oldN / nextN - .5, floor = Math.floor(source);
    lower[i] = Math.max(0, Math.min(oldN - 1, floor)); upper[i] = Math.max(0, Math.min(oldN - 1, floor + 1)); weight[i] = source - floor;
  }
  for (let z = 0; z < nextN; z++) for (let y = 0; y < nextN; y++) for (let x = 0; x < nextN; x++) {
    const out = voxelIndex(x, y, z, nextN), fx = weight[x], fy = weight[y], fz = weight[z];
    const a = voxelIndex(lower[x], lower[y], lower[z], oldN), b = voxelIndex(upper[x], lower[y], lower[z], oldN);
    const c = voxelIndex(lower[x], upper[y], lower[z], oldN), d = voxelIndex(upper[x], upper[y], lower[z], oldN);
    const e = voxelIndex(lower[x], lower[y], upper[z], oldN), f = voxelIndex(upper[x], lower[y], upper[z], oldN);
    const g = voxelIndex(lower[x], upper[y], upper[z], oldN), h = voxelIndex(upper[x], upper[y], upper[z], oldN);
    for (let channel = 0; channel < 2; channel++) {
      const front = (field[a+channel]*(1-fx)+field[b+channel]*fx)*(1-fy)+(field[c+channel]*(1-fx)+field[d+channel]*fx)*fy;
      const back = (field[e+channel]*(1-fx)+field[f+channel]*fx)*(1-fy)+(field[g+channel]*(1-fx)+field[h+channel]*fx)*fy;
      result[out+channel] = front*(1-fz)+back*fz;
    }
  }
  return result;
}
