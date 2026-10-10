/**
 * Linked windows: pure geometry, peer bookkeeping, and compositing for mixing
 * reaction–diffusion fields where same-origin browser windows overlap on screen.
 * Everything here runs without the DOM or GPU so it can be unit tested.
 */

/** Snapshot and foreign-layer texture size. */
export const LAYER_WIDTH = 256, LAYER_HEIGHT = 160;
/** Peer slots the shaders can address per receiver. */
export const MAX_PEERS = 4;
/** Soft edge, in screen pixels, where a peer window's influence fades in. */
export const FEATHER = 48;
/** Silence after which a peer window is considered gone. */
export const PEER_TIMEOUT = 2000;

export const mixModes = ['melt', 'cross', 'siphon', 'carve', 'off'] as const;
export type MixMode = typeof mixModes[number];
export const mixNames: Record<MixMode, string> = { melt: 'Melt', cross: 'Crossbreed', siphon: 'Siphon', carve: 'Carve', off: 'Keep apart' };
export const mixHints: Record<MixMode, string> = {
  melt: 'Both fields flow into each other and fuse where the windows overlap.',
  cross: 'The overlap runs a blend of both recipes, so a third pattern grows at the junction.',
  siphon: 'The front window drinks chemical from the one beneath, which is drained where it is covered.',
  carve: 'Each pattern erodes where the other has grown. Only the differences survive.',
  off: 'Windows see each other but keep their chemistry to themselves.',
};
export function parseMixMode(value: unknown, fallback: MixMode = 'melt'): MixMode {
  return mixModes.includes(value as MixMode) ? value as MixMode : fallback;
}

export interface Rect { x: number; y: number; w: number; h: number }
export interface WindowMetrics { screenX: number; screenY: number; outerWidth: number; outerHeight: number; innerWidth: number; innerHeight: number }

/** Where the page's viewport sits on the screen, in CSS pixels. Browser chrome is assumed to be above and evenly beside the page. */
export function viewportRect(w: WindowMetrics): Rect {
  return { x: w.screenX + (w.outerWidth - w.innerWidth) / 2, y: w.screenY + (w.outerHeight - w.innerHeight), w: w.innerWidth, h: w.innerHeight };
}
export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x, h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}
export const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

export interface PeerState {
  id: string; rect: Rect;
  /** When the window was last focused. The newest is treated as the frontmost window. */
  focusedAt: number;
  feed: number; kill: number; background: string; foreground: string;
  mix: MixMode; mixChangedAt: number;
}
/** The visible part of a peer's field, A then B as bytes, row 0 at the top of its viewport. */
export interface Snapshot { rect: Rect; width: number; height: number; data: Uint8Array }
export interface Peer extends PeerState { seenAt: number; snapshot?: Snapshot }
export type LinkMessage =
  | { type: 'state'; state: PeerState }
  | { type: 'field'; id: string; snapshot: Snapshot }
  | { type: 'leave'; id: string };

const sameState = (a: PeerState, b: PeerState) =>
  sameRect(a.rect, b.rect) && a.focusedAt === b.focusedAt && a.feed === b.feed && a.kill === b.kill
  && a.background === b.background && a.foreground === b.foreground && a.mix === b.mix && a.mixChangedAt === b.mixChangedAt;

export class PeerRegistry {
  private map = new Map<string, Peer>();
  constructor(readonly selfId: string) {}
  /** Apply a message. Returns true when the set of peers or their data changed. */
  receive(message: LinkMessage, now: number): boolean {
    if (message.type === 'state') {
      const { state } = message;
      if (state.id === this.selfId) return false;
      const existing = this.map.get(state.id);
      if (existing && sameState(existing, state)) { existing.seenAt = now; return false; }
      this.map.set(state.id, { ...state, rect: { ...state.rect }, seenAt: now, snapshot: existing?.snapshot });
      return true;
    }
    if (message.type === 'field') {
      const peer = this.map.get(message.id);
      if (!peer) return false;
      peer.snapshot = message.snapshot; peer.seenAt = now;
      return true;
    }
    return this.map.delete(message.id);
  }
  expire(now: number): boolean {
    let changed = false;
    for (const [id, peer] of this.map) if (now - peer.seenAt > PEER_TIMEOUT) { this.map.delete(id); changed = true; }
    return changed;
  }
  /** Frontmost first. */
  peers(): Peer[] {
    return [...this.map.values()].sort((a, b) => b.focusedAt - a.focusedAt || a.id.localeCompare(b.id));
  }
  overlapping(rect: Rect): Peer[] { return this.peers().filter(p => intersect(rect, p.rect)); }
}

