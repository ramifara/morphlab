import { describe, expect, it } from 'vitest';
import { gridSize, parseResolution, resizeField } from './resolution';

describe('simulation resolution', () => {
  it('accepts supported URL and saved values and defaults invalid values to 1×', () => {
    for (const value of [undefined, null, '', 'NaN', 0, 1.5, 9, Infinity]) expect(parseResolution(value)).toBe(1);
    expect(parseResolution('3')).toBe(3);
    expect(parseResolution(4)).toBe(4);
    expect(gridSize(1)).toEqual({ width: 512, height: 320 });
    expect(gridSize(2)).toEqual({ width: 1024, height: 640 });
    expect(gridSize(3)).toEqual({ width: 1536, height: 960 });
    expect(gridSize(4)).toEqual({ width: 2048, height: 1280 });
    for (const [multiplier, width, height] of [
      [5, 2560, 1600], [6, 3072, 1920], [7, 3584, 2240], [8, 4096, 2560],
    ]) {
      expect(parseResolution(String(multiplier))).toBe(multiplier);
      expect(parseResolution(multiplier)).toBe(multiplier);
      expect(gridSize(parseResolution(multiplier))).toEqual({ width, height });
    }
  });

  it('keeps exact float values when only the compute engine changes', () => {
    const field = new Float32Array([1, 0, .51234567, .25123456]);
    expect(resizeField(field, 2, 1, 2, 1)).toBe(field);
  });

  it('interpolates both chemicals across the wrapping seam', () => {
    const field = new Float32Array([1, 0, 0, 1]);
    const resized = resizeField(field, 2, 1, 4, 2);
    expect(resized).toEqual(new Float32Array([
      .75, .25, .75, .25, .25, .75, .25, .75,
      .75, .25, .75, .25, .25, .75, .25, .75,
    ]));
    // Transposing the field exercises the vertical seam too.
    expect(resizeField(field, 1, 2, 2, 4)).toEqual(new Float32Array([
      .75, .25, .75, .25, .75, .25, .75, .25,
      .25, .75, .25, .75, .25, .75, .25, .75,
    ]));
  });

  it('keeps a uniform equilibrium unchanged when enlarging or reducing the grid', () => {
    const field = new Float32Array(4 * 4 * 2);
    for (let i = 0; i < field.length; i += 2) { field[i] = .75; field[i + 1] = .25; }
    for (const size of [2, 8, 12, 16, 20, 24, 28, 32]) {
      const resized = resizeField(field, 4, 4, size, size);
      expect(resized).toHaveLength(size * size * 2);
      for (let i = 0; i < resized.length; i += 2) {
        expect(resized[i]).toBe(.75); expect(resized[i + 1]).toBe(.25);
      }
    }
  });
});
