import { describe, expect, it } from 'vitest';
import {
  LAYER_HEIGHT, LAYER_WIDTH, PEER_TIMEOUT, PeerRegistry, cellToLayerUV, compositeLayer, intersect, newestMix,
  parseMixMode, sameState, stripToAB, viewportRect, type Peer, type Rect, type Snapshot,
} from './link';

const peer = (id: string, rect: Rect, focusedAt: number, extra: Partial<Peer> = {}): Peer => ({
  id, rect, focusedAt, seenAt: focusedAt, feed: .03, kill: .062, background: '#000000', foreground: '#ffffff', mix: 'melt', mixChangedAt: 0, ...extra,
});
/** A snapshot whose every texel holds the given A and B bytes. */
const flat = (rect: Rect, a: number, b: number): Snapshot => {
  const data = new Uint8Array(LAYER_WIDTH * LAYER_HEIGHT * 2);
  for (let i = 0; i < data.length; i += 2) { data[i] = a; data[i + 1] = b; }
  return { rect, width: LAYER_WIDTH, height: LAYER_HEIGHT, data };
};
const texel = (data: Uint8Array, x: number, y: number) => Array.from(data.subarray((y * LAYER_WIDTH + x) * 4, (y * LAYER_WIDTH + x) * 4 + 4));

describe('window geometry', () => {
  it('derives the viewport rectangle from the window frame', () => {
    expect(viewportRect({ screenX: 100, screenY: 50, outerWidth: 1000, innerWidth: 980, outerHeight: 800, innerHeight: 700 })).toEqual({ x: 110, y: 150, w: 980, h: 700 });
  });
  it('intersects rectangles and treats touching edges as no overlap', () => {
    expect(intersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 0, w: 10, h: 10 })).toBeNull();
    expect(intersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBeNull();
    expect(intersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: -5, w: 10, h: 10 })).toEqual({ x: 5, y: 0, w: 5, h: 5 });
  });
  it('parses mixing modes from URLs and settings', () => {
    for (const mode of ['melt', 'cross', 'siphon', 'carve', 'off']) expect(parseMixMode(mode)).toBe(mode);
    expect(parseMixMode('blend')).toBe('melt');
    expect(parseMixMode(undefined, 'off')).toBe('off');
  });
  it('maps a cell to the canvas uv that displays it', () => {
    const size = { width: 512, height: 320 }, one = { x: 1, y: 1 };
    const centre = cellToLayerUV({ x: 255.5, y: 159.5 }, size, { x: 0, y: 0 }, 1, one);
    expect(centre.u).toBeCloseTo(.5); expect(centre.v).toBeCloseTo(.5);
    const corner = cellToLayerUV({ x: 0, y: 0 }, size, { x: 0, y: 0 }, 1, one);
    expect(corner.u).toBeCloseTo(0); expect(corner.v).toBeCloseTo(0);
    // Zoomed out, the field tiles; a cell maps through its instance nearest the view centre.
    const zoomed = cellToLayerUV({ x: 0, y: 0 }, size, { x: 0, y: 0 }, .5, one);
    expect(zoomed.u).toBeCloseTo(.25); expect(zoomed.v).toBeCloseTo(.25);
    // Panning half a field brings the far cell to the left edge.
    const panned = cellToLayerUV({ x: 256, y: 160 }, size, { x: 256, y: 160 }, 1, one);
    expect(panned.u).toBeCloseTo(0); expect(panned.v).toBeCloseTo(0);
    // A view wider than the field letterboxes vertically.
    const letterbox = cellToLayerUV({ x: 255.5, y: 0 }, size, { x: 0, y: 0 }, 1, { x: 1, y: .5 });
    expect(letterbox.u).toBeCloseTo(.5); expect(letterbox.v).toBeCloseTo(-.5);
  });
});

