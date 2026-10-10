# Linked Windows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let several Morph Lab browser windows discover each other's screen positions and mix their reaction–diffusion fields where they overlap, in four selectable ways.

**Architecture:** A pure `src/link.ts` module owns geometry, peer bookkeeping, and compositing of peer snapshots into a 256 × 160 "foreign layer". `src/engine.ts` gains `capture()` (read back the visible viewport) and `setCoupling()` (upload the layer and per-peer slots), and both compute shaders apply the coupling term. `src/main.ts` wires a `BroadcastChannel` to the frame loop and adds a "Windows" section to the Recipe dock.

**Tech Stack:** TypeScript, Vite, vitest, WebGPU (WGSL), WebGL 2 (GLSL ES 3.0), BroadcastChannel.

**Spec:** `docs/superpowers/specs/2026-10-10-linked-windows-design.md`

## Global Constraints

- Snapshot and layer size: 256 × 160 texels. Snapshot payload is two bytes per texel (A, B).
- Up to 4 peer slots per receiver.
- Peer heartbeat 500 ms; peers expire after 2000 ms of silence.
- Capture at most every 33 ms and only while a peer overlaps.
- Feather width 48 screen px. Default mode `melt`, default strength 0.6.
- Mode names and URL values: Melt `melt`, Crossbreed `cross`, Siphon `siphon`, Carve `carve`, Off `off`.
- Embeds (`?embed`) and framed pages (`window !== window.top`) never link.
- Existing behavior for a single window is unchanged; `npm run build` and `npm test` stay green.

## Review Focus

1. Window moved so no overlap remains: the layer must become all-zero and the tint disappear (Task 1 compositing test with disjoint rect; Task 4 clears coupling when `overlapping` turns false).
2. A peer that closes abruptly without `leave`: must vanish after 2 s and its tint with it (Task 1 registry expiry test).
3. Zoomed-out view (zoom < 1) where a cell appears several times on screen: mapping must pick a single instance and never read outside the layer (Task 1 mapping test for zoom .5).
4. Peer with no snapshot yet (Crossbreed users would still expect coverage): contributes nothing until a snapshot arrives (Task 1 compositing test).
5. Engine replaced after a backend or resolution change: coupling re-applied so the overlap keeps mixing (Task 4 re-apply in `initialize`).

---

### Task 1: Pure link logic (`src/link.ts`)

**Files:**
- Create: `src/link.ts`
- Test: `src/link.test.ts`

**Interfaces produced:**
```ts
export const LAYER_WIDTH = 256, LAYER_HEIGHT = 160, MAX_PEERS = 4, FEATHER = 48, PEER_TIMEOUT = 2000;
export const mixModes = ['melt', 'cross', 'siphon', 'carve', 'off'] as const;
export type MixMode = typeof mixModes[number];
export const mixNames: Record<MixMode, string>; export const mixHints: Record<MixMode, string>;
export function parseMixMode(value: unknown, fallback: MixMode = 'melt'): MixMode;
export interface Rect { x: number; y: number; w: number; h: number }
export interface WindowMetrics { screenX: number; screenY: number; outerWidth: number; outerHeight: number; innerWidth: number; innerHeight: number }
export function viewportRect(w: WindowMetrics): Rect;
export function intersect(a: Rect, b: Rect): Rect | null;
export function sameRect(a: Rect, b: Rect): boolean;
export interface PeerState { id: string; rect: Rect; focusedAt: number; feed: number; kill: number; background: string; foreground: string; mix: MixMode; mixChangedAt: number }
export interface Snapshot { rect: Rect; width: number; height: number; data: Uint8Array }
export interface Peer extends PeerState { seenAt: number; snapshot?: Snapshot }
export type LinkMessage = { type: 'state'; state: PeerState } | { type: 'field'; id: string; snapshot: Snapshot } | { type: 'leave'; id: string };
export class PeerRegistry {
  constructor(readonly selfId: string);
  receive(message: LinkMessage, now: number): boolean;     // returns true when something changed
  expire(now: number): boolean;
  peers(): Peer[];                                          // topmost first (focusedAt desc)
  overlapping(rect: Rect): Peer[];
}
export interface PeerSlot { feed: number; kill: number; background: string; foreground: string; above: boolean }
export interface ForeignLayer { data: Uint8Array /* LAYER_WIDTH*LAYER_HEIGHT*4 */; slots: PeerSlot[] }
export function compositeLayer(own: Rect, ownFocusedAt: number, peers: Peer[], out?: Uint8Array): ForeignLayer;
export function cellToLayerUV(cell: {x:number;y:number}, size: {width:number;height:number}, pan: {x:number;y:number}, zoom: number, viewScale: {x:number;y:number}): {u:number;v:number};
export function stripToAB(rgba: Uint8Array): Uint8Array;  // RGBA8 → AB
export function newestMix(states: { mix: MixMode; mixChangedAt: number }[]): { mix: MixMode; mixChangedAt: number } | null;
```

