import './style.css';
import { icon, mark } from './icons';
import { palettes, presets, makeSeed, addSeeds, defaultStart, seedModes, seedCount, idleBrush, type SeedMode, type Parameters, type Brush, type Palette, type View } from './model';
import { readStart, writeStart, normalizeStart } from './start';
import { imageMask, IMAGE_WIDTH, IMAGE_HEIGHT } from './seed-image';
import { WebGPUEngine, WebGLEngine, type Engine } from './engine';
import { download, fieldToPNG, fieldToSVG, fieldToThumbnail } from './export';
import { createAppStore, type SavedPreset } from './store';
import { BASE_WIDTH, resolutions, parseResolution, gridSize, resizeField, type Resolution } from './resolution';
import { loadSnapshot, saveSnapshot, removeSnapshot, type MorphSnapshot } from './snapshots';

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const $$ = <T extends HTMLElement = HTMLElement>(selector: string) => Array.from(document.querySelectorAll<T>(selector));
const ZOOM_MIN = .25, ZOOM_MAX = 6;
let resolution: Resolution = 1;
let { width, height } = gridSize(resolution);
type Tool = 'brush' | 'eraser' | 'hand';

// ---------- State ----------
let params: Parameters = { feed: presets[0].feed, kill: presets[0].kill, diffusionA: 1, diffusionB: .5 };
let presetIndex = 0, paletteIndex = 0, palette: Palette = { ...palettes[0] }, seed = 42, running = true, speed = 16, threshold = .19, zoom = 1;
const pan: View = { x: 0, y: 0 };
let engine: Engine | null = null, iterations = 0, warmup = 0, switching = false, drawing = false, panning = false, tool: Tool = 'brush', brushSize = 14;
let loadRevision = 0;
let brush: Brush = { ...idleBrush }, pendingBrush: Brush | null = null, renderNeeded = true, exporting = false;

// ---------- URL state (share links and embeds) ----------
const query = new URLSearchParams(location.search);
const embed = query.has('embed');
const interactive = query.get('interact') !== '0';
const num = (key: string, fallback: number, min: number, max: number) => { const v = Number(query.get(key)); return query.has(key) && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback; };
const hex = (key: string, fallback: string) => { const v = query.get(key) ?? ''; return /^[0-9a-f]{6}$/i.test(v) ? `#${v.toLowerCase()}` : fallback; };
{
  resolution = parseResolution(query.get('r'));
  ({ width, height } = gridSize(resolution));
  presetIndex = Math.round(num('p', 0, 0, presets.length - 1));
  params = { feed: num('f', presets[presetIndex].feed, .005, .095), kill: num('k', presets[presetIndex].kill, .03, .075), diffusionA: num('da', 1, .1, 1), diffusionB: num('db', .5, .05, .8) };
  seed = Math.round(num('seed', 42, 0, 4294967295)); threshold = num('w', .19, .08, .3); speed = Math.round(num('s', 16, 1, 48)); zoom = num('z', 1, ZOOM_MIN, ZOOM_MAX);
  palette = { name: 'Custom', background: hex('bg', palettes[0].background), foreground: hex('fg', palettes[0].foreground) };
  paletteIndex = palettes.findIndex(p => p.background === palette.background && p.foreground === palette.foreground);
  if (paletteIndex >= 0) palette.name = palettes[paletteIndex].name;
}
let start = readStart(query, presets[presetIndex].seed);
let imagePixels: Uint8ClampedArray | null = null;
let imageRevision = 0, addingSeeds = false;
const startNames: Record<SeedMode, string> = { empty: 'Empty canvas', scatter: 'Scattered dots', center: 'Cluster', spot: 'Single spot', ring: 'Ring', line: 'Line', grid: 'Grid', image: 'From an image' };
function stateParams() {
  const q = new URLSearchParams();
  q.set('p', String(presetIndex)); q.set('f', params.feed.toFixed(4)); q.set('k', params.kill.toFixed(4)); q.set('da', params.diffusionA.toFixed(2)); q.set('db', params.diffusionB.toFixed(2));
  q.set('bg', palette.background.slice(1)); q.set('fg', palette.foreground.slice(1)); q.set('w', threshold.toFixed(3)); q.set('s', String(speed)); q.set('seed', String(seed));
  if (resolution !== 1) q.set('r', String(resolution));
  writeStart(q, start);
  if (zoom !== 1) q.set('z', zoom.toFixed(2));
  return q;
}
const shareURL = () => `${location.origin}${location.pathname}?${stateParams()}`;
function embedSnippet(mode: 'inline' | 'background', paint: boolean) {
  const q = stateParams(); q.set('embed', '1'); if (!paint) q.set('interact', '0');
  const src = `${location.origin}${location.pathname}?${q}`;
  const style = mode === 'background'
    ? `position:fixed;inset:0;width:100%;height:100%;border:0;z-index:-1;${paint ? '' : 'pointer-events:none;'}`
    : 'width:100%;aspect-ratio:16/10;border:0;border-radius:12px;display:block;';
  return `<iframe src="${src}"\n  title="Morph Lab reaction–diffusion pattern"\n  style="${style}"\n  loading="lazy" allow="fullscreen"></iframe>`;
}

// ---------- Persistent store: saved presets and interface preferences ----------
const compact = () => matchMedia('(max-width: 820px)').matches;
const store = createAppStore({ dockLeft: !compact(), dockRight: !compact() });
let hudVisible = !embed && store.getState().hud;
const docks = { left: store.getState().dockLeft, right: store.getState().dockRight };

// ---------- Markup ----------
const digits = (id: string) => (id === 'feed' || id === 'kill' ? 4 : 3);
const REACTION_KEYS = ['feed', 'kill', 'diffusionA', 'diffusionB'] as const;
function slider(id: string, label: string, symbol: string, value: number, min: number, max: number, step: number, hint = '') {
  return `<div class="field"><div class="field-head"><label for="${id}">${label}${symbol ? ` <i>${symbol}</i>` : ''}</label><input class="value" id="${id}-value" type="text" inputmode="decimal" value="${value.toFixed(digits(id))}" aria-label="${label} value" title="Type an exact value"/></div><input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}"/>${hint ? `<p class="field-hint">${hint}</p>` : ''}</div>`;
}
const section = (n: string, title: string, body: string, extra = '') =>
  `<details class="section" open><summary><span class="section-n">${n}</span><span class="section-title">${title}</span>${extra}${icon('chevron', 'section-chevron')}</summary><div class="section-body">${body}</div></details>`;
const menuItem = (id: string, label: string, note: string, type: string) => `<button id="${id}"><span>${label}<small>${note}</small></span><span class="file-type">${type}</span></button>`;
const startSlider = (key: string, label: string, min: number, max: number, step: number, value: number) => `<div class="field"><div class="field-head"><label for="start-${key}">${label}</label><output id="start-${key}-value" for="start-${key}"></output></div><input type="range" id="start-${key}" min="${min}" max="${max}" step="${step}" value="${value}"/></div>`;

