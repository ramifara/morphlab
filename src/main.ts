import './style.css';
import { icon, mark } from './icons';
import { palettes, presets, makeSeed, idleBrush, type Parameters, type Brush, type Palette, type View } from './model';
import { WebGPUEngine, WebGLEngine, type Engine } from './engine';
import { download, fieldToPNG, fieldToSVG } from './export';

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const $$ = <T extends HTMLElement = HTMLElement>(selector: string) => Array.from(document.querySelectorAll<T>(selector));
const WIDTH = 512, HEIGHT = 320, ZOOM_MIN = .25, ZOOM_MAX = 6;
type Tool = 'brush' | 'eraser' | 'hand';

// ---------- State ----------
let params: Parameters = { feed: presets[0].feed, kill: presets[0].kill, diffusionA: 1, diffusionB: .5 };
let presetIndex = 0, paletteIndex = 0, palette: Palette = { ...palettes[0] }, seed = 42, running = true, speed = 16, threshold = .19, zoom = 1;
const pan: View = { x: 0, y: 0 };
let engine: Engine | null = null, iterations = 0, warmup = 0, switching = false, drawing = false, panning = false, tool: Tool = 'brush', brushSize = 14;
let brush: Brush = { ...idleBrush }, pendingBrush: Brush | null = null, renderNeeded = true, exporting = false;