export interface PeerSlot { feed: number; kill: number; background: string; foreground: string; above: boolean }
/** RGBA8 texture covering the own viewport: R = foreign A, G = foreign B, B = slot + 1, A = weight. */
export interface ForeignLayer { data: Uint8Array; slots: PeerSlot[] }

/**
 * Composite the peers' snapshots into the layer the shaders read. Only peers
 * whose snapshot covers part of the own viewport take a slot; the frontmost
 * peer wins where several overlap.
 */
export function compositeLayer(own: Rect, ownFocusedAt: number, peers: Peer[], out = new Uint8Array(LAYER_WIDTH * LAYER_HEIGHT * 4)): ForeignLayer {
  out.fill(0);
  const active = peers.filter(p => p.snapshot && intersect(own, p.snapshot.rect)).slice(0, MAX_PEERS);
  const slots = active.map(p => ({ feed: p.feed, kill: p.kill, background: p.background, foreground: p.foreground, above: p.focusedAt > ownFocusedAt }));
  if (!active.length) return { data: out, slots };
  const stepX = own.w / LAYER_WIDTH, stepY = own.h / LAYER_HEIGHT;
  for (let j = 0; j < LAYER_HEIGHT; j++) {
    const sy = own.y + (j + .5) * stepY;
    for (let i = 0; i < LAYER_WIDTH; i++) {
      const sx = own.x + (i + .5) * stepX;
      for (let slot = 0; slot < active.length; slot++) {
        const { rect, width, height, data } = active[slot].snapshot!;
        if (sx < rect.x || sy < rect.y || sx >= rect.x + rect.w || sy >= rect.y + rect.h) continue;
        const distance = Math.min(sx - rect.x, rect.x + rect.w - sx, sy - rect.y, rect.y + rect.h - sy);
        const t = Math.min(1, distance / FEATHER), weight = t * t * (3 - 2 * t);
        const tx = Math.min(width - 1, Math.floor((sx - rect.x) / rect.w * width)), ty = Math.min(height - 1, Math.floor((sy - rect.y) / rect.h * height));
        const source = (ty * width + tx) * 2, target = (j * LAYER_WIDTH + i) * 4;
        out[target] = data[source]; out[target + 1] = data[source + 1]; out[target + 2] = slot + 1; out[target + 3] = Math.round(weight * 255);
        break;
      }
    }
  }
  return { data: out, slots };
}

/**
 * Canvas uv at which a cell is displayed, inverting the display projection.
 * The field tiles when zoomed out; the instance nearest the view centre is used.
 * Mirrors the shader code so the mapping can be tested here.
 */
export function cellToLayerUV(cell: { x: number; y: number }, size: { width: number; height: number }, pan: { x: number; y: number }, zoom: number, viewScale: { x: number; y: number }) {
  const fract = (v: number) => v - Math.floor(v);
  return {
    u: (fract((cell.x + .5 - pan.x) / size.width) - .5) * zoom / viewScale.x + .5,
    v: (fract((cell.y + .5 - pan.y) / size.height) - .5) * zoom / viewScale.y + .5,
  };
}

/** Keep only the A and B bytes of an RGBA8 capture. */
export function stripToAB(rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array(rgba.length / 2);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 2) { out[j] = rgba[i]; out[j + 1] = rgba[i + 1]; }
  return out;
}

/** The mixing mode chosen most recently in any window. */
export function newestMix<T extends { mix: MixMode; mixChangedAt: number }>(states: T[]): T | null {
  return states.reduce<T | null>((best, s) => (!best || s.mixChangedAt > best.mixChangedAt ? s : best), null);
}
