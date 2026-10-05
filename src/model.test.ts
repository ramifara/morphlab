import { describe, expect, it } from 'vitest';
import { makeSeed, palettes } from './model';
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