// ---------- URL state (share links and embeds) ----------
const query = new URLSearchParams(location.search);
const embed = query.has('embed');
const interactive = query.get('interact') !== '0';
const num = (key: string, fallback: number, min: number, max: number) => { const v = Number(query.get(key)); return query.has(key) && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback; };
const hex = (key: string, fallback: string) => { const v = query.get(key) ?? ''; return /^[0-9a-f]{6}$/i.test(v) ? `#${v.toLowerCase()}` : fallback; };
{
  presetIndex = Math.round(num('p', 0, 0, presets.length - 1));
  params = { feed: num('f', presets[presetIndex].feed, .005, .095), kill: num('k', presets[presetIndex].kill, .03, .075), diffusionA: num('da', 1, .1, 1), diffusionB: num('db', .5, .05, .8) };
  seed = Math.round(num('seed', 42, 0, 1e9)); threshold = num('w', .19, .08, .3); speed = Math.round(num('s', 16, 1, 48)); zoom = num('z', 1, ZOOM_MIN, ZOOM_MAX);
  palette = { name: 'Custom', background: hex('bg', palettes[0].background), foreground: hex('fg', palettes[0].foreground) };
  paletteIndex = palettes.findIndex(p => p.background === palette.background && p.foreground === palette.foreground);
  if (paletteIndex >= 0) palette.name = palettes[paletteIndex].name;
}
function stateParams() {
  const q = new URLSearchParams();
  q.set('p', String(presetIndex)); q.set('f', params.feed.toFixed(4)); q.set('k', params.kill.toFixed(4)); q.set('da', params.diffusionA.toFixed(2)); q.set('db', params.diffusionB.toFixed(2));
  q.set('bg', palette.background.slice(1)); q.set('fg', palette.foreground.slice(1)); q.set('w', threshold.toFixed(3)); q.set('s', String(speed)); q.set('seed', String(seed));
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

// ---------- Interface preferences ----------
const stored = <T>(key: string, fallback: T): T => { try { const v = localStorage.getItem(`morph:${key}`); return v === null ? fallback : JSON.parse(v) as T; } catch { return fallback; } };
const store = (key: string, value: unknown) => { try { localStorage.setItem(`morph:${key}`, JSON.stringify(value)); } catch { /* private mode */ } };
const compact = () => matchMedia('(max-width: 820px)').matches;
let hudVisible = !embed && stored('hud', true);
const docks = { left: stored('dock-left', !compact()), right: stored('dock-right', !compact()) };

// ---------- Markup ----------
const digits = (id: string) => (id === 'feed' || id === 'kill' ? 4 : 3);
const REACTION_KEYS = ['feed', 'kill', 'diffusionA', 'diffusionB'] as const;
function slider(id: string, label: string, symbol: string, value: number, min: number, max: number, step: number, hint = '') {
  return `<div class="field"><div class="field-head"><label for="${id}">${label}${symbol ? ` <i>${symbol}</i>` : ''}</label><input class="value" id="${id}-value" type="text" inputmode="decimal" value="${value.toFixed(digits(id))}" aria-label="${label} value" title="Type an exact value"/></div><input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}"/>${hint ? `<p class="field-hint">${hint}</p>` : ''}</div>`;
}
const section = (n: string, title: string, body: string, extra = '') =>
  `<details class="section" open><summary><span class="section-n">${n}</span><span class="section-title">${title}</span>${extra}${icon('chevron', 'section-chevron')}</summary><div class="section-body">${body}</div></details>`;
const menuItem = (id: string, label: string, note: string, type: string) => `<button id="${id}"><span>${label}<small>${note}</small></span><span class="file-type">${type}</span></button>`;

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
    <div class="chip specimen"><span class="live-dot"></span><span id="specimen-name">Coral</span><span class="specimen-id" id="specimen-id">/ 001</span></div>
    <div class="hud-spacer"></div>
    <div class="chip group">
      <button class="icon-button" id="toggle-left" title="Recipe panel · [" aria-label="Toggle recipe panel" aria-pressed="${docks.left}" aria-controls="dock-left">${icon('panelLeft')}</button>
      <button class="icon-button" id="toggle-right" title="Specimens panel · ]" aria-label="Toggle specimens panel" aria-pressed="${docks.right}" aria-controls="dock-right">${icon('panelRight')}</button>
      <span class="divider"></span>
      <div class="export-wrap">
        <button id="export-toggle" class="text-button" aria-expanded="false" aria-controls="export-menu">${icon('download')}<span>Export</span></button>
        <div id="export-menu" class="menu panel" hidden>
          <span class="menu-heading">Image</span>
          ${menuItem('export-png', 'PNG · 2048 × 1280', 'Smoothed 4× enlargement of the field', '.png')}
          ${menuItem('export-png-8', 'PNG · 4096 × 2560', '8× for print', '.png')}
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
    </div>
  </header>

  <aside class="hud dock dock-left panel" id="dock-left" data-open="${docks.left}" aria-label="Recipe">
    <div class="dock-head"><span class="dock-title">${icon('sliders')} Recipe</span><button class="icon-button small" id="reset-params" title="Reset recipe" aria-label="Reset recipe">${icon('reset')}</button><button class="icon-button small dock-close" data-close="left" aria-label="Close panel">${icon('close')}</button></div>
    <div class="dock-scroll">
      ${section('01', 'Reaction',
        slider('feed', 'Feed', 'f', params.feed, .005, .095, .0001, 'How much chemical A enters the system.') +
        slider('kill', 'Kill', 'k', params.kill, .03, .075, .0001, 'How quickly chemical B fades away.') +
        `<div class="pair">${slider('diffusionA', 'Diffusion A', '', params.diffusionA, .1, 1, .001)}${slider('diffusionB', 'Diffusion B', '', params.diffusionB, .05, .8, .001)}</div>`,
        `<button class="help-button" id="reaction-help" aria-label="About reaction parameters">${icon('info')}</button>`)}
      ${section('02', 'Appearance',
        `<div class="palettes" role="group" aria-label="Color palette">${palettes.map((p, i) => `<button class="palette" data-palette="${i}" title="${p.name}" aria-label="${p.name} palette" aria-pressed="false" style="--swatch-bg:${p.background};--swatch-fg:${p.foreground}"><span></span></button>`).join('')}</div>
         <div class="colors">
           <label class="color-field"><input type="color" id="color-bg" value="${palette.background}" aria-label="Background color"/><span class="color-swatch" id="swatch-bg"></span><span class="color-meta"><span>Background</span><code id="color-bg-hex">${palette.background}</code></span></label>
           <button class="icon-button small" id="swap-colors" title="Swap colors · X" aria-label="Swap colors">${icon('swap')}</button>
           <label class="color-field"><input type="color" id="color-fg" value="${palette.foreground}" aria-label="Pattern color"/><span class="color-swatch" id="swatch-fg"></span><span class="color-meta"><span>Pattern</span><code id="color-fg-hex">${palette.foreground}</code></span></label>
         </div>
         <div class="field compact"><div class="field-head"><label for="threshold">Pattern weight</label><output for="threshold" id="threshold-value">50%</output></div><input type="range" id="threshold" min="0.08" max="0.3" step="0.005" value="${threshold}"/></div>`,
        `<span class="section-note" id="palette-name">${palette.name}</span>`)}
      ${section('03', 'Simulation',
        `<div class="field compact"><div class="field-head"><label for="speed">Evolution speed</label><output for="speed" id="speed-value">1×</output></div><input type="range" id="speed" min="1" max="48" step="1" value="${speed}"/><div class="range-labels"><span>Unhurried</span><span>Impatient</span></div></div>
         <label class="select-field" for="backend"><span>Compute engine</span><span class="select-wrap"><select id="backend"><option value="auto">Auto</option><option value="webgpu">WebGPU</option><option value="webgl">WebGL 2</option></select>${icon('chevron')}</span></label>`)}
    </div>
  </aside>

  <aside class="hud dock dock-right panel" id="dock-right" data-open="${docks.right}" aria-label="Specimens">
    <div class="dock-head"><span class="dock-title">${icon('layers')} Specimens</span><span class="dock-note">1–${presets.length}</span><button class="icon-button small dock-close" data-close="right" aria-label="Close panel">${icon('close')}</button></div>
    <div class="dock-scroll">
      <div class="presets">${presets.map((p, i) => `<button class="preset" data-preset="${i}" aria-pressed="false"><span class="preset-art" style="background-image:url('${p.art ?? `/presets/${p.name.toLowerCase()}.svg`}')"></span><span class="preset-info"><span class="preset-name">${p.name}</span><small>${p.subtitle}</small><code>f ${p.feed.toFixed(4)} · k ${p.kill.toFixed(4)}</code></span><span class="preset-n">0${i + 1}</span></button>`).join('')}</div>
      <button class="surprise-button" id="surprise">${icon('shuffle')} Surprise me <kbd>S</kbd></button>
      <p class="dock-footnote">The field wraps at its edges, so you can move around it forever. Some recipes settle into a flat color. That is a valid equilibrium. Reseed or pick a specimen to grow again.</p>
    </div>
  </aside>

  <div class="hud hud-bottom">
    <div class="chip status" id="status"><span class="status-dot"></span><span id="engine-status">Connecting to GPU</span><span class="sep"></span><span id="fps">— fps</span><span class="sep"></span><span><span id="iteration-count">0</span> iter</span><span class="sep"></span><span>${WIDTH} × ${HEIGHT}</span></div>
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
  hudVisible = visible; root.dataset.hud = visible ? 'on' : 'off'; store('hud', visible);
  if (!visible) closeExport();
}
function setDock(side: 'left' | 'right', open: boolean) {
  docks[side] = open; store(`dock-${side}`, open);
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
function updateSpecimenLabel() {
  const exact = matchesPreset();
  $('#specimen-name').textContent = exact ? presets[presetIndex].name : 'Your experiment'; $('#specimen-id').textContent = exact ? `/ 00${presetIndex + 1}` : '/ ---';
  $$('.preset').forEach(el => { const active = exact && Number(el.dataset.preset) === presetIndex; el.classList.toggle('active', active); el.setAttribute('aria-pressed', String(active)); });
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

function reseed(prepare = false) {
  if (!engine) return;
  engine.seed(makeSeed(WIDTH, HEIGHT, seed, presets[presetIndex].seed)); iterations = 0; warmup = prepare ? 1200 : 0; renderNeeded = true;
}
function setPreset(index: number, randomSeed = false) {
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
  reseed(true);
}
$$('[data-preset]').forEach(el => el.addEventListener('click', () => setPreset(Number(el.dataset.preset))));
$('#reset-params').addEventListener('click', () => { setPreset(presetIndex); toast('Recipe restored.'); });
$('#reseed').addEventListener('click', () => { seed = Math.floor(Math.random() * 1e9); reseed(); toast('Fresh seeds planted.'); });
$('#surprise').addEventListener('click', () => {
  setPreset((presetIndex + 1 + Math.floor(Math.random() * (presets.length - 1))) % presets.length, true);
  setPalette(Math.floor(Math.random() * palettes.length)); setRunning(true); toast(`${presets[presetIndex].name} in ${palette.name.toLowerCase()}.`);
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
$('#threshold').addEventListener('input', e => { threshold = Number((e.target as HTMLInputElement).value); updateThresholdLabel(); renderNeeded = true; });
const updateThresholdLabel = () => { $('#threshold-value').textContent = `${Math.round((.3 - threshold) / .22 * 100)}%`; };
$('#speed').addEventListener('input', e => { speed = Number((e.target as HTMLInputElement).value); updateSpeedLabel(); });
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
function cellsPerPixel() { const rect = $('#simulation').getBoundingClientRect(); const aspect = rect.width / rect.height / (WIDTH / HEIGHT); return Math.min(1, aspect) / zoom * WIDTH / rect.width; }
/** Unwrapped grid coordinate under a client point. */
function toGrid(clientX: number, clientY: number): View {
  const rect = $('#simulation').getBoundingClientRect(); const aspect = rect.width / rect.height / (WIDTH / HEIGHT);
  return { x: (((clientX - rect.left) / rect.width - .5) * Math.min(1, aspect) / zoom + .5) * WIDTH + pan.x, y: (((clientY - rect.top) / rect.height - .5) * Math.min(1, 1 / aspect) / zoom + .5) * HEIGHT + pan.y };
}
const wrap = (v: number, size: number) => ((v % size) + size) % size;
function setPan(x: number, y: number) { pan.x = wrap(x, WIDTH); pan.y = wrap(y, HEIGHT); renderNeeded = true; }
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
    const rect = canvas.getBoundingClientRect(); const diameter = brushSize * 2 / cellsPerPixel();
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
  brush = { x: wrap(g.x, WIDTH), y: wrap(g.y, HEIGHT), radius: brushSize, mode: tool === 'eraser' || e.shiftKey ? -1 : 1 };
  // Preserve quick taps even when pointerup occurs before the next animation frame.
  pendingBrush = { ...brush };
  renderNeeded = true;
}
const sizeCanvas = (canvas: HTMLCanvasElement) => { const rect = canvas.getBoundingClientRect(); const dpr = Math.min(window.devicePixelRatio, 2); canvas.width = Math.max(1, Math.round(rect.width * dpr)); canvas.height = Math.max(1, Math.round(rect.height * dpr)); renderNeeded = true; };
new ResizeObserver(() => sizeCanvas($<HTMLCanvasElement>('#simulation'))).observe($('#canvas-stage'));

// ---------- Engine lifecycle ----------
async function initialize(backend = 'auto') {
  if (switching) return;
  switching = true; $<HTMLSelectElement>('#backend').disabled = true; $('#loading').hidden = false; $('#loading-text').textContent = 'Waking up the chemistry…';
  let previous: Float32Array | undefined;
  try { previous = await engine?.read(); } catch { /* The old device may already be lost. */ }
  engine?.destroy(); engine = null;
  const replaceCanvas = () => {
    const old = $<HTMLCanvasElement>('#simulation'); const canvas = old.cloneNode(false) as HTMLCanvasElement; old.replaceWith(canvas); attachCanvas(); sizeCanvas(canvas); return canvas;
  };
  try {
    let canvas = replaceCanvas();
    if (backend !== 'webgl') {
      try { engine = await WebGPUEngine.create(canvas, WIDTH, HEIGHT, () => { toast('WebGPU disconnected. Restarting with WebGL.'); void initialize('webgl'); }); }
      catch (error) { if (backend === 'webgpu') toast('WebGPU unavailable. Using WebGL 2.'); console.info('WebGPU fallback:', error); canvas = replaceCanvas(); }
    }
    engine ??= new WebGLEngine(canvas, WIDTH, HEIGHT);
    engine.seed(previous ?? makeSeed(WIDTH, HEIGHT, seed, presets[presetIndex].seed));
    if (!previous) { warmup = 1200; iterations = 0; }
    $('#engine-status').textContent = engine.backend; $('#loading').hidden = true;
    const select = $<HTMLSelectElement>('#backend'); select.options[0].textContent = `Auto · ${engine.backend}`;
    if (backend !== 'auto') select.value = engine.backend === 'WebGPU' ? 'webgpu' : 'webgl';
    renderNeeded = true;
  } catch (error) {
    $('#loading-text').textContent = error instanceof Error ? error.message : 'Could not start the GPU.'; $('#engine-status').textContent = 'GPU unavailable';
  } finally { switching = false; $<HTMLSelectElement>('#backend').disabled = false; }
}
$('#backend').addEventListener('change', e => void initialize((e.target as HTMLSelectElement).value));

let lastTime = 0, frames = 0, fpsTime = 0;
function frame(time: number) {
  requestAnimationFrame(frame);
  if (!engine || switching || document.hidden || exporting) return;
  // Limit submission to 60 Hz so high refresh displays do not change the evolution speed.
  if (time - lastTime < 15) return; lastTime = time;
  try {
    if (warmup > 0 && running) { const steps = Math.min(80, warmup); engine.step(params, steps); warmup -= steps; iterations += steps; renderNeeded = true; }
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
async function exportPattern(format: 'png' | 'svg', scale = 4) {
  if (!engine || exporting || switching) return; exporting = true; closeExport();
  const selectedPalette = { ...palette }; const selectedThreshold = threshold; const smooth = $<HTMLInputElement>('#svg-smooth').checked;
  const filename = `morph-${presets[presetIndex].name.toLowerCase()}-${seed}${format === 'png' ? `-${WIDTH * scale}` : ''}.${format}`;
  toast(format === 'svg' ? 'Tracing your pattern into shapes…' : 'Preparing your image…');
  try {
    const data = await engine.read();
    const blob = format === 'svg' ? new Blob([fieldToSVG(data, WIDTH, HEIGHT, selectedThreshold, selectedPalette, { smooth })], { type: 'image/svg+xml' }) : await fieldToPNG(data, WIDTH, HEIGHT, selectedThreshold, selectedPalette, scale);
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
  showDialog(`<h2>Embed this pattern</h2><p>Runs live on the viewer's GPU with the recipe, colors, and seed you have right now. Paste it into any page.</p>
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

// ---------- Dialogs ----------
const science = `<h2>How does a pattern grow itself?</h2><p>Two imaginary chemicals spread across the canvas. A feeds the reaction; B consumes A and slowly fades. Tiny differences grow into stripes, spots, and winding branches.</p><div class="equations"><div>∂A/∂t = D<sub>A</sub>∇²A − AB² + f(1 − A)</div><div>∂B/∂t = D<sub>B</sub>∇²B + AB² − (k + f)B</div></div><p>This is the <strong>Gray–Scott reaction–diffusion model</strong>, a relative of the mechanism Alan Turing proposed for biological pattern formation. The field wraps at its edges like a torus, which is why you can move across it endlessly.</p><div class="field-tip"><strong>Try this</strong><p>Choose Coral, lower the feed rate by a few ten-thousandths, then paint into the canvas. Click any number to type an exact value, or scroll over a slider to nudge it one step at a time. Small changes can make a completely different world.</p></div><p class="source-note">Model and stencil reference: <a href="https://www.karlsims.com/rd.html" target="_blank" rel="noopener noreferrer">Karl Sims' reaction–diffusion tutorial ↗</a></p>`;
const shortcutRows: [string, string][] = [
  ['Play / pause', 'Space'], ['Paint chemical B', 'B'], ['Eraser', 'E'], ['Move around', 'V'], ['Temporarily erase', 'Shift + drag'], ['Temporarily move', 'Alt + drag / middle button'],
  ['Brush size', ', / .'], ['Fine-tune a slider', 'Scroll over it / arrows'], ['Exact value', 'Click the number'], ['Plant fresh seeds', 'R'], ['Surprise me', 'S'], ['Choose specimen', `1 – ${presets.length}`], ['Cycle palette', 'C'], ['Swap colors', 'X'],
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
  if (e.key === 'Escape') closeExport();
  if (embed || (e.target as HTMLElement).closest('input,select,textarea,a') || dialog.open || e.metaKey || e.ctrlKey || e.altKey) return;
  // Buttons keep Space and Enter for activation.
  if ((e.target as HTMLElement).closest('button') && (e.code === 'Space' || e.key === 'Enter')) return;
  const key = e.key.toLowerCase(); const nudge = 24 / zoom;
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
  if (e.key.startsWith('Arrow')) e.preventDefault();
});
window.addEventListener('blur', () => { drawing = false; panning = false; pointers.clear(); pinch = null; brush = { ...idleBrush }; });

// ---------- Boot ----------
applyPalette(); updateSliders(); updateSpecimenLabel(); updateThresholdLabel(); updateSpeedLabel(); setTool('brush'); setZoom(zoom);
if (embed && !interactive) $('#simulation').style.pointerEvents = 'none';
void initialize(); requestAnimationFrame(frame);