$('#app').innerHTML = `
<div class="app" id="app-root" data-hud="${hudVisible ? 'on' : 'off'}" data-embed="${embed}" data-tool="${tool}">
  <div class="stage" id="canvas-stage">
    <canvas id="simulation" aria-label="Live reaction diffusion pattern. Drag to add chemical B. Hold Shift to erase."></canvas>
    <div class="stage-vignette"></div>
    <div class="brush-cursor" id="brush-cursor"></div>
    <div class="loading" id="loading"><span class="loader-orbit"></span><span id="loading-text">Waking up the chemistry…</span></div>
    <div class="hint" id="canvas-hint">${icon('brush')} Drag to paint <kbd>Shift</kbd> erase <kbd>Scroll</kbd> move <kbd>⌘ Scroll</kbd> zoom <kbd>H</kbd> hide interface</div>
  </div>

  <header class="hud hud-top">
    <a href="/" class="chip brand" aria-label="Morph Lab home"><span class="brand-mark">${mark}</span><span class="brand-text">MORPH<span>LAB</span></span></a>
    <div class="chip group"><button class="icon-button" id="toggle-left" title="Recipe panel · [" aria-label="Toggle recipe panel" aria-pressed="${docks.left}" aria-controls="dock-left">${icon('panelLeft')}</button></div>
    <div class="chip specimen"><span class="live-dot"></span><span id="specimen-name">Coral</span><span class="specimen-id" id="specimen-id">/ 001</span></div>
    <div class="hud-spacer"></div>
    <div class="chip group">
      <div class="export-wrap">
        <button id="export-toggle" class="text-button" aria-expanded="false" aria-controls="export-menu">${icon('download')}<span>Export</span></button>
        <div id="export-menu" class="menu panel" hidden>
          <span class="menu-heading">Image</span>
          ${menuItem('export-png', 'PNG · 2048 × 1280', 'Full field · current colors and weight', '.png')}
          ${menuItem('export-png-8', 'PNG · 4096 × 2560', 'Larger image for print', '.png')}
          <span class="menu-heading">Vector</span>
          ${menuItem('export-svg', 'SVG shapes', 'One editable path per blob, holes included', '.svg')}
          <label class="menu-option"><input type="checkbox" id="svg-smooth" checked/><span>Smooth curves</span></label>
          <span class="menu-heading">Live</span>
          ${menuItem('export-embed', 'Embed', 'Iframe that runs this exact recipe', 'html')}
          ${menuItem('export-link', 'Copy share link', 'Opens the lab in this state', 'url')}
        </div>
      </div>
      <span class="divider"></span>
      <button class="icon-button" id="fullscreen" title="Fullscreen · F" aria-label="Toggle fullscreen">${icon('expand')}</button>
      <button class="icon-button" id="about" title="The science" aria-label="About the model">${icon('info')}</button>
      <button class="icon-button" id="hud-hide" title="Hide interface · H" aria-label="Hide interface">${icon('eyeOff')}</button>
      <span class="divider"></span>
      <button class="icon-button" id="toggle-right" title="Specimens panel · ]" aria-label="Toggle specimens panel" aria-pressed="${docks.right}" aria-controls="dock-right">${icon('panelRight')}</button>
    </div>
  </header>

  <aside class="hud dock dock-left panel" id="dock-left" data-open="${docks.left}" aria-label="Recipe">
    <div class="dock-head"><span class="dock-title">${icon('sliders')} Recipe</span><button class="icon-button small" id="reset-params" title="Reset recipe" aria-label="Reset recipe">${icon('reset')}</button><button class="icon-button small dock-close" data-close="left" aria-label="Close panel">${icon('close')}</button></div>
    <div class="dock-scroll">
      ${section('01', 'Starting field',
        `<label class="select-field start-mode" for="start-mode"><span>Start with</span><span class="select-wrap"><select id="start-mode">${seedModes.map(mode => `<option value="${mode}">${startNames[mode]}</option>`).join('')}</select>${icon('chevron')}</span></label>
         <div class="start-preview"><canvas id="start-preview" width="256" height="160" aria-label="Preview of the starting chemical field"></canvas><span id="start-preview-note">Initial field</span></div>
         <div class="start-image" id="start-image" hidden>
           <label class="image-upload" for="seed-image">${icon('plus')}<span id="image-name">Choose an image</span><input id="seed-image" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif"/></label>
           <p class="field-hint">Logos and bold shapes work well. Transparent areas stay empty. Images stay in your browser.</p>
           <div id="image-cutoff-controls" hidden>${startSlider('cutoff', 'Image cutoff', 0, 1, .01, .5)}<label class="check-field"><input id="image-light" type="checkbox"/><span>Seed light areas</span></label></div>
         </div>
         <div id="start-seeded">
           <label class="seed-number" for="seed-number"><span>Seed number</span><input id="seed-number" type="text" inputmode="numeric" pattern="[0-9]+" value="${seed}" aria-describedby="seed-number-hint"/></label>
           <p class="field-hint" id="seed-number-hint">Same number and settings, same starting field.</p>
         </div>
         <details class="start-tuning"><summary>Size, amount & position ${icon('chevron')}</summary>
         <div id="start-dots"><div id="start-count-field">${startSlider('count', 'Seed count', 1, 1000, 1, start.count)}</div>${startSlider('radius', 'Seed size', 1, 30, 1, start.radius)}</div>
         <div id="start-image-size">${startSlider('imageScale', 'Image size', .1, 1, .01, start.imageScale)}</div>
         ${startSlider('amount', 'Chemical B amount', .05, .8, .01, start.amount)}
         <p class="field-hint">Used by seeds and the paint brush. Feed below controls the ongoing reaction.</p>
         <div id="start-position"><label class="select-field" for="start-position-preset"><span>Position in the field</span><span class="select-wrap"><select id="start-position-preset"><option value=".5,.5">Center</option><option value=".08,.08">Top left</option><option value=".92,.08">Top right</option><option value=".08,.92">Bottom left</option><option value=".92,.92">Bottom right</option><option value=".5,.08">Top edge</option><option value=".5,.92">Bottom edge</option><option value=".08,.5">Left edge</option><option value=".92,.5">Right edge</option><option value="custom">Custom</option></select>${icon('chevron')}</span></label><div class="pair">${startSlider('x', 'Horizontal', 0, 1, .01, start.x)}${startSlider('y', 'Vertical', 0, 1, .01, start.y)}</div></div>
         </details>
         <div id="start-playback"><label class="check-field"><input id="start-grown" type="checkbox"/><span>Preview grown pattern</span></label><label class="check-field"><input id="start-paused" type="checkbox"/><span>Start paused</span></label></div>
         <div class="start-actions"><button class="primary-button" id="restart-seed">${icon('reset')}<span>Restart seed</span></button><button class="text-button" id="new-seed">${icon('shuffle')} New seed</button><button class="text-button" id="add-seeds">${icon('plus')} Add seeds</button><button class="text-button" id="clear-field">${icon('eraser')} Clear canvas</button></div>
         <p class="field-hint" id="start-hint">Changes apply when you restart or add seeds.</p>`)}
      ${section('02', 'Reaction',
        slider('feed', 'Feed', 'f', params.feed, .005, .095, .0001, 'How much chemical A enters the system.') +
        slider('kill', 'Kill', 'k', params.kill, .03, .075, .0001, 'How quickly chemical B fades away.') +
        `<div class="pair">${slider('diffusionA', 'Diffusion A', '', params.diffusionA, .1, 1, .001)}${slider('diffusionB', 'Diffusion B', '', params.diffusionB, .05, .8, .001)}</div>`,
        `<button class="help-button" id="reaction-help" aria-label="About reaction parameters">${icon('info')}</button>`)}
      ${section('03', 'Appearance',
        `<div class="palettes" role="group" aria-label="Color palette">${palettes.map((p, i) => `<button class="palette" data-palette="${i}" title="${p.name}" aria-label="${p.name} palette" aria-pressed="false" style="--swatch-bg:${p.background};--swatch-fg:${p.foreground}"><span></span></button>`).join('')}</div>
         <div class="colors">
           <label class="color-field"><input type="color" id="color-bg" value="${palette.background}" aria-label="Background color"/><span class="color-swatch" id="swatch-bg"></span><span class="color-meta"><span>Background</span><code id="color-bg-hex">${palette.background}</code></span></label>
           <button class="icon-button small" id="swap-colors" title="Swap colors · X" aria-label="Swap colors">${icon('swap')}</button>
           <label class="color-field"><input type="color" id="color-fg" value="${palette.foreground}" aria-label="Pattern color"/><span class="color-swatch" id="swatch-fg"></span><span class="color-meta"><span>Pattern</span><code id="color-fg-hex">${palette.foreground}</code></span></label>
         </div>
         <div class="field compact"><div class="field-head"><label for="threshold">Pattern weight</label><output for="threshold" id="threshold-value">50%</output></div><input type="range" id="threshold" min="0.08" max="0.3" step="0.005" value="${threshold}"/></div>`,
        `<span class="section-note" id="palette-name">${palette.name}</span>`)}
      ${section('04', 'Simulation',
        `<div class="field compact"><div class="field-head"><label for="speed">Evolution speed</label><output for="speed" id="speed-value">1×</output></div><input type="range" id="speed" min="1" max="48" step="1" value="${speed}"/><div class="range-labels"><span>Unhurried</span><span>Impatient</span></div></div>
         <label class="select-field" for="resolution"><span>Base resolution</span><span class="select-wrap"><select id="resolution" aria-describedby="resolution-hint">${resolutions.map(r => { const size = gridSize(r); return `<option value="${r}" ${r === resolution ? 'selected' : ''}>${r}× · ${size.width} × ${size.height}${r === 1 ? ' · Default' : ''}</option>`; }).join('')}</select>${icon('chevron')}</span></label>
         <p class="field-hint resolution-hint" id="resolution-hint" aria-live="polite"></p>
         <label class="select-field" for="backend"><span>Compute engine</span><span class="select-wrap"><select id="backend"><option value="auto">Auto</option><option value="webgpu">WebGPU</option><option value="webgl">WebGL 2</option></select>${icon('chevron')}</span></label>`)}
    </div>
  </aside>

  <aside class="hud dock dock-right panel" id="dock-right" data-open="${docks.right}" aria-label="Specimens">
    <div class="dock-head"><span class="dock-title">${icon('layers')} Specimens</span><span class="dock-note">1–${presets.length}</span><button class="icon-button small dock-close" data-close="right" aria-label="Close panel">${icon('close')}</button></div>
    <div class="dock-scroll">
      <div class="presets">${presets.map((p, i) => `<button class="preset" data-preset="${i}" aria-pressed="false"><span class="preset-art" style="background-image:url('${p.art ?? `/presets/${p.name.toLowerCase()}.svg`}')"></span><span class="preset-info"><span class="preset-name">${p.name}</span><small>${p.subtitle}</small><code>f ${p.feed.toFixed(4)} · k ${p.kill.toFixed(4)}</code></span><span class="preset-n">0${i + 1}</span></button>`).join('')}</div>
      <button class="surprise-button" id="surprise">${icon('shuffle')} Surprise me <kbd>S</kbd></button>
      <div class="saved-head"><span class="saved-title">${icon('bookmark')} Saved <span class="saved-count" id="saved-count"></span></span><button class="text-button small" id="save-preset" title="Save current version · ⌘S">${icon('plus')}<span>Save current</span></button></div>
      <div class="presets saved" id="saved-list"></div>
      <p class="dock-footnote">The field wraps at its edges, so you can move around it forever. Some recipes settle into a flat color. That is a valid equilibrium. Reseed or pick a specimen to grow again.</p>
    </div>
  </aside>

  <div class="hud hud-bottom">
    <div class="chip status" id="status"><span class="status-dot"></span><span id="engine-status">Connecting to GPU</span><span class="sep"></span><span id="fps">— fps</span><span class="sep"></span><span><span id="iteration-count">0</span> iter</span><span class="sep"></span><span id="grid-size">${width} × ${height}</span></div>
    <div class="chip toolbar" role="toolbar" aria-label="Canvas tools">
      <button id="play" class="icon-button primary" aria-label="Pause simulation" title="Pause · Space">${icon('pause')}</button>
      <button id="step" class="icon-button" aria-label="Advance one step" title="Advance one step">${icon('step')}</button>
      <span class="divider"></span>
      <button class="icon-button" data-tool="brush" title="Paint · B" aria-label="Paint chemical" aria-pressed="false">${icon('brush')}</button>
      <button class="icon-button" data-tool="eraser" title="Erase · E" aria-label="Erase chemical" aria-pressed="false">${icon('eraser')}</button>
      <button class="icon-button" data-tool="hand" title="Move around · V" aria-label="Move around" aria-pressed="false">${icon('hand')}</button>
      <label class="brush-size" title="Brush size · , and ."><input id="brush-size" aria-label="Brush size" type="range" min="3" max="45" value="14"/></label>
      <span class="divider"></span>
      <button id="zoom-out" class="icon-button" aria-label="Zoom out" title="Zoom out · −">${icon('minus')}</button>
      <button id="zoom-reset" class="zoom-label" title="Reset view · 0">100%</button>
      <button id="zoom-in" class="icon-button" aria-label="Zoom in" title="Zoom in · +">${icon('plus')}</button>
      <span class="divider"></span>
      <button id="reseed" class="icon-button" title="Reseed · R" aria-label="Grow a new arrangement">${icon('reset')}</button>
    </div>
    <button class="chip icon-button shortcuts" id="shortcuts" title="Keyboard shortcuts · ?" aria-label="Keyboard shortcuts">${icon('keyboard')}</button>
  </div>

  <button class="hud-reveal chip" id="hud-show" title="Show interface · H">${icon('eye')}<span>Interface</span><kbd>H</kbd></button>

  <div class="toast" id="toast" role="status" aria-live="polite"></div>
  <dialog id="info-dialog" class="panel"><div class="dialog-heading"><span class="eyebrow">Field notes / Morph Lab</span><button class="icon-button" id="close-dialog" aria-label="Close dialog">${icon('close')}</button></div><div id="dialog-content"></div></dialog>
</div>`;