- [ ] **Step 1: Write failing tests** in `src/link.test.ts`:
  - `viewportRect` subtracts top chrome and centers side chrome: `{screenX:100, screenY:50, outerWidth:1000, innerWidth:980, outerHeight:800, innerHeight:700}` → `{x:110, y:150, w:980, h:700}`.
  - `intersect` returns null for disjoint rects, the overlap otherwise, and `null` for touching edges.
  - `parseMixMode` accepts the five names, defaults junk to the fallback.
  - `PeerRegistry`: ignores own id; `state` adds a peer and reports change; same state twice → no change; `field` for unknown id ignored; `leave` removes; `expire` removes peers older than 2000 ms; `peers()` sorted by `focusedAt` descending.
  - `compositeLayer`: disjoint peer → all zeros, no slots; peer without snapshot → zeros; peer with snapshot covering the right half of own rect → left half zero, right half interior A=255 weight 255 with slot byte 1, R/G copied from the snapshot texel; weight ramps near the peer's edge inside own rect (texel at ~10 px from the edge has `0 < w < 255`); two overlapping peers → topmost (newer `focusedAt`) wins; slot `above` is true when peer `focusedAt` > own.
  - `cellToLayerUV`: zoom 1, pan 0, viewScale (1,1), size 512×320: cell (255.5,159.5) → (≈.5,≈.5); cell (0,0) → (≈0,≈0); zoom .5: cell (0,0) → u = .25; pan equal to width/2 → cell at width/2 maps to u ≈ 0 .
  - `stripToAB` keeps R and G bytes only.
  - `newestMix` picks the state with the largest `mixChangedAt`.
