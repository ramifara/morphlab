import { describe, expect, it } from 'vitest';
import { makeSeed, defaultStart } from './model';
import { readStart, writeStart, normalizeStart } from './start';
import { imageMask, decodeImageMask, IMAGE_WIDTH, IMAGE_HEIGHT } from './seed-image';

const pixels = new Uint8ClampedArray(IMAGE_WIDTH * IMAGE_HEIGHT * 4);
// A dark opaque pixel, a light opaque pixel, and a transparent pixel.
pixels.set([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 0]);

describe('image seeds', () => {
  it('selects dark or light areas and always excludes transparency', () => {
    expect(decodeImageMask(imageMask(pixels, .5, false))![0]).toBe(1);
    expect(decodeImageMask(imageMask(pixels, .5, true))![0]).toBe(2);
  });
  it('uses compact URL-safe masks and still reads padded Base64 masks', () => {
    const compact = imageMask(pixels, .5, false);
    expect(compact).toHaveLength(1707);
    expect(compact).toMatch(/^[A-Za-z0-9_-]+$/);
    const standard = compact.replace(/-/g, '+').replace(/_/g, '/') + '=';
    expect(decodeImageMask(standard)).toEqual(decodeImageMask(compact));
  });
  it('repeats an image field and supports scale, position, and amount', () => {
    const settings = { ...defaultStart('image'), imageMask: imageMask(pixels, .5, false), imageScale: 1, amount: .6 };
    const field = makeSeed(128, 80, 42, 'image', settings);
    expect(field).toEqual(makeSeed(128, 80, 42, 'image', settings));
    expect(field[1]).toBeGreaterThan(.59); expect(field[3]).toBe(0); expect(field[5]).toBe(0);
    const moved = makeSeed(128, 80, 42, 'image', { ...settings, x: .75 });
    expect(moved[1]).toBe(0); expect(moved[32 * 2 + 1]).toBeGreaterThan(.59);
  });
  it('handles missing and malformed image masks as empty fields', () => {
    for (const mask of [undefined, '', 'not-a-mask', '!'.repeat(1708), btoa('a'.repeat(1279)).padEnd(1708, '=')]) {
      expect(decodeImageMask(mask)).toBeNull();
      expect(makeSeed(16, 10, 42, 'image', { imageMask: mask })).toEqual(makeSeed(16, 10, 42, 'empty'));
    }
  });
});

describe('start settings', () => {
  it('keeps old link defaults and rejects invalid controls', () => {
    expect(readStart(new URLSearchParams(), 'center')).toEqual(defaultStart('center'));
    expect(readStart(new URLSearchParams('start=bad&init_radius=NaN&init_count=999999&init_amount=-1&init_x=2&init_y=-1'), 'scatter')).toMatchObject({ mode: 'scatter', radius: 7, count: 1000, amount: .05, x: 1, y: 0 });
    expect(normalizeStart({ count: Infinity, imageScale: 99 })).toMatchObject({ count: 390, imageScale: 1 });
  });
  it('round-trips custom starts and image silhouettes through links', () => {
    for (const settings of [
      { ...defaultStart('ring'), count: 19, radius: 4, amount: .4, x: .08, y: .92, grown: false, paused: true },
      { ...defaultStart('image'), imageMask: imageMask(pixels, .5, false), imageScale: .6 },
      defaultStart('empty'),
    ]) {
      const query = new URLSearchParams(); writeStart(query, settings);
      expect(readStart(new URLSearchParams(query.toString()), 'scatter')).toEqual({ ...settings, imageMask: settings.mode === 'image' ? settings.imageMask : undefined });
    }
  });
});