// ---------- Interface state ----------
const root = $('#app-root');
let toastTimer: ReturnType<typeof setTimeout>;
function toast(message: string) { $('#toast').textContent = message; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 3200); }

function setHud(visible: boolean) {
  if (embed) return;
  hudVisible = visible; root.dataset.hud = visible ? 'on' : 'off'; store.getState().setUI({ hud: visible });
  if (!visible) closeExport();
}
function setDock(side: 'left' | 'right', open: boolean) {
  docks[side] = open; store.getState().setUI(side === 'left' ? { dockLeft: open } : { dockRight: open });
  $(`#dock-${side}`).dataset.open = String(open); $(`#toggle-${side}`).setAttribute('aria-pressed', String(open));
  // One sheet at a time on small screens.
  if (open && compact()) { const other = side === 'left' ? 'right' : 'left'; if (docks[other]) setDock(other, false); }
}
$('#hud-hide').addEventListener('click', () => setHud(false));
$('#hud-show').addEventListener('click', () => setHud(true));
$('#toggle-left').addEventListener('click', () => setDock('left', !docks.left));
$('#toggle-right').addEventListener('click', () => setDock('right', !docks.right));
$$('[data-close]').forEach(el => el.addEventListener('click', () => setDock(el.dataset.close as 'left' | 'right', false)));

// ---------- Parameters ----------
const matchesPreset = () => { const p = presets[presetIndex]; return params.feed === p.feed && params.kill === p.kill && params.diffusionA === 1 && params.diffusionB === .5; };
const matchesSaved = (p: SavedPreset) => p.feed === params.feed && p.kill === params.kill && p.diffusionA === params.diffusionA && p.diffusionB === params.diffusionB && p.background === palette.background && p.foreground === palette.foreground && p.threshold === threshold && p.speed === speed && parseResolution(p.resolution) === resolution;
function updateSpecimenLabel() {
  const exact = matchesPreset(); const saved = store.getState().saved.find(matchesSaved);
  $('#specimen-name').textContent = exact ? presets[presetIndex].name : saved ? saved.name : 'Your experiment';
  $('#specimen-id').textContent = exact ? `/ 00${presetIndex + 1}` : saved ? '/ saved' : '/ ---';
  $$('.preset[data-preset]').forEach(el => { const active = exact && Number(el.dataset.preset) === presetIndex; el.classList.toggle('active', active); el.setAttribute('aria-pressed', String(active)); });
  $$('.preset[data-saved]').forEach(el => { const active = saved?.id === el.dataset.saved; el.classList.toggle('active', active); el.setAttribute('aria-pressed', String(active)); });
}
function updateSliders() {
  for (const [key, value] of Object.entries(params)) { const el = $<HTMLInputElement>(`#${key}`); el.value = String(value); $<HTMLInputElement>(`#${key}-value`).value = value.toFixed(digits(key)); }
  $$<HTMLInputElement>('input[type=range]').forEach(updateRange);
}
/** Snap a value to the slider's range and step. */
function clampToRange(el: HTMLInputElement, value: number) {
  const min = Number(el.min), max = Number(el.max), step = Number(el.step) || 1;
  return Math.min(max, Math.max(min, Math.round((value - min) / step) * step + min));
}
function setParam(key: keyof Parameters, value: number) {
  if (!Number.isFinite(value)) { updateSliders(); return; }
  params[key] = Number(clampToRange($<HTMLInputElement>(`#${key}`), value).toFixed(6)); updateSliders(); updateSpecimenLabel();
}
// Typed values: commit on Enter or blur, nudge with arrow keys (Shift for ten steps).
for (const key of REACTION_KEYS) {
  const field = $<HTMLInputElement>(`#${key}-value`); const range = $<HTMLInputElement>(`#${key}`);
  field.addEventListener('change', () => setParam(key, parseFloat(field.value.replace(',', '.'))));
  field.addEventListener('focus', () => field.select());
  field.addEventListener('keydown', e => {
    if (e.key === 'Enter') { field.blur(); return; }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault(); setParam(key, params[key] + (e.key === 'ArrowUp' ? 1 : -1) * Number(range.step) * (e.shiftKey ? 10 : 1));
  });
}
// Scrolling over any slider nudges it by one step; Shift scrolls ten.
$$<HTMLInputElement>('input[type=range]').forEach(el => el.addEventListener('wheel', e => {
  e.preventDefault(); const dir = e.deltaY < 0 ? 1 : -1; const next = clampToRange(el, Number(el.value) + dir * (Number(el.step) || 1) * (e.shiftKey ? 10 : 1));
  if (next === Number(el.value)) return; el.value = String(next); el.dispatchEvent(new Event('input', { bubbles: true }));
}, { passive: false }));
function updateRange(el: HTMLInputElement) { el.style.setProperty('--fill', `${(Number(el.value) - Number(el.min)) / (Number(el.max) - Number(el.min)) * 100}%`); }
$$<HTMLInputElement>('input[type=range]').forEach(el => { updateRange(el); el.addEventListener('input', () => updateRange(el)); });
for (const key of Object.keys(params) as (keyof Parameters)[]) $(`#${key}`).addEventListener('input', e => {
  params[key] = Number((e.target as HTMLInputElement).value); updateSliders(); updateSpecimenLabel();
});

