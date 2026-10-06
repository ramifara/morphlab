export const IMAGE_WIDTH = 128, IMAGE_HEIGHT = 80;
const BYTE_COUNT = IMAGE_WIDTH * IMAGE_HEIGHT / 8;

/** Store a small binary silhouette so image starts also fit in saves and links. */
export function imageMask(pixels: Uint8ClampedArray, cutoff: number, light: boolean): string {
  const bytes = new Uint8Array(BYTE_COUNT);
  for (let i = 0; i < IMAGE_WIDTH * IMAGE_HEIGHT; i++) {
    const offset = i * 4;
    const luminance = (pixels[offset] * .2126 + pixels[offset + 1] * .7152 + pixels[offset + 2] * .0722) / 255;
    if (pixels[offset + 3] >= 128 && (light ? luminance >= cutoff : luminance <= cutoff)) bytes[i >> 3] |= 1 << (i & 7);
  }
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeImageMask(mask?: string): Uint8Array | null {
  if (!mask || ![Math.ceil(BYTE_COUNT * 4 / 3), Math.ceil(BYTE_COUNT / 3) * 4].includes(mask.length) || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(mask)) return null;
  try { const raw = atob(mask.replace(/-/g, '+').replace(/_/g, '/')); return raw.length === BYTE_COUNT ? Uint8Array.from(raw, char => char.charCodeAt(0)) : null; }
  catch { return null; }
}