- [ ] **Step 2: Run** `npx vitest run src/link.test.ts` → fails (module missing).
- [ ] **Step 3: Implement** `src/link.ts`.
- [ ] **Step 4: Run** tests → pass. `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** `Add pure link geometry, peer registry, and layer compositing`.

### Task 2: Engine capture and coupling

**Files:**
- Modify: `src/engine.ts`

**Interfaces produced:**
```ts
export interface ViewState { zoom: number; pan: View }
export interface Coupling { layer: Uint8Array | null; slots: PeerSlot[]; mode: MixMode; strength: number }
interface Engine {
  step(params, iterations, brush?, view?: ViewState): void;   // view enables coupling mapping
  setCoupling(coupling: Coupling): void;
  capture(view: ViewState): Promise<Uint8Array | null>;        // RGBA8 LAYER_WIDTH×LAYER_HEIGHT; null while a read is pending
}
```

- [ ] **Step 1 (WebGPU):** add a `Mix` uniform buffer (`struct Mix { map: vec4f /* zoom, viewScale.xy, strength */, pan: vec2f, mode: u32, pad: u32, peers: array<vec4f,4> /* feed, kill, above, 0 */, colors: array<vec4f,8> }` = 224 bytes), a `rgba8unorm` 256×160 `foreign` texture + linear sampler, bound at compute bindings 3–5 and render bindings 2–4. Compute shader: after `next` is computed, call `couple(id, next, p)` which maps the cell to layer uv (same formula as `cellToLayerUV`), samples, decodes slot = `u32(round(b*255)) - 1`, weight `a`, and applies the mode table from the spec (mode indices: 0 melt, 1 cross, 2 siphon, 3 carve, 4 off). Crossbreed must modify feed/kill *before* the reaction update, so compute the layer sample first and pass blended feed/kill into the update. Render shader: `let f = textureSampleLevel(foreign, foreignSampler, v.uv, 0.)`; tint with the slot's colors by `f.a * .5`. Capture: a second render pipeline `fsCapture` on the same module writing `vec4f(a, b, 0, 1)` to an `rgba8unorm` texture (RENDER_ATTACHMENT | COPY_SRC); staging buffer 1024 × 160 bytes; `copyTextureToBuffer` with `bytesPerRow: 1024`; `mapAsync` → copy out → return. `pending` flag returns `null` while busy.
- [ ] **Step 2 (WebGL 2):** same uniforms as individual `uniform` declarations (`mixMap`, `mixPan`, `mixMode`, `peers[4]`, `peerColors[8]`), `foreign` sampler on texture unit 1 (RGBA8, LINEAR, CLAMP_TO_EDGE). Capture program renders to an RGBA8 FBO 256×160 using unflipped `uv.y` so row 0 is the screen top; `readPixels` RGBA/UNSIGNED_BYTE.
- [ ] **Step 3:** `setCoupling` uploads the layer (or a zeroed layer when `layer` is null) and stores slots/mode/strength; `step` writes the Mix uniform from `view` (when `view` is omitted, mode is forced to off).
- [ ] **Step 4:** `npx tsc --noEmit`; then in headless Chrome (`/tmp/morphlab-e2e/probe.mjs`) load the app on both backends and confirm no console errors and the simulation still runs (iteration counter increases). Commit `Add viewport capture and overlap coupling to both GPU engines`.

### Task 3: URL and model plumbing

**Files:**
- Modify: `src/main.ts` (URL state, `stateParams`), `README.md` (URL table row `mix`)

- [ ] Read `mix` from the query with `parseMixMode`, write it in `stateParams()` when not `melt`. Commit with Task 4.

### Task 4: Window link wiring and UI

**Files:**
- Modify: `src/main.ts`, `src/style.css`, `src/icons.ts` (add `windows` icon), `README.md`

- [ ] **Step 1: Markup.** Add section `05 Windows` in the left dock with `#open-window` (primary button "Open a linked window"), `#mix-mode` select, `#mix-strength` slider via `startSlider`-like markup, `#link-status` hint, and `#link-note` for the no-BroadcastChannel case. Add HUD chip `#link-chip` (hidden until peers exist) after the specimen chip.
- [ ] **Step 2: Link runtime** in `main.ts`:
  ```ts
  const link = { id: crypto.randomUUID(), channel: BroadcastChannel|null, registry: new PeerRegistry(id), rect: Rect, focusedAt: Date.now(), lastState: 0, lastCapture: 0, layerDirty: false, overlapping: false, lastSent: PeerState|null };
  function linkState(): PeerState  // from current params/palette/mix
  function linkTick(now)           // poll rect; send state if changed or 500ms heartbeat; expire; recompute overlapping; set layerDirty when rects moved
  function applyLayer()            // compositeLayer → engine.setCoupling
  async function sendField()       // engine.capture → stripToAB → post 'field'
  ```
  `channel.onmessage`: `registry.receive` → `layerDirty = true`; for `state` messages adopt a newer mix via `newestMix`. `window.addEventListener('focus')` updates `focusedAt`; `pagehide` posts `leave`. Disabled when `embed || window !== window.top || !('BroadcastChannel' in window)`.
- [ ] **Step 3: Frame loop.** Call `linkTick(time)` first; if `layerDirty` → `applyLayer()`; pass `{ zoom, pan }` into `engine.step`; after render, if `link.overlapping && time - lastCapture > 33` → `sendField()`. In `initialize()` after `engine = candidate` → `applyLayer()` so a new engine gets the coupling.
- [ ] **Step 4: Controls.** `#open-window`: build `shareURL()` query with `p` = next specimen, `seed` random, palette = next palette, `mix` current, open with `popup,width=${innerWidth},height=${innerHeight},left=${screenX+72},top=${screenY+72}`; toast if blocked. `#mix-mode` change → `setMix(mode, Date.now())` (updates select, hint, broadcasts). `#mix-strength` input → strength, `applyLayer()`. Keyboard `n` → open window. Add shortcut row. Status text and chip updated in `linkTick` when peer count or overlap changes.
- [ ] **Step 5: Styles** for `.link-chip`, `.link-status`, pulsing dot while overlapping.
- [ ] **Step 6: README** section "Linked windows" plus `mix` URL parameter.
- [ ] **Step 7: Verify** with `/tmp/morphlab-e2e/windows.mjs`: open page A, click `#open-window` (popup B at the same headless position so they overlap), wait 3 s, assert both report "Overlapping", read a field snapshot from each via `engine.capture` exposed through the debug-free route: compare `#link-status` text and check the layer tint by reading the canvas center pixel differs from the palette's pure colors. Run `npm test`, `npm run build`. Commit `Link overlapping browser windows and mix their patterns`.

### Task 5: PR

- [ ] Push branch, open non-draft PR against `main` with a short description and `🤖 Generated with [Claude Code](https://claude.com/claude-code)`, link it to the thread.