function reseed(prepare = start.grown) {
  if (!engine || switching || exporting) return;
  loadRevision++;
  engine.seed(makeStartField()); iterations = 0; warmup = prepare && !start.paused && start.mode !== 'empty' ? 1200 : 0; renderNeeded = true;
  drawing = false; pendingBrush = null; brush = { ...idleBrush };
  $('#iteration-count').textContent = '0'; setRunning(start.mode !== 'empty' && !start.paused);
}
function makeStartField(settings = start, seedNumber = seed, targetWidth = width, targetHeight = height) {
  const scale = targetWidth / BASE_WIDTH;
  return makeSeed(targetWidth, targetHeight, seedNumber, settings.mode, { ...settings, radius: settings.radius * scale, spread: 26 * scale });
}
function setPreset(index: number, randomSeed = false) {
  if (switching || exporting) return;
  imageRevision++;
  presetIndex = index; const preset = presets[index];
  params = { feed: preset.feed, kill: preset.kill, diffusionA: 1, diffusionB: .5 }; if (randomSeed) seed = Math.floor(Math.random() * 1e9);
  updateSliders(); updateSpecimenLabel();
  if (preset.look) {
    // A specimen can carry the look that makes it read well, not just the chemistry.
    const { look } = preset; if (look.background && look.foreground) setColors(look.background, look.foreground);
    if (look.threshold !== undefined) { threshold = look.threshold; const el = $<HTMLInputElement>('#threshold'); el.value = String(threshold); updateRange(el); updateThresholdLabel(); }
    if (look.speed !== undefined) { speed = look.speed; const el = $<HTMLInputElement>('#speed'); el.value = String(speed); updateRange(el); updateSpeedLabel(); }
    if (look.zoom !== undefined) { setZoom(look.zoom); setPan(0, 0); }
  }
  updateStart(); reseed();
}
$$('[data-preset]').forEach(el => el.addEventListener('click', () => setPreset(Number(el.dataset.preset))));
$('#reset-params').addEventListener('click', () => { setPreset(presetIndex); toast('Recipe restored.'); });
$('#reseed').addEventListener('click', () => $('#new-seed').click());
$('#surprise').addEventListener('click', () => {
  if (switching || exporting) return;
  start = defaultStart('scatter');
  setPreset((presetIndex + 1 + Math.floor(Math.random() * (presets.length - 1))) % presets.length, true);
  setPalette(Math.floor(Math.random() * palettes.length)); setRunning(true); toast(`${presets[presetIndex].name} in ${palette.name.toLowerCase()}.`);
});

// ---------- Starting field ----------
function drawStartPreview() {
  const canvas = $<HTMLCanvasElement>('#start-preview'), context = canvas.getContext('2d')!;
  const field = makeStartField();
  const image = context.createImageData(canvas.width, canvas.height);
  const color = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const background = color(palette.background), foreground = color(palette.foreground);
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    const b = field[(Math.floor(y / canvas.height * height) * width + Math.floor(x / canvas.width * width)) * 2 + 1];
    const offset = (y * canvas.width + x) * 4;
    for (let channel = 0; channel < 3; channel++) image.data[offset + channel] = b > 0 ? foreground[channel] : background[channel];
    image.data[offset + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  $('#start-preview-note').textContent = start.mode === 'empty' ? 'Empty · paint to begin' : start.mode === 'image' && !start.imageMask ? 'Choose an image to begin' : 'Initial field · before growth';
}
function updateStart() {
  $<HTMLSelectElement>('#start-mode').value = start.mode;
  $<HTMLInputElement>('#seed-number').value = String(seed);
  const empty = start.mode === 'empty', image = start.mode === 'image';
  $('#start-seeded').hidden = empty; $('#start-dots').hidden = image || empty;
  $('#start-image-size').hidden = !image;
  $('#start-count-field').hidden = start.mode === 'spot';
  $('#start-position').hidden = empty || start.mode === 'scatter' || start.mode === 'grid';
  $('#start-image').hidden = !image;
  $('#image-cutoff-controls').hidden = !imagePixels;
  $('#image-name').textContent = start.imageMask ? 'Replace image' : 'Choose an image';
  $('#start-playback').hidden = empty;
  $<HTMLInputElement>('#start-grown').checked = start.grown;
  $<HTMLInputElement>('#start-paused').checked = start.paused;
  $<HTMLInputElement>('#start-grown').disabled = start.paused;
  $<HTMLButtonElement>('#restart-seed').disabled = image && !start.imageMask;
  $('#restart-seed span').textContent = empty ? 'Start empty' : 'Restart seed';
  $<HTMLButtonElement>('#new-seed').disabled = empty || (image && !start.imageMask);
  $<HTMLButtonElement>('#add-seeds').disabled = empty || addingSeeds || (image && !start.imageMask);
  $('#start-hint').textContent = empty ? 'Start empty clears and pauses. Paint, then press play. You can also choose a shape and add seeds.' : 'Restart replaces the field. Add seeds keeps the current pattern. Changes apply with either button.';
  for (const key of ['count', 'radius', 'amount', 'x', 'y', 'imageScale'] as const) {
    const el = $<HTMLInputElement>(`#start-${key}`); el.value = String(start[key]); updateRange(el);
    $(`#start-${key}-value`).textContent = key === 'count' ? String(start[key]) : key === 'radius' ? `${start[key]} cells` : `${Math.round(start[key] * 100)}%`;
  }
  const position = $<HTMLSelectElement>('#start-position-preset');
  position.value = [...position.options].find(option => option.value !== 'custom' && option.value.split(',').map(Number).every((n, i) => n === (i === 0 ? start.x : start.y)))?.value ?? 'custom';
  drawStartPreview();
}
function readyToStart() {
  if (!engine || switching || exporting) { toast('Wait for the simulation to be ready, then try again.'); return false; }
  if (start.mode === 'image' && !start.imageMask) { toast('Choose an image first.'); return false; }
  return true;
}
$('#start-mode').addEventListener('change', e => {
  loadRevision++; imageRevision++;
  start.mode = (e.target as HTMLSelectElement).value as SeedMode; start.count = seedCount(start.mode);
  if (start.mode === 'image') { start.grown = false; start.paused = true; }
  updateStart();
});
$('#seed-number').addEventListener('change', e => {
  const input = e.target as HTMLInputElement, value = Number(input.value);
  if (!/^\d+$/.test(input.value) || !Number.isSafeInteger(value) || value > 4294967295) {
    input.value = String(seed); toast('Use a whole seed number from 0 to 4294967295.'); return;
  }
  seed = value; loadRevision++; drawStartPreview();
});
for (const key of ['count', 'radius', 'amount', 'x', 'y', 'imageScale'] as const) $(`#start-${key}`).addEventListener('input', e => {
  loadRevision++; start[key] = Number((e.target as HTMLInputElement).value); updateStart();
});
$('#start-position-preset').addEventListener('change', e => {
  const value = (e.target as HTMLSelectElement).value;
  if (value === 'custom') return;
  loadRevision++; [start.x, start.y] = value.split(',').map(Number); updateStart();
});
$('#start-grown').addEventListener('change', e => { start.grown = (e.target as HTMLInputElement).checked; });
$('#start-paused').addEventListener('change', e => {
  start.paused = (e.target as HTMLInputElement).checked;
  if (start.paused) start.grown = false;
  updateStart();
});
$('#restart-seed').addEventListener('click', () => {
  if (!readyToStart()) return;
  reseed(); toast(start.mode === 'empty' ? 'Empty canvas. Paint or add seeds, then press play.' : `Seed ${seed} restarted${start.paused ? '. Press play to grow.' : '.'}`);
});
$('#new-seed').addEventListener('click', () => {
  if (!readyToStart() || start.mode === 'empty') return;
  seed = crypto.getRandomValues(new Uint32Array(1))[0]; updateStart(); reseed(false); toast(`New seed ${seed}.`);
});
$('#clear-field').addEventListener('click', () => {
  if (!engine || switching || exporting) return;
  imageRevision++; start.mode = 'empty'; updateStart(); reseed(false); setTool('brush'); toast('Canvas cleared and paused. Paint to begin.');
});
$('#add-seeds').addEventListener('click', async () => {
  if (!readyToStart() || start.mode === 'empty') return;
  const target = engine!, revision = ++loadRevision, settings = { ...start }, seedNumber = seed;
  exporting = true; addingSeeds = true; updateStart();
  try {
    const field = await target.read();
    if (revision !== loadRevision || engine !== target || switching) return;
    target.seed(addSeeds(field, makeStartField(settings, seedNumber)));
    warmup = 0; drawing = false; pendingBrush = null; brush = { ...idleBrush }; renderNeeded = true;
    toast(running ? 'Seeds added to the current pattern.' : 'Seeds added. Press play to grow.');
  } catch (error) { console.error(error); toast('Could not add seeds. Try again.'); }
  finally { exporting = false; addingSeeds = false; updateStart(); }
});
function updateImageMask() {
  if (!imagePixels) return;
  const cutoff = Number($<HTMLInputElement>('#start-cutoff').value);
  $('#start-cutoff-value').textContent = `${Math.round(cutoff * 100)}%`;
  start.imageMask = imageMask(imagePixels, cutoff, $<HTMLInputElement>('#image-light').checked);
  loadRevision++; updateStart();
}
$('#start-cutoff').addEventListener('input', updateImageMask);
$('#image-light').addEventListener('change', updateImageMask);
$('#seed-image').addEventListener('change', async e => {
  const input = e.target as HTMLInputElement, file = input.files?.[0];
  if (!file) return;
  const revision = ++imageRevision, url = URL.createObjectURL(file);
  try {
    const image = new Image(); image.src = url; await image.decode();
    if (revision !== imageRevision) return;
    const canvas = document.createElement('canvas'); canvas.width = IMAGE_WIDTH; canvas.height = IMAGE_HEIGHT;
    const context = canvas.getContext('2d')!;
    const scale = Math.min(IMAGE_WIDTH / image.naturalWidth, IMAGE_HEIGHT / image.naturalHeight);
    const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
    context.drawImage(image, (IMAGE_WIDTH - width) / 2, (IMAGE_HEIGHT - height) / 2, width, height);
    imagePixels = context.getImageData(0, 0, IMAGE_WIDTH, IMAGE_HEIGHT).data;
    start.mode = 'image'; start.grown = false; start.paused = true;
    updateImageMask(); toast('Image ready. Adjust the cutoff, then restart or add it to the field.');
  } catch (error) { console.error(error); toast('Could not read this image. Try a PNG, JPEG, or WebP.'); }
  finally { URL.revokeObjectURL(url); input.value = ''; }
});

// ---------- Colors ----------
const isLight = (color: string) => { const [r, g, b] = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16)); return (r * .299 + g * .587 + b * .114) > 150; };
function applyPalette() {
  renderNeeded = true; root.dataset.light = String(isLight(palette.background));
  $('#palette-name').textContent = palette.name;
  $<HTMLInputElement>('#color-bg').value = palette.background; $<HTMLInputElement>('#color-fg').value = palette.foreground;
  $('#swatch-bg').style.background = palette.background; $('#swatch-fg').style.background = palette.foreground;
  $('#color-bg-hex').textContent = palette.background; $('#color-fg-hex').textContent = palette.foreground;
  $$('.palette').forEach(el => { const active = Number(el.dataset.palette) === paletteIndex; el.classList.toggle('active', active); el.setAttribute('aria-pressed', String(active)); });
  updateSpecimenLabel();
  drawStartPreview();
}
function setPalette(index: number) { paletteIndex = (index + palettes.length) % palettes.length; palette = { ...palettes[paletteIndex] }; applyPalette(); }
function setColors(background: string, foreground: string) {
  paletteIndex = palettes.findIndex(p => p.background === background && p.foreground === foreground);
  palette = { name: paletteIndex >= 0 ? palettes[paletteIndex].name : 'Custom', background, foreground }; applyPalette();
}
$$('[data-palette]').forEach(el => el.addEventListener('click', () => setPalette(Number(el.dataset.palette))));
$('#color-bg').addEventListener('input', e => setColors((e.target as HTMLInputElement).value, palette.foreground));
$('#color-fg').addEventListener('input', e => setColors(palette.background, (e.target as HTMLInputElement).value));
$('#swap-colors').addEventListener('click', () => setColors(palette.foreground, palette.background));
$('#threshold').addEventListener('input', e => { threshold = Number((e.target as HTMLInputElement).value); updateThresholdLabel(); renderNeeded = true; updateSpecimenLabel(); });
const updateThresholdLabel = () => { $('#threshold-value').textContent = `${Math.round((.3 - threshold) / .22 * 100)}%`; };
$('#speed').addEventListener('input', e => { speed = Number((e.target as HTMLInputElement).value); updateSpeedLabel(); updateSpecimenLabel(); });
const updateSpeedLabel = () => { $('#speed-value').textContent = `${(speed / 16).toFixed(speed % 16 === 0 ? 0 : 1)}×`; };

