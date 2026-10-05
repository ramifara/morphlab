# Morph Lab

A GPU reaction–diffusion playground for growing, painting, and exporting organic patterns. Built with TypeScript and Vite.

## Run locally

Requires Node.js 22.12+.

```sh
npm install
npm run dev
```

Open the printed local URL. WebGPU needs a secure context, either HTTPS or localhost. The app automatically falls back to WebGL 2 when WebGPU is unavailable. You can also choose either engine in the controls.

```sh
npm run build   # Type-check and build to dist/
npm test        # Seed and vector-contour regression tests
npm run preview
```

## Play

The canvas fills the window. Everything else floats over it and can be hidden.

- **Specimens** (right panel): pick a starting recipe, or press 1–6. **Surprise me** picks a random specimen, seed, and palette.
- **Recipe** (left panel): change feed, kill, or either diffusion rate. Pick a palette or set your own two colors, then adjust pattern weight, evolution speed, or compute engine.
- **Toolbar** (bottom): play, pause, step, paint, erase, move, brush size, zoom, and reseed.
- Drag on the canvas to paint chemical B. Hold Shift to erase. Scroll to move, hold ⌘ or Ctrl while scrolling to zoom, or pinch on a touch screen.
- The field wraps at its edges, so you can move across it endlessly in any direction and zoom out to see it tile.
- Press **H** to hide the whole interface and watch the pattern. Press **[** or **]** to toggle a single panel. Panel state is remembered.
- Press **?** for all shortcuts.

Some parameter combinations produce a uniform field. That is a valid equilibrium. Choose a specimen or reseed to grow another pattern.

## GPU simulation

The simulation uses the Gray–Scott equations on a 512 × 320 periodic grid. A nine-point Laplacian weights the center −1, cardinal neighbors 0.2, and diagonal neighbors 0.05. Both engines use a time step of 1 and the same seeded chemical field.

- **WebGPU:** WGSL compute shaders alternate between two storage buffers. A fragment shader interpolates the field and applies the palette.
- **WebGL 2:** GLSL fragment shaders alternate between two RG32F framebuffer textures. This requires `EXT_color_buffer_float`.

Simulation and canvas rendering stay on the GPU. Only seed creation and export processing use the CPU. Changing engines preserves the current chemical field when the old device is still readable. The view preserves pattern proportions and crops to fit its container; zoom and cropping do not change the chemistry.

The presets start with a short accelerated growth phase. Reseed starts from fresh seeds so you can watch the full evolution. Browser visibility pauses GPU submissions.

Model reference: [Karl Sims' reaction–diffusion tutorial](https://www.karlsims.com/rd.html).

## Export

- **PNG:** 2048 × 1280 or 4096 × 2560 images of the full chemical field using the current colors and pattern weight. They are smoothed 4× and 8× enlargements of the simulation grid.
- **SVG:** Real vector contours extracted with marching squares through `d3-contour`. Every blob is its own `<path>` inside a `pattern` group, with holes kept in the same path, so shapes stay selectable in Figma, Illustrator, or Inkscape. Contours are smoothed into cubic curves by default; untick **Smooth curves** for the raw marching-squares polygons. SVG is a two-color interpretation of the field, without the canvas's soft transitions.
- **Embed:** An `<iframe>` snippet that runs the simulation live on the viewer's GPU with the current recipe, colors, seed, and zoom. Choose an inline block or a full-page background, and whether visitors can paint.
- **Share link:** A URL that opens the lab in the current state.

Both image exports capture the full field, independent of viewport position or zoom. Neither includes the interface. Larger, smoother PNG output does not add simulation detail.

### URL parameters

The lab reads its state from the query string, which is what share links and embeds use.

| Parameter | Meaning |
| --- | --- |
| `p` | Specimen index, 0–5 |
| `f`, `k` | Feed and kill rates |
| `da`, `db` | Diffusion rates for A and B |
| `bg`, `fg` | Background and pattern colors as six-digit hex without `#` |
| `w` | Pattern weight threshold, 0.08–0.3 |
| `s` | Evolution speed, 1–48 steps per frame |
| `seed` | Seed for the initial field |
| `z` | Zoom, 0.25–6 |
| `embed` | Hide the interface entirely |
| `interact=0` | Disable painting and moving, for backgrounds |

`scripts/generate-presets.mjs` regenerates the static specimen thumbnails with an offline reference simulation:

```sh
node scripts/generate-presets.mjs
```

The interface loads DM Sans and IBM Plex Mono from Google Fonts, with local fallbacks if unavailable. No server, API keys, or account is required.
