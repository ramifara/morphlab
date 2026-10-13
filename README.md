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
- **Recipe** (left panel): change feed, kill, or either diffusion rate. Click a number to type an exact value, or scroll over a slider to nudge it one step at a time (Shift for ten). Tiny changes can produce very different worlds. Pick a palette or set your own two colors, then adjust pattern weight, evolution speed, base resolution, or compute engine. Base resolution offers every whole-number multiplier from 1× through 8×. Both grid dimensions scale, so 2× uses 4× as many cells and 8× uses 64×. Higher settings need more GPU work and memory and may run slower on some devices.
- **Starting field** (top of Recipe): choose empty, scattered dots, a cluster, a single spot, a ring, a line, a grid, or an image. Type a seed number from 0 to 4294967295. **Restart seed** repeats the same field with the current settings; **New seed** picks a new number and starts fresh. **Add seeds** adds chemical to the current pattern and preserves the rest of the field. **Clear canvas** clears and pauses so you can paint first. Expand **Size, amount & position** for seed count, size, chemical B concentration, corners, edges, and custom coordinates. The B amount also controls the paint brush; Feed controls the ongoing supply of A. Recipe selection keeps your chosen starting field; Surprise me returns to scattered dots.
- **Image starts**: choose **From an image**, upload a logo, drawing, or photo, then adjust the cutoff and choose dark or light areas. Transparent areas stay empty, and the image keeps its proportions. Restart plants the silhouette and pauses; press play to watch it grow. The silhouette is sampled at 128 × 80 and stays in saved versions, share links, and embeds. Reloading retains the silhouette; upload again to adjust its cutoff. Image processing happens locally in your browser.
- **Toolbar** (bottom): play, pause, step, paint, erase, move, brush size, zoom, and reseed.
- Drag on the canvas to paint chemical B. Hold Shift to erase. Scroll to move, hold ⌘ or Ctrl while scrolling to zoom, or pinch on a touch screen.
- The field wraps at its edges, so you can move across it endlessly in any direction and zoom out to see it tile.
- **Saved** (below the specimens): press ⌘S or Ctrl+S to save the current morph under a name, including live knob adjustments and painted changes, plus the recipe, colors, weight, speed, base resolution, seed, zoom, and position. The field is captured when you open Save current. Loading restores that exact field paused; press play to continue growing. Full-precision chemical fields live in your browser's IndexedDB, with recipe metadata and thumbnails in local storage. Older recipe-only saves still regrow from their seeds.
- **Windows** (bottom of Recipe): open a second Morph Lab window and drag it over this one. Where the windows overlap on your screen, the two patterns mix. See [Linked windows](#linked-windows).
- Press **H** to hide the whole interface and watch the pattern. Press **[** or **]** to toggle a single panel. Panel state is remembered.
- Press **?** for all shortcuts.
- Canvas shortcuts also work while a button, slider, or dropdown has focus. Space plays or pauses and arrow keys move the view. Text fields and dialogs keep their normal keys; use arrow keys inside an exact-value field or scroll over a slider to fine-tune it.

Some parameter combinations produce a uniform field. That is a valid equilibrium. Choose a specimen or reseed to grow another pattern.

## GPU simulation

The simulation uses the Gray–Scott equations on a periodic grid. The default 1× grid is 512 × 320. Each whole-number multiplier scales both dimensions, up to 4096 × 2560 at 8×. A nine-point Laplacian weights the center −1, cardinal neighbors 0.2, and diagonal neighbors 0.05. Both engines use a time step of 1 and the same seeded chemical field.

- **WebGPU:** WGSL compute shaders alternate between two storage buffers. A fragment shader interpolates the field and applies the palette.
- **WebGL 2:** GLSL fragment shaders alternate between two RG32F framebuffer textures. This requires `EXT_color_buffer_float`.

Simulation and canvas rendering stay on the GPU. Seed creation, saving and restoring versions, and export processing use the CPU. Changing engines preserves the current chemical field when the old device is still readable. Changing base resolution resamples both chemicals across the wrapping edges and keeps the current view and brush size. Continuing the simulation on a larger grid can grow finer patterns; lowering resolution loses some detail. The view preserves pattern proportions and crops to fit its container; zoom and cropping do not change the chemistry.

Preview grown pattern adds a short accelerated growth phase. Turn it off to watch from the first seeds, or choose Start paused to inspect or paint before growing. New seed always starts fresh. Empty starts always pause. Browser visibility pauses GPU submissions.

Model reference: [Karl Sims' reaction–diffusion tutorial](https://www.karlsims.com/rd.html).

## Linked windows

Every Morph Lab window knows where it sits on your screen. Open more than one from the same origin and they find each other. Where two windows overlap, each one treats the other's visible field as a neighbour and the chemistry reacts across the boundary. The overlap also takes on a blend of both windows' colors.

- **Open a linked window** (Recipe → Windows, or press **N**) opens a popup with another specimen, a fresh seed, and a different palette, offset so it overlaps right away. Drag it around; the mixing follows. You can open as many as your GPU enjoys. Any Morph Lab tab or window from the same site joins in.
- **When windows overlap** chooses how they mix. The choice is shared across all linked windows; the last change wins.
  - **Melt**: both fields flow into each other and fuse. Patterns merge into one.
  - **Crossbreed**: the overlap runs a blend of both recipes, so a third pattern grows at the junction.
  - **Siphon**: the front window (the one you touched last) drinks chemical from the one beneath, which is drained where it is covered.
  - **Carve**: each pattern erodes where the other has grown. Only the differences survive.
  - **Keep apart**: windows stay aware of each other but keep their chemistry to themselves.
- **Mixing strength** scales every mode.

Windows talk over a `BroadcastChannel`, so there is no server and nothing leaves your machine. Each window shares a 256 × 160 capture of its visible field about thirty times a second while an overlap exists. Mixing works at any zoom, position, or base resolution; the windows map each other through screen space. The browser must report window positions: this works on macOS, Windows, ChromeOS, and X11. Wayland hides window positions, so there the windows all think they sit at the same spot. Embeds never link.

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
| `r` | Whole-number base resolution multiplier, 1 through 8; defaults to 1 |
| `seed` | Seed for the initial field |
| `start` | `empty`, `scatter`, `center`, `spot`, `ring`, `line`, `grid`, or `image` |
| `init_count`, `init_radius`, `init_amount` | Seed count, size in base-grid cells, and chemical B concentration |
| `init_x`, `init_y` | Starting position, each from 0 to 1 |
| `grown`, `paused` | Preview grown or start paused, each `0` or `1` |
| `image` | URL-safe Base64-encoded 128 × 80 binary image silhouette |
| `mix` | How overlapping windows mix: `melt` (default), `cross`, `siphon`, `carve`, or `off` |
| `init_imageScale` | Image size relative to the field, 0.1–1 |
| `z` | Zoom, 0.25–6 |
| `embed` | Hide the interface entirely |
| `interact=0` | Disable painting and moving, for backgrounds |

`scripts/generate-presets.mjs` regenerates the static specimen thumbnails with an offline reference simulation:

```sh
node scripts/generate-presets.mjs
```

The interface loads DM Sans and IBM Plex Mono from Google Fonts, with local fallbacks if unavailable. No server, API keys, or account is required.

## 3D experiment

Click the **cube icon** immediately after the Morph Lab logo, or open `/?mode=3d`. Switching dimensions sweeps between canvases without reloading the page. Recipe and appearance controls stay in place. Each mode keeps its chemical field, resolution, playback state and view for the current session; entering a mode for the first time uses the current seed settings. The 3D workbench holds up to three spheres or boxes. The recipe, seed and appearance controls edit the selected object. Changing shape or restarting a seed affects that object.

- Feed, kill, diffusion, evolution speed, palettes, pattern weight, seed settings, painting, pause and single-step all operate on the volume.
- Drag with the hand tool to orbit. Scroll or pinch to zoom; arrows orbit and `0` resets the camera. Brush and eraser affect the object boundary or exposed cut plane. Use Cutaway to inspect and seed the interior.
- All seed modes work in 3D. Image seeds occupy a thin central Z slice. The seed preview shows that central slice before growth.
- Saved versions retain the full chemical volume, shape, camera and cutaway. The saved list shows only experiments for the current dimension. Share links and embeds retain the 3D recipe and view; PNG exports the current rendered view.

`engine3d.ts` and `engine3d-webgpu.ts` store 64³, 128³, 192³ or 256³ volumes in an atlas with eight columns of Z slices. Resolution changes use trilinear interpolation in XYZ to preserve the current chemical field. The ray-march step and lighting gradients adapt to the cell size. Both GPU backends use six face neighbors with equal weights and a no-flux boundary. A half-sized Euler time step prevents the instability seen with a full step at the maximum diffusion settings. The display ray-marches the chemical-B isosurface, with trilinear interpolation and gradient lighting. Auto prefers WebGPU and falls back to WebGL 2. The Compute engine menu also lets you choose either backend in 3D, preserving the field when changing engines. WebGPU dispatches WGSL compute workgroups in XYZ over two storage buffers; WebGL uses two RG32F framebuffer textures and requires `EXT_color_buffer_float`. Both use the same atlas layout for compatible snapshots.

Object size scales the sphere or box from 0.5× to 3× in the scene; Fit scene frames all objects. Show floor toggles the ground grid and its contact shadow. The complete scene, all object fields and recipes, positions, sizes, volume resolution and floor visibility are saved and included in share links. At 256³, the field has 16.8 million cells and its two GPU fields use 256 MiB; changing resolution and reading snapshots temporarily use additional memory. Failed allocations retain the previous field. The display resolution remains capped to bound rendering work. Recipes can behave differently from their 2D counterparts. Screen layering and SVG export remain 2D-only.

All select menus use the lab's styled listbox, including menus created inside the embed dialog. Arrow keys, Home/End and typing navigate options; Enter or Tab commits, Escape cancels, and pointer selection works on desktop and touch screens.

The GPU browser checks in `tests/volume-browser.ts` run on a secure preview with WebGPU and WebGL 2 available. From DevTools, import the module and call `checkVolumeBackends()` for numerical and rendering parity, and `checkVolumeResolution(size)` for each supported volume size. In an isolated 3D preview tab, `checkDimensionSwitches()` verifies field and view preservation without navigation, and `checkVolumeBackendSwitches()` verifies engine changes and an unavailable-adapter fallback. These checks create and destroy their temporary GPU resources; they are separate from the Node unit suite.

## Multiple objects and mesh export

Use **+ Sphere** or **+ Box** in the Object section, up to three objects. Select an object in the list to change its recipe, starting field, palette, weight, size or cutaway. **Move object** in the toolbar or `G` lets you drag a vessel in the camera plane. Object name labels remain draggable in every tool. Shift-drag or the **Depth** toggle moves toward or away from the camera; dragging the background orbits it. Arrow keys nudge a focused label, with Alt for Z and Shift for fine adjustments. The compact controls above playback expose interaction, strength and a shared cutaway. **Cut all** applies one world-space plane to every object; the adjacent scope icons switch between shared and independent cuts. Mixing and scope controls appear only with multiple objects; Keep apart hides strength. Scene controls have one home above playback, with movement and framing icons in the toolbar. X, Y and Z set its position directly. Hand / `V` orbits the shared camera. **Fit scene** includes all objects. Removing the first object retains the GPU device for the remaining objects.

The scene offers the same interaction modes as linked tabs: **Melt**, **Crossbreed**, **Siphon**, **Carve**, and **Keep apart**. Melt and Crossbreed render a combined density surface and blend object colors wherever fields meet, even while paused. Crossbreed also blends recipe parameters; Siphon transfers chemical B toward the selected object, and Carve erodes overlapping concentrations. Strength controls the coupling; zero isolates all objects. Every object samples the same previous iteration, so stepping order does not change the interaction. WebGPU shares one device and shader pipelines and dispatches the scene in one compute submission. Both backends share a depth buffer for correct occlusion. The resolution applies to every object; three 256³ objects use 768 MiB for their chemical fields alone. Scene snapshots preserve every field through saves, resolution and backend changes, and the 2D/3D switch. Share links recreate all scene recipes and positions from their seeds.

Choose **Export → 3D mesh** for binary STL or OBJ, either the selected object or the entire scene. Mesh resolution controls surface sampling independently of simulation resolution. The longest output dimension is adjustable from 10 to 500 mm. Geometry uses Z up, rests on Z = 0, and preserves the objects' relative positions and sizes. Cutaways are optional and capped. The mesh is built in a cancellable worker; the dialog reports triangles, disconnected shells, physical dimensions, file size and open/non-manifold edges before download. Empty fields produce no mesh. Exports are limited to 1.5 million triangles per object; lower mesh resolution if that limit is reached.

Surface extraction uses a padded scalar field intersected with the vessel and optional cut plane, then [marching tetrahedra](https://paulbourke.org/geometry/polygonise/). Binary STL follows the [documented triangle/normal layout](https://www.loc.gov/preservation/digital/formats/fdd/fdd000504.shtml). Closed surfaces are useful for slicing, but the tool does not assess wall thickness, support requirements, print strength or self-intersections. Entire-scene exports in Melt and Crossbreed extract the combined density surface shown in the scene. Other modes and selected-object exports preserve individual surfaces. A fused surface can still contain disconnected shells where the chemistry does not connect.

`tests/scene-browser.ts` checks the object cap, chemical coupling, isolation at a distance, scene restoration, removal and dragging on both GPU backends. `tests/mixing-browser.ts` checks fused rendering, all interaction modes, shared cuts and dragging on both GPU backends. Node tests cover scene recipe validation, complete scene storage, mesh topology, cut caps, winding, units, STL bytes and OBJ output.