// ---------- Playback, tools, view ----------
function setRunning(value: boolean) {
  running = value; $('#play').innerHTML = icon(running ? 'pause' : 'play'); $('#play').setAttribute('aria-label', running ? 'Pause simulation' : 'Play simulation');
  $('#play').title = `${running ? 'Pause' : 'Play'} · Space`; $('.live-dot').classList.toggle('paused', !running); $('#status').classList.toggle('paused', !running);
  if (!running) $('#fps').textContent = 'paused';
}
$('#play').addEventListener('click', () => setRunning(!running));
$('#step').addEventListener('click', () => { if (!engine || switching || exporting) return; setRunning(false); warmup = 0; engine.step(params, 1); iterations++; renderNeeded = true; $('#iteration-count').textContent = iterations.toLocaleString('en-US'); });
function setTool(value: Tool) { tool = value; root.dataset.tool = tool; $$('[data-tool]').forEach(el => { const active = el.dataset.tool === tool; el.classList.toggle('active', active); el.setAttribute('aria-pressed', String(active)); }); }
$$('[data-tool]').forEach(el => el.addEventListener('click', () => setTool(el.dataset.tool as Tool)));
function setBrushSize(value: number) { brushSize = Math.max(3, Math.min(45, Math.round(value))); const el = $<HTMLInputElement>('#brush-size'); el.value = String(brushSize); updateRange(el); }
$('#brush-size').addEventListener('input', e => { brushSize = Number((e.target as HTMLInputElement).value); });

/** Grid cells per CSS pixel at the current zoom. The view preserves the field's proportions, so one number covers both axes. */
function cellsPerPixel() { const rect = $('#simulation').getBoundingClientRect(); const aspect = rect.width / rect.height / (width / height); return Math.min(1, aspect) / zoom * width / rect.width; }
/** Unwrapped grid coordinate under a client point. */
function toGrid(clientX: number, clientY: number): View {
  const rect = $('#simulation').getBoundingClientRect(); const aspect = rect.width / rect.height / (width / height);
  return { x: (((clientX - rect.left) / rect.width - .5) * Math.min(1, aspect) / zoom + .5) * width + pan.x, y: (((clientY - rect.top) / rect.height - .5) * Math.min(1, 1 / aspect) / zoom + .5) * height + pan.y };
}
const wrap = (v: number, size: number) => ((v % size) + size) % size;
function setPan(x: number, y: number) { pan.x = wrap(x, width); pan.y = wrap(y, height); renderNeeded = true; }
function setZoom(value: number, anchor?: { clientX: number; clientY: number }) {
  const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(value * 100) / 100));
  const before = anchor ? toGrid(anchor.clientX, anchor.clientY) : null;
  zoom = next;
  if (before && anchor) { const after = toGrid(anchor.clientX, anchor.clientY); setPan(pan.x + before.x - after.x, pan.y + before.y - after.y); }
  $('#zoom-reset').textContent = `${Math.round(zoom * 100)}%`; renderNeeded = true;
}
function resetView() { setZoom(1); setPan(0, 0); }
const zoomStep = (dir: number) => setZoom(zoom * (dir > 0 ? 1.25 : .8));
$('#zoom-out').addEventListener('click', () => zoomStep(-1)); $('#zoom-in').addEventListener('click', () => zoomStep(1)); $('#zoom-reset').addEventListener('click', resetView);
async function toggleFullscreen() {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await root.requestFullscreen(); }
  catch { toast('Fullscreen is not available in this browser.'); }
}
$('#fullscreen').addEventListener('click', () => void toggleFullscreen());