describe('peer registry', () => {
  const state = (id: string, focusedAt = 1) => ({ type: 'state' as const, state: { id, rect: { x: 0, y: 0, w: 100, h: 100 }, focusedAt, feed: .03, kill: .06, background: '#000000', foreground: '#ffffff', mix: 'melt' as const, mixChangedAt: 0 } });
  it('tracks other windows and ignores its own messages', () => {
    const registry = new PeerRegistry('me');
    expect(registry.receive(state('me'), 0)).toBe(false);
    expect(registry.receive(state('a'), 0)).toBe(true);
    expect(registry.receive(state('a'), 10)).toBe(false);
    expect(registry.peers().map(p => p.id)).toEqual(['a']);
  });
  it('attaches field snapshots to known peers only', () => {
    const registry = new PeerRegistry('me');
    const snapshot = flat({ x: 0, y: 0, w: 100, h: 100 }, 1, 2);
    expect(registry.receive({ type: 'field', id: 'ghost', snapshot }, 0)).toBe(false);
    registry.receive(state('a'), 0);
    expect(registry.receive({ type: 'field', id: 'a', snapshot }, 0)).toBe(true);
    expect(registry.peers()[0].snapshot).toBe(snapshot);
  });
  it('rejects malformed rectangles and snapshots from other tabs', () => {
    const registry = new PeerRegistry('me');
    const bad = state('a'); bad.state.rect = { x: 0, y: 0, w: 0, h: 100 };
    expect(registry.receive(bad, 0)).toBe(false);
    registry.receive(state('a'), 0);
    const short = { ...flat({ x: 0, y: 0, w: 100, h: 100 }, 1, 1), data: new Uint8Array(3) };
    expect(registry.receive({ type: 'field', id: 'a', snapshot: short }, 0)).toBe(false);
    expect(registry.receive({ type: 'field', id: 'a', snapshot: { ...short, rect: { x: NaN, y: 0, w: 1, h: 1 } } }, 0)).toBe(false);
    expect(registry.peers()[0].snapshot).toBeUndefined();
  });
  it('compares states field by field', () => {
    const a = state('a').state;
    expect(sameState(a, { ...a, rect: { ...a.rect } })).toBe(true);
    expect(sameState(a, { ...a, kill: .061 })).toBe(false);
  });
  it('removes peers that leave or fall silent', () => {
    const registry = new PeerRegistry('me');
    registry.receive(state('a'), 0); registry.receive(state('b'), 1000);
    expect(registry.receive({ type: 'leave', id: 'a' }, 1000)).toBe(true);
    expect(registry.expire(1000 + PEER_TIMEOUT)).toBe(false);
    expect(registry.expire(1001 + PEER_TIMEOUT)).toBe(true);
    expect(registry.peers()).toEqual([]);
  });
  it('orders peers with the most recently focused first and finds overlaps', () => {
    const registry = new PeerRegistry('me');
    registry.receive(state('old', 1), 0); registry.receive(state('new', 5), 0);
    expect(registry.peers().map(p => p.id)).toEqual(['new', 'old']);
    expect(registry.overlapping({ x: 50, y: 50, w: 10, h: 10 })).toHaveLength(2);
    expect(registry.overlapping({ x: 500, y: 50, w: 10, h: 10 })).toHaveLength(0);
  });
});

describe('foreign layer', () => {
  const own: Rect = { x: 0, y: 0, w: 1000, h: 500 };
  it('is empty when no peer overlaps or no snapshot has arrived', () => {
    const away = peer('a', { x: 2000, y: 0, w: 500, h: 500 }, 1, { snapshot: flat({ x: 2000, y: 0, w: 500, h: 500 }, 9, 9) });
    const silent = peer('b', own, 1);
    const layer = compositeLayer(own, 0, [away, silent]);
    expect(layer.slots).toEqual([]);
    expect(layer.data.every(v => v === 0)).toBe(true);
  });
  it('covers the overlap with the peer field, slot, and feathered weight', () => {
    const rect = { x: 500, y: -100, w: 1000, h: 1000 };
    const layer = compositeLayer(own, 5, [peer('a', rect, 2, { feed: .05, kill: .07, snapshot: flat(rect, 100, 200) })]);
    expect(layer.slots).toEqual([{ feed: .05, kill: .07, background: '#000000', foreground: '#ffffff', above: false }]);
    expect(texel(layer.data, 10, 80)).toEqual([0, 0, 0, 0]);
    expect(texel(layer.data, 200, 80)).toEqual([100, 200, 1, 255]);
    // Just inside the peer's left edge (x ≈ 510 px) the weight ramps up.
    const [, , slot, weight] = texel(layer.data, 130, 80);
    expect(slot).toBe(1); expect(weight).toBeGreaterThan(0); expect(weight).toBeLessThan(255);
  });
  it('lets the most recently focused peer win and marks peers above the own window', () => {
    const rectA = { x: 0, y: 0, w: 1000, h: 500 }, rectB = { x: 500, y: 0, w: 1000, h: 500 };
    const a = peer('a', rectA, 1, { snapshot: flat(rectA, 10, 10) });
    const b = peer('b', rectB, 9, { snapshot: flat(rectB, 20, 20) });
    const layer = compositeLayer(own, 5, [b, a]);
    expect(layer.slots.map(s => s.above)).toEqual([true, false]);
    expect(texel(layer.data, 60, 80)).toEqual([10, 10, 2, 255]);
    expect(texel(layer.data, 200, 80)).toEqual([20, 20, 1, 255]);
  });
  it('reuses the output buffer when one is provided', () => {
    const out = new Uint8Array(LAYER_WIDTH * LAYER_HEIGHT * 4).fill(7);
    const layer = compositeLayer(own, 0, [], out);
    expect(layer.data).toBe(out); expect(out.every(v => v === 0)).toBe(true);
  });
  it('strips RGBA capture data to A and B bytes', () => {
    expect(stripToAB(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toEqual(new Uint8Array([1, 2, 5, 6]));
  });
  it('picks the newest mix mode across windows', () => {
    expect(newestMix([{ mix: 'melt', mixChangedAt: 1 }, { mix: 'carve', mixChangedAt: 3 }, { mix: 'off', mixChangedAt: 2 }])).toEqual({ mix: 'carve', mixChangedAt: 3 });
    expect(newestMix([])).toBeNull();
  });
});
