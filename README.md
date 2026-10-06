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

- **Specimens** (right panel): pick a starting recipe, or press 1–7. **Surprise me** picks a random specimen, seed, and palette.
- **Recipe** (left panel): change feed, kill, or either diffusion rate. Click a number to type an exact value, or scroll over a slider to nudge it one step at a time (Shift for ten). Tiny changes can produce very different worlds. Pick a palette or set your own two colors, then adjust pattern weight, evolution speed, base resolution, or compute engine. Base resolution offers 1×, 2×, 3×, and 4× grids. The higher settings use 4×, 9×, and 16× as many cells, with more GPU work and memory use, so they may run slower on some devices.
- **Starting field** (top of Recipe): choose empty, scattered dots, a cluster, a single spot, a ring, a line, a grid, or an image. Type a seed number from 0 to 4294967295. **Restart seed** repeats the same field with the current settings; **New seed** picks a new number and starts fresh. **Add seeds** adds chemical to the current pattern and preserves the rest of the field. **Clear canvas** clears and pauses so you can paint first. Expand **Size, amount & position** for seed count, size, chemical B concentration, corners, edges, and custom coordinates. The B amount also controls the paint brush; Feed controls the ongoing supply of A. Recipe selection keeps your chosen starting field; Surprise me returns to scattered dots.
- **Image starts**: choose **From an image**, upload a logo, drawing, or photo, then adjust the cutoff and choose dark or light areas. Transparent areas stay empty, and the image keeps its proportions. Restart plants the silhouette and pauses; press play to watch it grow. The silhouette is sampled at 128 × 80 and stays in saved versions, share links, and embeds. Reloading retains the silhouette; upload again to adjust its cutoff. Image processing happens locally in your browser.
- **Toolbar** (bottom): play, pause, step, paint, erase, move, brush size, zoom, and reseed.
- Drag on the canvas to paint chemical B. Hold Shift to erase. Scroll to move, hold ⌘ or Ctrl while scrolling to zoom, or pinch on a touch screen.
- The field wraps at its edges, so you can move across it endlessly in any direction and zoom out to see it tile.
- **Saved** (below the specimens): press ⌘S or Ctrl+S to save the current morph under a name, including live knob adjustments and painted changes, plus the recipe, colors, weight, speed, base resolution, seed, zoom, and position. The field is captured when you open Save current. Loading restores that exact field paused; press play to continue growing. Full-precision chemical fields live in your browser's IndexedDB, with recipe metadata and thumbnails in local storage. Older recipe-only saves still regrow from their seeds.
- Press **H** to hide the whole interface and watch the pattern. Press **[** or **]** to toggle a single panel. Panel state is remembered.
- Press **?** for all shortcuts.
- Canvas shortcuts also work while a button, slider, or dropdown has focus. Space plays or pauses and arrow keys move the view. Text fields and dialogs keep their normal keys; use arrow keys inside an exact-value field or scroll over a slider to fine-tune it.

Some parameter combinations produce a uniform field. That is a valid equilibrium. Choose a specimen or reseed to grow another pattern.

## GPU simulation

The simulation uses the Gray–Scott equations on a periodic grid. The default 1× grid is 512 × 320; 2× is 1024 × 640, 3× is 1536 × 960, and 4× is 2048 × 1280. A nine-point Laplacian weights the center −1, cardinal neighbors 0.2, and diagonal neighbors 0.05. Both engines use a time step of 1 and the same seeded chemical field.

- **WebGPU:** WGSL compute shaders alternate between two storage buffers. A fragment shader interpolates the field and applies the palette.
- **WebGL 2:** GLSL fragment shaders alternate between two RG32F framebuffer textures. This requires `EXT_color_buffer_float`.

Simulation and canvas rendering stay on the GPU. Seed creation, saving and restoring versions, and export processing use the CPU. Changing engines preserves the current chemical field when the old device is still readable. Changing base resolution resamples both chemicals across the wrapping edges and keeps the current view and brush size. Continuing the simulation on a larger grid can grow finer patterns; lowering resolution loses some detail. The view preserves pattern proportions and crops to fit its container; zoom and cropping do not change the chemistry.

Preview grown pattern adds a short accelerated growth phase. Turn it off to watch from the first seeds, or choose Start paused to inspect or paint before growing. New seed always starts fresh. Empty starts always pause. Browser visibility pauses GPU submissions.

Model reference: [Karl Sims' reaction–diffusion tutorial](https://www.karlsims.com/rd.html).

## Export

- **PNG:** 2048 × 1280 or 4096 × 2560 images of the full chemical field using the current colors and pattern weight. Output dimensions stay the same at every base resolution. The default grid uses smoothed 4× and 8× enlargements; higher base resolutions supply more simulation cells to the same output sizes.
- **SVG:** Real vector contours extracted with marching squares through `d3-contour`. Every blob is its own `<path>` inside a `pattern` group, with holes kept in the same path, so shapes stay selectable in Figma, Illustrator, or Inkscape. Contours are smoothed into cubic curves by default; untick **Smooth curves** for the raw marching-squares polygons. SVG is a two-color interpretation of the field, without the canvas's soft transitions.
- **Embed:** An `<iframe>` snippet that runs the simulation live on the viewer's GPU with the current recipe, colors, seed, and zoom. Choose an inline block or a full-page background, and whether visitors can paint.
- **Share link:** A URL that opens the lab in the current state.

Both image exports capture the full field, independent of viewport position or zoom. Neither includes the interface. Enlarging a PNG does not add simulation detail; a higher base resolution gives the evolving field more cells.

### URL parameters

The lab reads its state from the query string, which is what share links and embeds use.

| Parameter | Meaning |
| --- | --- |
| `p` | Specimen index, 0–6 |
| `f`, `k` | Feed and kill rates |
| `da`, `db` | Diffusion rates for A and B |
| `bg`, `fg` | Background and pattern colors as six-digit hex without `#` |
| `w` | Pattern weight threshold, 0.08–0.3 |
| `s` | Evolution speed, 1–48 steps per frame |
| `r` | Base resolution multiplier, 1, 2, 3, or 4; defaults to 1 |
| `seed` | Seed for the initial field |
| `start` | `empty`, `scatter`, `center`, `spot`, `ring`, `line`, `grid`, or `image` |
| `init_count`, `init_radius`, `init_amount` | Seed count, size in base-grid cells, and chemical B concentration |
| `init_x`, `init_y` | Starting position, each from 0 to 1 |
| `grown`, `paused` | Preview grown or start paused, each `0` or `1` |
| `image` | URL-safe Base64-encoded 128 × 80 binary image silhouette |
| `init_imageScale` | Image size relative to the field, 0.1–1 |
| `z` | Zoom, 0.25–6 |
| `embed` | Hide the interface entirely |
| `interact=0` | Disable painting and moving, for backgrounds |

`scripts/generate-presets.mjs` regenerates the static specimen thumbnails with an offline reference simulation:

```sh
node scripts/generate-presets.mjs
```

The interface loads DM Sans and IBM Plex Mono from Google Fonts, with local fallbacks if unavailable. No server, API keys, or account is required.