// ---------- Canvas input ----------
const pointers = new Map<number, { x: number; y: number }>();
let pinch: { distance: number; zoom: number; center: View } | null = null;
let last: { x: number; y: number } | null = null;
function attachCanvas() {
  const canvas = $<HTMLCanvasElement>('#simulation');
  const cursor = $('#brush-cursor');
  canvas.addEventListener('pointerdown', e => {
    if (!engine || switching) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); canvas.setPointerCapture(e.pointerId); closeExport(); $('#canvas-hint').classList.add('dismissed');
    if (pointers.size === 2) {
      // Second finger: stop painting and start a pinch.
      drawing = false; brush = { ...idleBrush }; pendingBrush = null;
      const [a, b] = [...pointers.values()]; pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom, center: toGrid((a.x + b.x) / 2, (a.y + b.y) / 2) }; return;
    }
    if (e.button === 1 || tool === 'hand' || (e.button === 0 && e.altKey)) { panning = true; last = { x: e.clientX, y: e.clientY }; e.preventDefault(); return; }
    if (e.button !== 0) return;
    drawing = true; paint(e);
  });
  canvas.addEventListener('pointermove', e => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()]; const distance = Math.hypot(a.x - b.x, a.y - b.y); const mid = { clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 };
      zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, pinch.zoom * distance / pinch.distance)); $('#zoom-reset').textContent = `${Math.round(zoom * 100)}%`;
      const now = toGrid(mid.clientX, mid.clientY); setPan(pan.x + pinch.center.x - now.x, pan.y + pinch.center.y - now.y); return;
    }
    if (panning && last) { const k = cellsPerPixel(); setPan(pan.x - (e.clientX - last.x) * k, pan.y - (e.clientY - last.y) * k); last = { x: e.clientX, y: e.clientY }; return; }
    const rect = canvas.getBoundingClientRect(); const diameter = brushSize * resolution * 2 / cellsPerPixel();
    cursor.style.width = `${diameter}px`; cursor.style.height = `${diameter}px`; cursor.style.left = `${e.clientX - rect.left}px`; cursor.style.top = `${e.clientY - rect.top}px`; cursor.classList.add('visible');
    cursor.classList.toggle('erasing', tool === 'eraser' || e.shiftKey); if (drawing) paint(e);
  });
  const release = (e: PointerEvent) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; if (pointers.size === 0) { drawing = false; panning = false; last = null; brush = { ...idleBrush }; } };
  canvas.addEventListener('pointerup', release); canvas.addEventListener('pointercancel', release); canvas.addEventListener('lostpointercapture', release);
  canvas.addEventListener('pointerleave', () => cursor.classList.remove('visible'));
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) { setZoom(zoom * Math.exp(-e.deltaY * .01), e); return; }
    const k = cellsPerPixel(); setPan(pan.x + e.deltaX * k, pan.y + e.deltaY * k);
  }, { passive: false });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); if (!switching && canvas === $('#simulation')) { setRunning(false); toast('GPU context lost. Choose a compute engine to restart.'); $('#engine-status').textContent = 'GPU disconnected'; } });
}
function paint(e: PointerEvent) {
  const g = toGrid(e.clientX, e.clientY);
  brush = { x: wrap(g.x, width), y: wrap(g.y, height), radius: brushSize * resolution, mode: tool === 'eraser' || e.shiftKey ? -1 : 1, amount: start.amount };
  warmup = 0;
  // Preserve quick taps even when pointerup occurs before the next animation frame.
  pendingBrush = { ...brush };
  renderNeeded = true;
}
const sizeCanvas = (canvas: HTMLCanvasElement) => { const rect = canvas.getBoundingClientRect(); const dpr = Math.min(window.devicePixelRatio, 2); canvas.width = Math.max(1, Math.round(rect.width * dpr)); canvas.height = Math.max(1, Math.round(rect.height * dpr)); renderNeeded = true; };
new ResizeObserver(() => sizeCanvas($<HTMLCanvasElement>('#simulation'))).observe($('#canvas-stage'));

// ---------- Engine lifecycle ----------
function updateResolutionUI() {
  $<HTMLSelectElement>('#resolution').value = String(resolution);
  $('#grid-size').textContent = `${width} × ${height}`;
  $('#resolution-hint').textContent = resolution === 1
    ? '2×, 3×, and 4× use 4×, 9×, and 16× as many cells. Higher settings use more GPU memory and may run slower on your device.'
    : `${resolution * resolution}× as many cells as 1×. More GPU work and memory; may run slower on your device. Lower evolution speed if needed.`;
}
async function initialize(backend = 'auto', nextResolution: Resolution = resolution): Promise<boolean> {
  if (switching || exporting) return false;
  loadRevision++;
  switching = true;
  $<HTMLSelectElement>('#backend').disabled = true;
  $<HTMLSelectElement>('#resolution').disabled = true;
  $('#loading').hidden = false; $('#loading-text').textContent = 'Preparing the simulation…';
  const previousEngine = engine, previousCanvas = $<HTMLCanvasElement>('#simulation');
  const nextSize = gridSize(nextResolution);
  let candidate: Engine | null = null;
  let canvas = previousCanvas;
  const replaceCanvas = () => {
    const replacement = previousCanvas.cloneNode(false) as HTMLCanvasElement;
    canvas.replaceWith(replacement); canvas = replacement;
    attachCanvas(); sizeCanvas(canvas); return canvas;
  };
  try {
    let previous: Float32Array | undefined;
    try { previous = await previousEngine?.read(); }
    catch (error) { if (previousEngine && nextResolution !== resolution) throw error; /* A lost device can restart from seed. */ }
    replaceCanvas();
    if (backend !== 'webgl') {
      try {
        candidate = await WebGPUEngine.create(canvas, nextSize.width, nextSize.height, () => {
          if (engine === candidate) { toast('WebGPU disconnected. Restarting with WebGL.'); void initialize('webgl'); }
        });
      } catch (error) {
        if (backend === 'webgpu') toast('WebGPU unavailable. Using WebGL 2.');
        console.info('WebGPU fallback:', error); replaceCanvas();
      }
    }
    candidate ??= new WebGLEngine(canvas, nextSize.width, nextSize.height);
    candidate.seed(previous && previousEngine
      ? resizeField(previous, previousEngine.width, previousEngine.height, nextSize.width, nextSize.height)
      : makeStartField(start, seed, nextSize.width, nextSize.height));
    const scale = nextResolution / resolution;
    resolution = nextResolution; ({ width, height } = nextSize);
    setPan(pan.x * scale, pan.y * scale);
    engine = candidate; previousEngine?.destroy();
    drawing = false; panning = false; pointers.clear(); pinch = null; last = null;
    brush = { ...idleBrush }; pendingBrush = null; $('#brush-cursor').classList.remove('visible');
    if (!previous) { warmup = start.grown && !start.paused && start.mode !== 'empty' ? 1200 : 0; iterations = 0; setRunning(start.mode !== 'empty' && !start.paused && (start.mode !== 'image' || !!start.imageMask)); }
    $('#engine-status').textContent = engine.backend; $('#loading').hidden = true;
    const select = $<HTMLSelectElement>('#backend'); select.options[0].textContent = `Auto · ${engine.backend}`;
    if (backend !== 'auto') select.value = engine.backend === 'WebGPU' ? 'webgpu' : 'webgl';
    updateResolutionUI(); updateSpecimenLabel(); drawStartPreview(); renderNeeded = true;
    return true;
  } catch (error) {
    candidate?.destroy();
    if (canvas !== previousCanvas) canvas.replaceWith(previousCanvas);
    engine = previousEngine;
    if (engine) {
      sizeCanvas(previousCanvas); $('#loading').hidden = true;
      $('#engine-status').textContent = engine.backend;
      if (backend !== 'auto') $<HTMLSelectElement>('#backend').value = engine.backend === 'WebGPU' ? 'webgpu' : 'webgl';
      toast('Could not change the simulation. Try a lower resolution or another compute engine.');
    } else {
      $('#loading-text').textContent = error instanceof Error ? error.message : 'Could not start the GPU. Try a lower base resolution.';
      $('#engine-status').textContent = 'GPU unavailable';
    }
    console.error(error); updateResolutionUI();
    return false;
  } finally {
    switching = false;
    $<HTMLSelectElement>('#backend').disabled = false;
    $<HTMLSelectElement>('#resolution').disabled = false;
  }
}
$('#backend').addEventListener('change', e => void initialize((e.target as HTMLSelectElement).value));
$('#resolution').addEventListener('change', async e => {
  const next = parseResolution((e.target as HTMLSelectElement).value);
  if (next === resolution || switching || exporting) { updateResolutionUI(); return; }
  if (await initialize($<HTMLSelectElement>('#backend').value, next)) {
    toast(`${resolution}× base resolution. ${resolution === 1 ? 'Default GPU workload.' : `${resolution * resolution}× as many cells; performance depends on your device.`}`);
  }
});

let lastTime = 0, frames = 0, fpsTime = 0;
function frame(time: number) {
  requestAnimationFrame(frame);
  if (!engine || switching || document.hidden || exporting) return;
  // Limit submission to 60 Hz so high refresh displays do not change the evolution speed.
  if (time - lastTime < 15) return; lastTime = time;
  try {
    if (warmup > 0 && running) { const steps = Math.min(Math.max(1, Math.floor(80 / (resolution * resolution))), warmup); engine.step(params, steps); warmup -= steps; iterations += steps; renderNeeded = true; }
    else if (running || drawing || pendingBrush) { const steps = running ? speed : 1; engine.step(params, steps, pendingBrush ?? brush); pendingBrush = null; iterations += steps; renderNeeded = true; }
    if (renderNeeded) { engine.render(palette, threshold, zoom, pan); renderNeeded = false; }
    if (!fpsTime) fpsTime = time;
    frames++;
    if (time - fpsTime > 650) { if (running) $('#fps').textContent = `${Math.min(60, Math.round(frames * 1000 / (time - fpsTime)))} fps`; $('#iteration-count').textContent = iterations.toLocaleString('en-US'); frames = 0; fpsTime = time; }
  } catch (error) { setRunning(false); console.error(error); $('#engine-status').textContent = 'GPU interrupted'; engine = null; toast('The GPU stopped. Select a compute engine to restart.'); }
}

