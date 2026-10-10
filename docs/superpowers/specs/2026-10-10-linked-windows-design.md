# Linked windows: mixing patterns where browser windows overlap

Date: 2026-10-10

## Intent

Morph Lab runs one reaction–diffusion field per browser window. Rami wants the
multi-window trick popularised by Bjørn Staal's "multiple window 3D scene": several
same-origin windows know where they sit on the screen and treat the screen as one
shared space. Here each window keeps its own recipe and field, and where two
windows physically overlap on the desktop the two chemistries interact. Moving a
window over another should produce an immediate, visible effect, and there should
be several distinct ways to mix.

Success: open a second window from the first with one click, drag it over the
first, and watch the two patterns melt, crossbreed, siphon, or carve each other in
the overlap; all of it runs on the GPU in every window at interactive frame rates;
nothing changes for a single window.

Assumptions made without asking (Rami asked for an autonomous run):

- Mixing is a property of the link, not of each window. The mode chosen in any
  window applies to all linked windows (last change wins).
- The feature is for the full app only. Embeds and iframes do not link.
- Browser window positions come from `screenX`/`screenY`. Wayland hides them, so
  the feature works on macOS, Windows, X11, and ChromeOS. The README says so.

## Approaches considered

1. **Shared world** – one simulation, every window shows the slice under it.
   Striking, but not what was asked: there is nothing to mix.
2. **Parameter-only coupling** – windows exchange recipes; the overlap runs a
   blended recipe. Cheap, but only one kind of mixing, and nothing of the other
   pattern's shape crosses over.
3. **Field exchange in screen space (chosen)** – each window broadcasts a small
   snapshot of its *visible* field together with its screen rectangle. Each
   receiver composites the snapshots that cover its own viewport into one
   "foreign layer" texture and feeds it to the compute shader as a coupling term.
   Supports several mixing modes, any number of windows, differing zoom, pan,
   and base resolution, with one shader path.

## Architecture

### Transport: `BroadcastChannel('morphlab-windows')`

Same-origin windows only, no server. Messages:

| type | payload |
| --- | --- |
| `state` | `id`, viewport `rect` in screen CSS px, `focusedAt`, `params` (feed, kill), `palette`, `mix` mode + `mixChangedAt`, `t` |
| `field` | `id`, `rect` at capture time, `width`, `height`, `data` (Uint8Array, two bytes per texel: A, B) |
| `leave` | `id` |

Each window sends `state` whenever its geometry, recipe, palette, focus or mode
changes, and as a heartbeat every 500 ms. Peers silent for 2 s are dropped.
`pagehide` sends `leave`.

Viewport rect: `x = screenX + (outerWidth − innerWidth) / 2`,
`y = screenY + (outerHeight − innerHeight)`, `w = innerWidth`, `h = innerHeight`.
Polled every frame; there is no move event.

### Snapshot capture (engine)

`engine.capture(view)` renders the visible viewport (same projection as the
display pass) into a 256 × 160 RGBA8 texture, A in red and B in green, and reads
it back. WebGPU: render pipeline → `copyTextureToBuffer` → `mapAsync`; one
staging buffer, skip while a read is pending. WebGL 2: render to an RGBA8
framebuffer → `readPixels`. The sender strips to two bytes per texel before
broadcasting (82 KB). Capture happens only while at least one peer overlaps
this window, at most every 33 ms.

### Foreign layer (CPU composite, `src/link.ts`)

For each of the 256 × 160 layer texels covering my viewport, find the topmost
peer (latest `focusedAt`) whose snapshot rect contains that screen point, sample
its snapshot, and write:

- R = foreign A, G = foreign B
- B = peer slot + 1 (0 means no peer)
- A = weight: distance to the peer's rect edge feathered over 48 px

Up to four peer slots. Rebuilt at most once per frame when a snapshot or any
rect changed. Uploaded with `engine.setCoupling(layer, slots, mode, strength)`.
Slots carry each peer's feed, kill, colors, and whether that peer is above me
(`focusedAt` newer than mine).

### Compute shader coupling

For each cell: map the cell center to canvas uv through the inverse of the
display projection (wrapping so a cell uses its on-screen instance nearest the
view center), sample the layer, and if weight `w > 0` apply the mode:

| mode | effect in overlap |
| --- | --- |
| Melt | both chemicals relax toward the foreign values: `c = mix(c, foreign, w·s·0.04)` |
| Crossbreed | feed and kill become `mix(own, peer, 0.5·w·s)`; a third pattern grows at the junction |
| Siphon | the window above gains B from the one below (`B += w·s·0.03·foreignB`); the one below loses B where covered (`B *= 1 − w·s·0.03`) |
| Carve | each pattern erodes where the other has B: `B *= 1 − w·s·0.08·foreignB` |
| Off | no coupling |

`s` is the strength slider (0–1, default 0.6). Rates are per simulation step.

### Rendering

The display shader samples the layer at canvas uv and blends background and
foreground 50 % toward the peer's colors, scaled by `w`. The overlap region is
therefore visible in every mode, and reads as "both windows' colors".

### UI (left dock, new section 05 "Windows")

- **Open a linked window**: `window.open` of the current share URL with another
  specimen, a fresh seed, and a different palette, positioned 72 px down and
  right of this window so it overlaps immediately. Shortcut `N`.
- **When windows overlap**: select Melt / Crossbreed / Siphon / Carve / Off.
- **Strength** slider.
- Status line: "No other windows yet", "1 other window", "Overlapping 2 windows".
- Top HUD chip "⧉ 2 windows" appears when peers exist, pulses while overlapping.

URL parameter `mix` (`melt`, `cross`, `siphon`, `carve`, `off`) so share links and
popups carry the mode. Default `melt`.

## Data flow per frame

1. `link.tick()` polls geometry, sends `state` if changed or heartbeat due,
   expires peers, reports `overlapping`.
2. If the layer is dirty, composite and `engine.setCoupling`.
3. `engine.step(params, steps, brush, view)` writes the coupling uniform (mode,
   strength, zoom, pan, view scale, slots) and runs the compute passes.
4. `engine.render` tints the overlap.
5. If overlapping and no capture pending: `engine.capture(view)` → `field`.

## Error handling

- `BroadcastChannel` missing (very old browsers): the section shows a note and
  everything else works.
- Popup blocked: toast "Allow pop-ups to open a linked window."
- A peer with no snapshot yet contributes nothing (weight 0) so Melt never
  blends toward zeros.
- Engine re-creation (resolution or backend change) re-applies the coupling
  state. Capture errors are logged once and disable capture for that engine.

## Testing

Vitest (node) covers the pure logic in `src/link.ts`: viewport rect from window
metrics, rect intersection, mode parsing, peer registry (add, update, expire,
leave, top order), layer compositing (coverage, slot encoding, feathering,
topmost wins, no-snapshot peers skipped), and the grid→layer uv mapping used by
the shaders. Shader changes are verified in headless Chromium on WebGL 2 by
opening two windows at the same screen position (headless reports 0,0 for all
windows, so they fully overlap) and checking that coupling changes the field.

## Out of scope

Shared single world, cross-device linking, persistence of link state, mobile.
