import { describe, expect, it } from 'vitest';
import { makeSeed, addSeeds, defaultStart, seedModes, palettes } from './model';
import { fieldToSVG } from './export';

describe('initial chemical field', () => {
  it('is deterministic, bounded, and contains both seeded and untouched cells', () => {
    const a = makeSeed(64, 40, 42);
    expect(a).toEqual(makeSeed(64, 40, 42));
    expect(a).not.toEqual(makeSeed(64, 40, 43));
    expect(a).toHaveLength(64 * 40 * 2);
    expect(Array.from(a).every(v => Number.isFinite(v) && v >= 0 && v <= 1)).toBe(true);
    const b = Array.from(a).filter((_, i) => i % 2 === 1);
    expect(b.some(v => v === 0)).toBe(true);
    expect(b.some(v => v > .2)).toBe(true);
  });
  it('keeps bloom seeds close to the center', () => {
    const a = makeSeed(128, 80, 42, 'center');
    for (let y = 0; y < 80; y++) for (let x = 0; x < 128; x++) {
      if (Math.abs(x - 64) > 22 || Math.abs(y - 40) > 22) expect(a[(y * 128 + x) * 2 + 1]).toBe(0);
    }
  });
  it('makes an exactly empty equilibrium independent of the seed number', () => {
    const field = makeSeed(64, 40, 0, 'empty');
    expect(field).toEqual(makeSeed(64, 40, 4294967295, 'empty'));
    for (let i = 0; i < field.length; i += 2) { expect(field[i]).toBe(1); expect(field[i + 1]).toBe(0); }
  });
  it('repeats every geometric start with the same number and settings', () => {
    for (const mode of seedModes.filter(mode => mode !== 'image' && mode !== 'empty')) {
      const settings = { ...defaultStart(mode), count: 9, radius: 3 };
      const field = makeSeed(64, 40, 0, mode, settings);
      expect(field).toEqual(makeSeed(64, 40, 0, mode, settings));
      expect(field.some((v, i) => i % 2 === 1 && v > 0)).toBe(true);
      expect([...field].every(v => Number.isFinite(v) && v >= 0 && v <= 1)).toBe(true);
    }
  });
  it('supports corner positions and wraps large seeds on small fields', () => {
    const field = makeSeed(128, 80, 42, 'spot', { x: .08, y: .08, radius: 3, amount: .6 });
    expect(field[(6 * 128 + 10) * 2 + 1]).toBeGreaterThan(.59);
    expect(field[(40 * 128 + 64) * 2 + 1]).toBe(0);
    const tiny = makeSeed(4, 4, 42, 'spot', { x: 0, y: 0, radius: 30 });
    expect([...tiny].every(v => v >= 0 && v <= 1)).toBe(true);
    expect([...tiny].filter((_, i) => i % 2 === 1).every(v => v > 0)).toBe(true);
  });
  it('controls seed density, size, and chemical amount independently', () => {
    const occupied = (field: Float32Array) => [...field].filter((v, i) => i % 2 === 1 && v > 0).length;
    expect(occupied(makeSeed(128, 80, 42, 'scatter', { count: 50 }))).toBeGreaterThan(occupied(makeSeed(128, 80, 42, 'scatter', { count: 1 })));
    expect(occupied(makeSeed(128, 80, 42, 'spot', { radius: 10 }))).toBeGreaterThan(occupied(makeSeed(128, 80, 42, 'spot', { radius: 3 })));
    const low = makeSeed(128, 80, 42, 'spot', { amount: .1 }), high = makeSeed(128, 80, 42, 'spot', { amount: .6 });
    expect(occupied(low)).toBe(occupied(high));
    expect(high[(40 * 128 + 64) * 2 + 1] - low[(40 * 128 + 64) * 2 + 1]).toBeCloseTo(.5);
  });
  it('adds only in the mask, keeps existing chemistry, and caps concentrations', () => {
    const original = new Float32Array([.8, .2, .4, .9, 1, 0]);
    const result = addSeeds(original, new Float32Array([1, 0, .5, .3, .5, .25]));
    expect([...result]).toEqual([...new Float32Array([.8, .2, .4, 1, .5, .25])]);
    expect([...original]).toEqual([...new Float32Array([.8, .2, .4, .9, 1, 0])]);
    expect(() => addSeeds(original, new Float32Array(2))).toThrow('dimensions');
  });
});
describe('vector export', () => {
  // A ring with a hole, and a separate solid square: two shapes, one of them with two rings.
  const field = new Float32Array(24 * 12 * 2);
  for (let y = 2; y < 10; y++) for (let x = 2; x < 10; x++) if (x < 5 || x > 6 || y < 5 || y > 6) field[(y * 24 + x) * 2 + 1] = .4;
  for (let y = 3; y < 9; y++) for (let x = 14; x < 20; x++) field[(y * 24 + x) * 2 + 1] = .4;

  it('writes one selectable path per shape, each holding its own holes', () => {
    const svg = fieldToSVG(field, 24, 12, .2, palettes[0]);
    expect(svg).toContain('viewBox="0 0 24 12"');
    expect(svg).toContain('<g id="pattern"');
    expect(svg).toContain('fill-rule="evenodd"');
    expect(svg.match(/<path /g)).toHaveLength(2);
    expect(svg).toContain('id="shape-1"');
    expect(svg).toContain('id="shape-2"');
    // The ring's path has two subpaths (outer and hole); the square has one.
    const subpaths = (svg.match(/ d="[^"]*"/g) ?? []).map(d => (d.match(/M/g) ?? []).length).sort();
    expect(subpaths).toEqual([1, 2]);
    expect(svg).not.toMatch(/<image|data:image|NaN|Infinity/);
  });
  it('smooths with cubic curves by default and can fall back to straight segments', () => {
    expect(fieldToSVG(field, 24, 12, .2, palettes[0])).toMatch(/C[\d.-]+,[\d.-]+ /);
    const straight = fieldToSVG(field, 24, 12, .2, palettes[0], { smooth: false });
    expect(straight).not.toMatch(/C[\d.-]+,/);
    expect(straight).toMatch(/L[\d.-]+,/);
  });
  it('handles an empty chemical field without invalid geometry', () => {
    const svg = fieldToSVG(new Float32Array(32), 4, 4, .2, palettes[0]);
    expect(svg).not.toContain('<path');
    expect(svg).toContain(palettes[0].background);
    expect(svg).not.toMatch(/NaN|Infinity/);
  });
  it('uses the selected threshold to change contour geometry', () => {
    const seeded = makeSeed(40, 40, 42);
    expect(fieldToSVG(seeded, 40, 40, .1, palettes[0])).not.toEqual(fieldToSVG(seeded, 40, 40, .3, palettes[0]));
  });
});