// ---------- Export ----------
function closeExport() { $('#export-menu').hidden = true; $('#export-toggle').setAttribute('aria-expanded', 'false'); }
$('#export-toggle').addEventListener('click', () => { const open = $('#export-menu').hidden; $('#export-menu').hidden = !open; $('#export-toggle').setAttribute('aria-expanded', String(open)); });
document.addEventListener('click', e => { if (!(e.target as HTMLElement).closest('.export-wrap')) closeExport(); });
async function exportPattern(format: 'png' | 'svg', baseScale = 4) {
  if (!engine || exporting || switching) return; exporting = true; closeExport();
  const source = engine; const { width, height } = source; const outputWidth = BASE_WIDTH * baseScale; const scale = outputWidth / width;
  const selectedPalette = { ...palette }; const selectedThreshold = threshold; const smooth = $<HTMLInputElement>('#svg-smooth').checked;
  const filename = `morph-${presets[presetIndex].name.toLowerCase()}-${seed}${format === 'png' ? `-${outputWidth}` : ''}.${format}`;
  toast(format === 'svg' ? 'Tracing your pattern into shapes…' : 'Preparing your image…');
  try {
    const data = await source.read();
    const blob = format === 'svg' ? new Blob([fieldToSVG(data, width, height, selectedThreshold, selectedPalette, { smooth })], { type: 'image/svg+xml' }) : await fieldToPNG(data, width, height, selectedThreshold, selectedPalette, scale);
    download(blob, filename); toast(`${format.toUpperCase()} exported.`);
  } catch (error) { console.error(error); toast('Export failed. Please try again.'); }
  finally { exporting = false; renderNeeded = true; }
}
$('#export-png').addEventListener('click', () => void exportPattern('png', 4));
$('#export-png-8').addEventListener('click', () => void exportPattern('png', 8));
$('#export-svg').addEventListener('click', () => void exportPattern('svg'));
$('#svg-smooth').addEventListener('click', e => e.stopPropagation());
async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch { const area = document.createElement('textarea'); area.value = text; document.body.append(area); area.select(); const ok = document.execCommand('copy'); area.remove(); return ok; }
}
$('#export-link').addEventListener('click', async () => { closeExport(); toast((await copyText(shareURL())) ? 'Share link copied.' : 'Could not copy. Check the address bar after reloading.'); });
$('#export-embed').addEventListener('click', () => {
  closeExport();
  showDialog(`<h2>Embed this pattern</h2><p>Runs live on the viewer's GPU with your current recipe, colors, seed, and ${resolution}× base resolution. Paste it into any page.</p>${resolution > 1 ? `<p>This base uses ${resolution * resolution}× as many cells as 1× and may run slower on visitors' devices.</p>` : ''}
    <div class="embed-options"><label class="select-field"><span>Use as</span><span class="select-wrap"><select id="embed-mode"><option value="inline">Inline block</option><option value="background">Full-page background</option></select>${icon('chevron')}</span></label>
    <label class="check-field"><input type="checkbox" id="embed-paint" checked/><span>Visitors can paint</span></label></div>
    <textarea id="embed-code" class="code-box" rows="7" readonly spellcheck="false"></textarea>
    <div class="dialog-actions"><button class="primary-button" id="embed-copy">${icon('check')} Copy code</button><a class="text-button" id="embed-preview" target="_blank" rel="noopener">${icon('external')} Preview</a></div>`);
  const refresh = () => {
    const mode = $<HTMLSelectElement>('#embed-mode').value as 'inline' | 'background'; const paint = $<HTMLInputElement>('#embed-paint').checked;
    $<HTMLTextAreaElement>('#embed-code').value = embedSnippet(mode, paint);
    const q = stateParams(); q.set('embed', '1'); if (!paint) q.set('interact', '0'); $<HTMLAnchorElement>('#embed-preview').href = `${location.pathname}?${q}`;
  };
  refresh(); $('#embed-mode').addEventListener('change', refresh); $('#embed-paint').addEventListener('change', refresh);
  $('#embed-copy').addEventListener('click', async () => { toast((await copyText($<HTMLTextAreaElement>('#embed-code').value)) ? 'Embed code copied.' : 'Select the code and copy it manually.'); });
  $('#embed-code').addEventListener('focus', e => (e.target as HTMLTextAreaElement).select());
});

// ---------- Saved presets ----------
const escapeHTML = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
function renderSaved() {
  const { saved } = store.getState();
  $('#saved-count').textContent = saved.length ? String(saved.length) : '';
  $('#saved-list').innerHTML = saved.length ? saved.map(p => `<div class="preset saved-card" data-saved="${p.id}" role="button" tabindex="0" aria-pressed="false"><span class="preset-art" style="${p.art ? `background-image:url('${p.art}')` : `background:linear-gradient(135deg,${p.background} 50%,${p.foreground} 50%)`}"></span><span class="preset-info"><span class="preset-name">${escapeHTML(p.name)}</span><small>${new Date(p.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</small><code>f ${p.feed.toFixed(4)} · k ${p.kill.toFixed(4)}</code></span><button class="icon-button small preset-delete" data-delete="${p.id}" title="Delete" aria-label="Delete ${escapeHTML(p.name)}">${icon('trash')}</button></div>`).join('')
    : `<p class="saved-empty">Nothing saved yet. Tune a recipe you like, then save it to come back later.</p>`;
  updateSpecimenLabel();
}
async function applySaved(p: SavedPreset) {
  if (!engine || switching || exporting) { toast('Wait for the simulation to be ready, then try again.'); return; }
  const savedResolution = parseResolution(p.resolution);
  const savedSize = gridSize(savedResolution);
  const target = engine, revision = ++loadRevision;
  let snapshot: MorphSnapshot | undefined;
  try { if (p.snapshotId) snapshot = await loadSnapshot(p.snapshotId, savedSize.width, savedSize.height); }
  catch (error) { if (revision === loadRevision) { console.error(error); toast('Could not load the saved morph state. Your current pattern is unchanged.'); } return; }
  // A later selection, reseed, deletion, or engine switch wins over this read.
  if (revision !== loadRevision || engine !== target || switching || exporting) return;
  if (savedResolution !== resolution) {
    const switchRevision = loadRevision + 1;
    if (!await initialize($<HTMLSelectElement>('#backend').value, savedResolution) || loadRevision !== switchRevision) return;
  }
  start = normalizeStart(p.start ?? defaultStart(p.seedMode), p.seedMode);
  imagePixels = null; imageRevision++;
  engine!.seed(snapshot?.field ?? makeStartField(start, p.seed));
  params = { feed: p.feed, kill: p.kill, diffusionA: p.diffusionA, diffusionB: p.diffusionB }; seed = p.seed;
  presetIndex = Math.max(0, presets.findIndex(x => x.seed === p.seedMode));
  threshold = p.threshold; speed = p.speed;
  const t = $<HTMLInputElement>('#threshold'); t.value = String(threshold); updateRange(t); updateThresholdLabel();
  const s = $<HTMLInputElement>('#speed'); s.value = String(speed); updateRange(s); updateSpeedLabel();
  updateSliders(); setColors(p.background, p.foreground); updateStart();
  iterations = snapshot?.iterations ?? 0; warmup = !snapshot && start.grown && !start.paused && start.mode !== 'empty' ? 1200 : 0;
  drawing = false; pendingBrush = null; brush = { ...idleBrush };
  if (snapshot) { setZoom(snapshot.zoom); setPan(snapshot.pan.x, snapshot.pan.y); }
  $('#iteration-count').textContent = iterations.toLocaleString('en-US');
  setRunning(!snapshot && start.mode !== 'empty' && !start.paused); renderNeeded = true;
  toast(snapshot ? `${p.name} restored. Press play to keep growing.` : `${p.name} loaded from its seed.`);
}
async function deleteSaved(p: SavedPreset) {
  loadRevision++;
  try {
    store.getState().removePreset(p.id);
    // Metadata is removed first so a failed write never leaves a broken save.
    if (p.snapshotId) { try { await removeSnapshot(p.snapshotId); } catch (error) { console.warn('Could not clean up the deleted field.', error); } }
    toast(`${p.name} deleted.`);
  } catch (error) { console.error(error); toast('Could not finish deleting the saved version. Please try again.'); }
}
$('#saved-list').addEventListener('click', e => {
  const target = e.target as HTMLElement; const del = target.closest<HTMLElement>('[data-delete]');
  if (del) { const p = store.getState().saved.find(x => x.id === del.dataset.delete); if (p) void deleteSaved(p); return; }
  const card = target.closest<HTMLElement>('[data-saved]'); const p = card && store.getState().saved.find(x => x.id === card.dataset.saved); if (p) void applySaved(p);
});
$('#saved-list').addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && !(e.target as HTMLElement).closest('button')) { const card = (e.target as HTMLElement).closest<HTMLElement>('[data-saved]'); const p = card && store.getState().saved.find(x => x.id === card.dataset.saved); if (p) { e.preventDefault(); void applySaved(p); } } });
async function openSaveDialog() {
  if (embed || dialog.open) return;
  if (!engine || switching || exporting) { toast('Wait for the simulation to be ready, then save again.'); return; }
  loadRevision++;
  const base = matchesPreset() ? presets[presetIndex].name : 'Experiment'; const count = store.getState().saved.length + 1;
  // Capture the field and settings together when Save current is clicked, before naming it.
  const draft = { ...params, resolution, background: palette.background, foreground: palette.foreground, threshold, speed, seed, seedMode: start.mode, start: { ...start } };
  const view = { iterations, zoom, pan: { ...pan } };
  const { width, height } = engine;
  const capture = engine.read().then(field => ({ version: 1 as const, width, height, field, ...view }))
    .catch(error => { console.error(error); return null; });
  showDialog(`<h2>Save this version</h2><p>Keeps the current morph, including painted changes, along with the recipe and view. Restores paused so you can continue from this exact shape.</p>
    <label class="select-field" for="preset-name"><span>Name</span></label><input id="preset-name" class="text-input" type="text" maxlength="40" value="${escapeHTML(`${base} ${count}`)}" autocomplete="off" spellcheck="false"/>
    <div class="dialog-actions"><button class="primary-button" id="preset-save">${icon('bookmark')} Save</button><button class="text-button" id="preset-cancel">Cancel</button></div>`);
  const input = $<HTMLInputElement>('#preset-name'); input.focus(); input.select();
  const button = $<HTMLButtonElement>('#preset-save');
  let committing = false;
  const commit = async () => {
    if (committing) return;
    committing = true; button.disabled = true;
    const name = input.value.trim() || `${base} ${count}`;
    let snapshotId: string | undefined;
    try {
      const snapshot = await capture;
      if (!snapshot) throw new Error('Could not read the current morph state.');
      let art: string | undefined;
      try { art = fieldToThumbnail(snapshot.field, snapshot.width, snapshot.height, draft.threshold, { name: 'Saved', background: draft.background, foreground: draft.foreground }); } catch { /* Thumbnail is optional. */ }
      snapshotId = await saveSnapshot(snapshot);
      store.getState().savePreset({ name, ...draft, art, snapshotId });
      // Do not close a different dialog opened while the write was pending.
      if (input.isConnected) dialog.close();
      toast(`${name} saved.`);
    } catch (error) {
      if (snapshotId) { try { await removeSnapshot(snapshotId); } catch { /* Best-effort cleanup after a failed metadata write. */ } }
      console.error(error); toast('Could not save this version. Check available browser storage and try again.');
    } finally { committing = false; button.disabled = false; }
  };
  $('#preset-save').addEventListener('click', () => void commit());
  $('#preset-cancel').addEventListener('click', () => dialog.close());
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); void commit(); } });
}
$('#save-preset').addEventListener('click', () => void openSaveDialog());
store.subscribe((s, prev) => { if (s.saved !== prev.saved) renderSaved(); });

// ---------- Dialogs ----------
const science = `<h2>How does a pattern grow itself?</h2><p>Two imaginary chemicals spread across the canvas. A feeds the reaction; B consumes A and slowly fades. Tiny differences grow into stripes, spots, and winding branches.</p><div class="equations"><div>∂A/∂t = D<sub>A</sub>∇²A − AB² + f(1 − A)</div><div>∂B/∂t = D<sub>B</sub>∇²B + AB² − (k + f)B</div></div><p>This is the <strong>Gray–Scott reaction–diffusion model</strong>, a relative of the mechanism Alan Turing proposed for biological pattern formation. The field wraps at its edges like a torus, which is why you can move across it endlessly.</p><div class="field-tip"><strong>Try this</strong><p>Choose Coral, lower the feed rate by a few ten-thousandths, then paint into the canvas. Click any number to type an exact value, or scroll over a slider to nudge it one step at a time. Small changes can make a completely different world.</p></div><p class="source-note">Model and stencil reference: <a href="https://www.karlsims.com/rd.html" target="_blank" rel="noopener noreferrer">Karl Sims' reaction–diffusion tutorial ↗</a></p>`;
const shortcutRows: [string, string][] = [
  ['Play / pause', 'Space'], ['Paint chemical B', 'B'], ['Eraser', 'E'], ['Move around', 'V'], ['Temporarily erase', 'Shift + drag'], ['Temporarily move', 'Alt + drag / middle button'],
  ['Brush size', ', / .'], ['Fine-tune a slider', 'Scroll over it'], ['Fine-tune a typed value', '↑ / ↓ while editing'], ['Exact value', 'Click the number'], ['Plant fresh seeds', 'R'], ['Surprise me', 'S'], ['Save version', '⌘ S'], ['Choose specimen', `1 – ${presets.length}`], ['Cycle palette', 'C'], ['Swap colors', 'X'],
  ['Move', 'Scroll / arrows'], ['Zoom', '⌘ Scroll / − / +'], ['Reset view', '0'], ['Fullscreen', 'F'], ['Hide or show interface', 'H'], ['Recipe panel', '['], ['Specimens panel', ']'], ['Close menu or dialog', 'Esc'],
];
const shortcuts = `<h2>Less clicking. More growing.</h2><div class="shortcut-list">${shortcutRows.map(([label, key]) => `<div><span>${label}</span><kbd>${key}</kbd></div>`).join('')}</div>`;
const dialog = $<HTMLDialogElement>('#info-dialog');
function showDialog(content: string) { $('#dialog-content').innerHTML = content; dialog.showModal(); }
$('#about').addEventListener('click', () => showDialog(science)); $('#reaction-help').addEventListener('click', e => { e.preventDefault(); showDialog(science); }); $('#shortcuts').addEventListener('click', () => showDialog(shortcuts));
$('#close-dialog').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', e => { if (e.target === dialog) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close(); } });

// ---------- Keyboard ----------
document.addEventListener('keydown', e => {
  if (e.isComposing || e.defaultPrevented) return;
  if (e.key === 'Escape') closeExport();
  if (embed || dialog.open) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); void openSaveDialog(); return; }
  // Only text editing owns shortcut keys. Buttons, sliders, and selects keep
  // focus for Tab / Enter, but cannot swallow canvas shortcuts after a click.
  const target = e.target instanceof HTMLElement ? e.target : null;
  if (target?.isContentEditable || target?.closest('input:not([type="range"]):not([type="color"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]),textarea,[role="textbox"]') || e.metaKey || e.ctrlKey || e.altKey) return;
  const key = e.key.toLowerCase(); const nudge = 24 * resolution / zoom;
  if (e.code === 'Space') { e.preventDefault(); setRunning(!running); }
  else if (key === 'b') setTool('brush'); else if (key === 'e') setTool('eraser'); else if (key === 'v') setTool('hand');
  else if (key === 'r') $('#reseed').click(); else if (key === 's') $('#surprise').click();
  else if (key === 'h') setHud(!hudVisible); else if (key === 'f') void toggleFullscreen();
  else if (key === 'c') setPalette(paletteIndex + 1); else if (key === 'x') $('#swap-colors').click();
  else if (e.key === '[') setDock('left', !docks.left); else if (e.key === ']') setDock('right', !docks.right);
  else if (e.key === ',') setBrushSize(brushSize - 2); else if (e.key === '.') setBrushSize(brushSize + 2);
  else if (e.key === '-' || e.key === '_') zoomStep(-1); else if (e.key === '+' || e.key === '=') zoomStep(1); else if (e.key === '0') resetView();
  else if (e.key === 'ArrowLeft') setPan(pan.x - nudge, pan.y); else if (e.key === 'ArrowRight') setPan(pan.x + nudge, pan.y);
  else if (e.key === 'ArrowUp') setPan(pan.x, pan.y - nudge); else if (e.key === 'ArrowDown') setPan(pan.x, pan.y + nudge);
  else if (e.key === '?') showDialog(shortcuts);
  else if (/^[1-9]$/.test(e.key) && Number(e.key) <= presets.length) setPreset(Number(e.key) - 1);
  else return;
  // Capture before saved-card handlers and suppress native button activation,
  // slider nudges, select typeahead, and page scrolling for handled shortcuts.
  e.preventDefault(); e.stopPropagation();
}, { capture: true });
window.addEventListener('blur', () => { drawing = false; panning = false; pointers.clear(); pinch = null; brush = { ...idleBrush }; });

// ---------- Boot ----------
updateResolutionUI(); renderSaved(); applyPalette(); updateSliders(); updateSpecimenLabel(); updateThresholdLabel(); updateSpeedLabel(); updateStart(); setTool('brush'); setZoom(zoom);
if (embed && !interactive) $('#simulation').style.pointerEvents = 'none';
void initialize(); requestAnimationFrame(frame);
