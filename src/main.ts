import './style.css';
import { installSelects, syncSelects } from './select';
import { VolumeEngine } from './engine3d';
import { SceneVolumeEngine, defaultObject, parseSceneRecipe, type VolumeSceneSnapshot, type VolumeObjectConfig } from './scene3d';
import { makeVolumeSeed, volumeGridSize, volumeResolutions, parseVolumeResolution, resizeVolume, type VolumeShape } from './volume';
import { icon, mark } from './icons';
import { palettes, presets, makeSeed, addSeeds, defaultStart, seedModes, seedCount, idleBrush, type SeedMode, type Parameters, type Brush, type Palette, type View } from './model';
import { readStart, writeStart, normalizeStart } from './start';
import { imageMask, IMAGE_WIDTH, IMAGE_HEIGHT } from './seed-image';
import { WebGPUEngine, WebGLEngine, type Engine, type ViewState } from './engine';
import { LAYER_HEIGHT, LAYER_WIDTH, PeerRegistry, compositeLayer, mixHints, mixModes, mixNames, newestMix, parseMixMode, sameRect, sameState, stripToAB, viewportRect, type LinkMessage, type MixMode, type PeerState, type Rect } from './link';
import { download, fieldToPNG, fieldToSVG, fieldToThumbnail } from './export';
import { createAppStore, type SavedPreset } from './store';
import { BASE_WIDTH, resolutions, parseResolution, gridSize, resizeField, type Resolution } from './resolution';
import { loadSnapshot, saveSnapshot, removeSnapshot, type MorphSnapshot } from './snapshots';

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const $$ = <T extends HTMLElement = HTMLElement>(selector: string) => Array.from(document.querySelectorAll<T>(selector));
const ZOOM_MIN = .25, ZOOM_MAX = 6;
let resolution: Resolution = 1;
let { width, height } = gridSize(resolution);
type Tool = 'brush' | 'eraser' | 'hand' | 'object';

// ---------- State ----------
let params: Parameters = { feed: presets[0].feed, kill: presets[0].kill, diffusionA: 1, diffusionB: .5 };
let presetIndex = 0, paletteIndex = 0, palette: Palette = { ...palettes[0] }, seed = 42, running = true, speed = 16, threshold = .19, zoom = 1;
const pan: View = { x: 0, y: 0 };
let engine: Engine | null = null, iterations = 0, warmup = 0, switching = false, drawing = false, panning = false, tool: Tool = 'brush', brushSize = 14;
let loadRevision = 0;
let brush: Brush = { ...idleBrush }, pendingBrush: Brush | null = null, renderNeeded = true, exporting = false;
let mixMode: MixMode = 'melt', mixStrength = .6, mixChangedAt = 0;

// ---------- URL state (share links and embeds) ----------
const query = new URLSearchParams(location.search);
let is3D = query.get('mode') === '3d';
let volumeShape: VolumeShape = query.get('shape') === 'box' ? 'box' : 'sphere';
const simulationSize = (r: Resolution) => is3D ? volumeGridSize(r) : gridSize(r);
const embed = query.has('embed');
const interactive = query.get('interact') !== '0';
const num = (key: string, fallback: number, min: number, max: number) => { const v = Number(query.get(key)); return query.has(key) && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback; };
let objectSize = num('objectSize', 1, .5, 3);
let showFloor = query.get('floor') !== '0';
const hex = (key: string, fallback: string) => { const v = query.get(key) ?? ''; return /^[0-9a-f]{6}$/i.test(v) ? `#${v.toLowerCase()}` : fallback; };
{
  resolution = is3D ? parseVolumeResolution(query.get('r')) : parseResolution(query.get('r'));
  ({ width, height } = simulationSize(resolution));
  presetIndex = Math.round(num('p', 0, 0, presets.length - 1));
  params = { feed: num('f', presets[presetIndex].feed, .005, .095), kill: num('k', presets[presetIndex].kill, .03, .075), diffusionA: num('da', 1, .1, 1), diffusionB: num('db', .5, .05, .8) };
  seed = Math.round(num('seed', 42, 0, 4294967295)); threshold = num('w', .19, .08, .3); speed = Math.round(num('s', 16, 1, 48)); zoom = num('z', 1, ZOOM_MIN, ZOOM_MAX);
  palette = { name: 'Custom', background: hex('bg', palettes[0].background), foreground: hex('fg', palettes[0].foreground) };
  mixMode = parseMixMode(query.get('mix'));
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
  if (is3D) { syncScene(); if(engine instanceof SceneVolumeEngine)q.set('scene',JSON.stringify(engine.recipe())); q.set('mode', '3d'); q.set('shape', volumeShape); q.set('objectSize', String(objectSize)); if (!showFloor) q.set('floor', '0'); if (engine instanceof VolumeEngine) { q.set('yaw', String(engine.orbit.x)); q.set('pitch', String(engine.orbit.y)); q.set('cut', String(engine.cut)); } }
  writeStart(q, start);
  if (zoom !== 1) q.set('z', zoom.toFixed(2));
  if (mixMode !== 'melt') q.set('mix', mixMode);
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

  <div class="scene-handles" id="scene-handles" hidden aria-label="Drag scene objects"></div>
  <div class="hud scene-quickbar chip" id="scene-quickbar" hidden>
    <label class="scene-mode"><span>Interaction</span><select id="scene-mix-mode">${mixModes.map(mode=>`<option value="${mode}">${mixNames[mode]}</option>`).join('')}</select></label>
    <label class="scene-range" for="scene-strength"><span>Strength</span><input id="scene-strength" type="range" min="0" max="1" step=".05" value=".85"/></label>
    <label class="scene-range" for="scene-cut"><span>Cut all</span><input id="scene-cut" type="range" min="-.9" max="1" step=".01" value="1"/></label>
    <button class="text-button" id="scene-depth" aria-pressed="false" title="Drag up/down to move in depth · Shift-drag does the same">Depth</button>
    <button class="text-button" id="scene-fit" title="Frame every object">Fit</button>
    <div class="scene-feedback" id="scene-feedback" role="status">Drag objects or their labels · background drag orbits · Shift-drag moves in depth</div>
  </div>
  <header class="hud hud-top">
    <a href="/" class="chip brand" aria-label="Morph Lab home"><span class="brand-mark">${mark}</span><span class="brand-text">MORPH<span>LAB</span></span></a>
    <button id="dimension-toggle" class="chip dimension-toggle" aria-label="3D mode" aria-pressed="${is3D}" title="${is3D ? 'Switch to 2D' : 'Switch to 3D'}">${icon('cube')}</button>
    <div class="chip group"><button class="icon-button" id="toggle-left" title="Recipe panel · [" aria-label="Toggle recipe panel" aria-pressed="${docks.left}" aria-controls="dock-left">${icon('panelLeft')}</button></div>
    <div class="chip specimen"><span class="live-dot"></span><span id="specimen-name">Coral</span><span class="specimen-id" id="specimen-id">/ 001</span></div>
    <button class="chip link-chip" id="link-chip" hidden title="Linked windows · open the Recipe panel" aria-label="Linked windows">${icon('windows')}<span class="link-dot"></span><span id="link-chip-text"></span></button>
    <div class="hud-spacer"></div>
    <div class="chip group">
      <div class="export-wrap">
        <button id="export-toggle" class="text-button" aria-expanded="false" aria-controls="export-menu">${icon('download')}<span>Export</span></button>
        <div id="export-menu" class="menu panel" hidden>
          <span class="menu-heading">Image</span>
          ${menuItem('export-png', 'PNG · 2048 × 1280', 'Full field · current colors and weight', '.png')}
          ${menuItem('export-png-8', 'PNG · 4096 × 2560', 'Larger image for print', '.png')}
          <span class="menu-heading">Vector</span>
          <div id="export-geometry" hidden>${menuItem('export-3d', '3D mesh', 'STL for slicing · OBJ for modeling', '.stl')}</div>
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
      ${section('3D', 'Scene', `<div class="scene-objects" id="scene-objects" role="group" aria-label="Scene objects"></div><div class="scene-actions"><button class="text-button" id="add-sphere">${icon('plus')} Sphere</button><button class="text-button" id="add-box">${icon('plus')} Box</button><button class="icon-button small" id="remove-object" aria-label="Remove selected object" title="Remove selected object">${icon('trash')}</button></div><p class="field-hint" id="scene-selection-note">Recipe controls edit the selected object.</p><div class="object-shapes" role="group" aria-label="Object shape"><button data-shape="sphere" aria-pressed="${volumeShape === 'sphere'}">◉ Sphere</button><button data-shape="box" aria-pressed="${volumeShape === 'box'}">◇ Box</button></div><p class="field-hint">Choose an interaction above playback. Melt fuses the surface and colors instantly; the chemistry also flows as it evolves. Shape changes restart this object.</p><div class="field"><div class="field-head"><label for="object-size">Object size</label><output id="object-size-value">${objectSize.toFixed(1)}×</output></div><input id="object-size" type="range" min=".5" max="3" step=".1" value="${objectSize}"/><p class="field-hint">Scales the object in the scene. Resolution adds chemical cells.</p></div><div class="object-position" role="group" aria-label="Object position">${['x','y','z'].map((axis,i)=>`<label>${axis.toUpperCase()}<input id="object-${axis}" type="number" min="-6" max="6" step=".1" value="0" aria-label="Object ${axis.toUpperCase()} position"/></label>`).join('')}</div><button class="text-button" id="move-object">${icon('move')} Drag object</button><div class="field"><div class="field-head"><label for="interaction">Interaction strength</label><output id="interaction-value">85%</output></div><input id="interaction" type="range" min="0" max="1" step=".05" value=".85"/><p class="field-hint" id="interaction-note">Move objects together to mix their chemicals.</p></div><label class="select-field"><span>Cutaway affects</span><select id="scene-cut-scope"><option value="all">All objects · one plane</option><option value="selected">Each object separately</option></select></label><div class="field"><div class="field-head"><label for="volume-cut">Cutaway</label><output id="cut-value">Whole</output></div><input id="volume-cut" type="range" min="-.9" max="1" step=".01" value="1"/></div><label class="check-field floor-toggle"><input id="show-floor" type="checkbox" ${showFloor ? 'checked' : ''}/><span>Show floor</span></label><button class="text-button" id="reset-orbit">Reset camera</button><button class="text-button" id="fit-object">Fit scene</button><p class="field-hint">Drag to orbit. Scroll to zoom. Choose the brush to seed the boundary or exposed cut.</p>`)}

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
         <label class="select-field" for="resolution"><span>Base resolution</span><span class="select-wrap"><select id="resolution" aria-describedby="resolution-hint">${(is3D ? volumeResolutions : resolutions).map(r => { const size = gridSize(r); return `<option value="${r}" ${r === resolution ? 'selected' : ''}>${is3D ? `${64*r}³ · ${r**3}× cells` : `${r}× · ${size.width} × ${size.height}`}${r === 1 ? ' · Default' : ''}</option>`; }).join('')}</select>${icon('chevron')}</span></label>
         <p class="field-hint resolution-hint" id="resolution-hint" aria-live="polite"></p>
         <label class="select-field" for="backend"><span>Compute engine</span><span class="select-wrap"><select id="backend"><option value="auto">Auto</option><option value="webgpu">WebGPU</option><option value="webgl">WebGL 2</option></select>${icon('chevron')}</span></label>`)}
      ${section('05', 'Windows',
        `<p class="field-hint link-intro">Run Morph Lab in several windows. Where they overlap on your screen, their patterns mix.</p>
         <button class="primary-button link-open" id="open-window">${icon('windows')}<span>Open a linked window</span><kbd>N</kbd></button>
         <label class="select-field" for="mix-mode"><span>When windows overlap</span><span class="select-wrap"><select id="mix-mode">${mixModes.map(m => `<option value="${m}">${mixNames[m]}</option>`).join('')}</select>${icon('chevron')}</span></label>
         <p class="field-hint" id="mix-hint"></p>
         <div class="field compact"><div class="field-head"><label for="mix-strength">Mixing strength</label><output for="mix-strength" id="mix-strength-value"></output></div><input type="range" id="mix-strength" min="0" max="1" step="0.05" value="${mixStrength}"/></div>
         <p class="link-status" id="link-status" aria-live="polite"></p>`,
        `<span class="section-note" id="link-count"></span>`)}
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
      <button class="icon-button" data-tool="object" title="Move object · G" aria-label="Move object" aria-pressed="false" hidden>${icon('move')}</button>
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
const originalHint = $('#canvas-hint').innerHTML;
const originalFootnotes = $$('.dock-footnote').map(el => el.textContent);
const originalPNG = $('#export-png span').innerHTML;
function updateDimensionUI() {
  root.dataset.dimension = is3D ? '3d' : '2d';
  $('#dimension-toggle').setAttribute('aria-pressed', String(is3D));
  $('#dimension-toggle').title = is3D ? 'Switch to 2D' : 'Switch to 3D';
  $('#object-size').closest<HTMLElement>('.section')!.hidden = !is3D;
  $('#scene-quickbar').hidden=!is3D;$('#scene-handles').hidden=!is3D;
  $('#canvas-hint').innerHTML = is3D ? 'Drag objects <kbd>Shift</kbd> depth <kbd>Alt</kbd> orbit <kbd>Scroll</kbd> zoom' : originalHint;
  $('[data-tool=hand]').setAttribute('aria-label', is3D ? 'Orbit object' : 'Move around');
  $('[data-tool=hand]').title = is3D ? 'Orbit object · V' : 'Move around · V';
  $('#simulation').setAttribute('aria-label', is3D ? '3D reaction diffusion volume. Drag to orbit, scroll to zoom. Choose brush to paint.' : 'Live reaction diffusion pattern. Drag to add chemical B. Hold Shift to erase.');
  $('#resolution').closest<HTMLElement>('.select-field')!.querySelector('span')!.textContent = is3D ? 'Volume resolution' : 'Base resolution';
  $<HTMLSelectElement>('#resolution').innerHTML = (is3D ? volumeResolutions : resolutions).map(r => {
    const size = gridSize(r);
    return `<option value="${r}" ${r === resolution ? 'selected' : ''}>${is3D ? `${64*r}³ · ${r**3}× cells` : `${r}× · ${size.width} × ${size.height}`}${r === 1 ? ' · Default' : ''}</option>`;
  }).join('');
  $('#mix-mode').closest<HTMLElement>('.section')!.hidden = is3D;
  $$('.dock-footnote').forEach((el, i) => el.textContent = is3D ? 'Drag an object or its label to arrange it. Drag the background or hold Alt to orbit. Shift-drag moves in depth. Cut all objects exposes the same plane through the scene.' : originalFootnotes[i]);
  $('#export-png span').innerHTML = is3D ? 'PNG · current 3D view<small>Object, lighting and camera</small>' : originalPNG;
  $('#export-geometry').hidden = !is3D; $('[data-tool=object]').hidden = !is3D;
  $('#export-png-8').hidden = is3D; $('#export-svg').hidden = is3D; $('.menu-option').hidden = is3D;
  if (engine instanceof VolumeEngine) {
    $<HTMLInputElement>('#volume-cut').value = String(engine.cut);
    $('#cut-value').textContent = engine.cut === 1 ? 'Whole' : `${Math.round((1-engine.cut)/2*100)}% removed`;
  }
  updateSceneUI(); syncSelects();
}
$('#dimension-toggle').addEventListener('click', () => void switchDimension());
{
  $$('[data-shape]').forEach(button => button.addEventListener('click', () => {
    if (!(engine instanceof VolumeEngine) || switching || exporting) return;
    volumeShape = button.dataset.shape as VolumeShape; engine.shape = volumeShape;
    $$('[data-shape]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.shape === volumeShape)));
    reseed();
  }));
  $('#volume-cut').addEventListener('input', e => {
    if (!(engine instanceof VolumeEngine)) return;
    applySceneCut(Number((e.target as HTMLInputElement).value));
  });
  $('#reset-orbit').addEventListener('click', () => resetView());
  $('#show-floor').addEventListener('change', e => { showFloor = (e.target as HTMLInputElement).checked; if (engine instanceof VolumeEngine) engine.showFloor = showFloor; renderNeeded = true; });
  $('#fit-object').addEventListener('click', () => {syncScene();setZoom(engine instanceof SceneVolumeEngine ? engine.fitScene() : 1);});
  $('#object-size').addEventListener('input', e => {
    objectSize = Number((e.target as HTMLInputElement).value);
    $('#object-size-value').textContent = `${objectSize.toFixed(1)}×`;
    if (engine instanceof VolumeEngine) engine.objectSize = objectSize;
    renderNeeded = true;
  });
}

function activeObjectConfig(): VolumeObjectConfig {
  return { ...defaultObject(),shape:volumeShape,size:objectSize,recipe:{...params},palette:{...palette},threshold,seed,start:{...start},position:[0,0,0],cut:1 };
}
function syncScene() {
  if(!loadingObjectControls && engine instanceof SceneVolumeEngine) engine.syncActive(params,palette,threshold,seed,start);
}
function updateSceneUI() {
  if(!(engine instanceof SceneVolumeEngine)) return;
  const scene=engine;
  const focusedObject=document.activeElement?.getAttribute('data-object');
  $('#scene-objects').innerHTML=scene.objects.map((object,i)=>`<button data-object="${i}" aria-pressed="${i===scene.selected}" style="--object-color:${object.config.palette.foreground}"><span class="object-dot"></span>${escapeHTML(object.config.name)}<small>${object.config.shape==='box'?'Box':'Sphere'}</small></button>`).join('');
  if(focusedObject!==null && focusedObject!==undefined)$<HTMLButtonElement>(`[data-object="${focusedObject}"]`)?.focus({preventScroll:true});
  for(const id of ['add-sphere','add-box']) $<HTMLButtonElement>(`#${id}`).disabled=engine.objects.length>=3||switching||exporting;
  $<HTMLButtonElement>('#remove-object').disabled=engine.objects.length===1||switching||exporting;
  ['x','y','z'].forEach((axis,i)=>$<HTMLInputElement>(`#object-${axis}`).value=scene.position[i].toFixed(2));
  $<HTMLInputElement>('#scene-strength').value=String(engine.interaction);
  $<HTMLSelectElement>('#scene-mix-mode').value=engine.mixMode;
  $<HTMLSelectElement>('#scene-cut-scope').value=engine.cutScope;
  syncCutControls();updateSceneHandles();
  $<HTMLInputElement>('#interaction').value=String(engine.interaction);$('#interaction-value').textContent=engine.interaction===0?'Off':`${Math.round(engine.interaction*100)}%`;
  $('#scene-selection-note').textContent=`${engine.active.config.name} selected · ${engine.objects.length} of 3 objects. Recipe, seeds and appearance apply here.`;
  updateResolutionUI();
}
let loadingObjectControls=false;
function loadObjectControls() {
  if(!(engine instanceof SceneVolumeEngine))return;
  engine.loadActive(); const c=structuredClone(engine.active.config);loadingObjectControls=true;
  params={...c.recipe};palette={...c.palette};threshold=c.threshold;seed=c.seed;start={...c.start};volumeShape=c.shape;objectSize=c.size;
  presetIndex=Math.max(0,presets.findIndex(p=>p.feed===params.feed&&p.kill===params.kill));
  imagePixels=null;imageRevision++;updateSliders();setColors(palette.background,palette.foreground);updateStart();
  $<HTMLInputElement>('#threshold').value=String(threshold);updateThresholdLabel();
  $<HTMLInputElement>('#object-size').value=String(objectSize);$('#object-size-value').textContent=`${objectSize.toFixed(1)}×`;
  $<HTMLInputElement>('#volume-cut').value=String(engine.cut);$('#cut-value').textContent=engine.cut===1?'Whole':`${Math.round((1-engine.cut)/2*100)}% removed`;
  $$('[data-shape]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.shape===volumeShape)));
  loadingObjectControls=false;syncScene();updateSceneUI();updateSpecimenLabel();renderNeeded=true;
}
async function changeScene(action:'sphere'|'box'|'remove') {
  if(!(engine instanceof SceneVolumeEngine)||switching||exporting)return;
  syncScene();switching=true;loadRevision++;updateSceneUI();
  try { if(action==='remove')await engine.remove();else await engine.add(action); loadObjectControls(); }
  catch(error){console.error(error);toast('Could not allocate another object. Try a lower volume resolution.');}
  finally{switching=false;updateSceneUI();renderNeeded=true;}
}
$('#add-sphere').addEventListener('click',()=>void changeScene('sphere'));$('#add-box').addEventListener('click',()=>void changeScene('box'));$('#remove-object').addEventListener('click',()=>void changeScene('remove'));
$('#scene-objects').addEventListener('click',e=>{
  if(!(engine instanceof SceneVolumeEngine)||switching||exporting)return;
  const button=(e.target as HTMLElement).closest<HTMLElement>('[data-object]');if(!button)return;
  loadRevision++;syncScene();engine.selected=Number(button.dataset.object);loadObjectControls();
});
['x','y','z'].forEach((axis,i)=>$('#object-'+axis).addEventListener('input',e=>{
  if(!(engine instanceof SceneVolumeEngine)||switching||exporting)return;
  const value=(e.target as HTMLInputElement).valueAsNumber;if(!Number.isFinite(value))return;
  engine.position[i]=Math.max(-6,Math.min(6,value));syncScene();updateSceneUI();renderNeeded=true;
}));
$('#interaction').addEventListener('input',e=>applySceneStrength(Number((e.target as HTMLInputElement).value)));
$('#scene-strength').addEventListener('input',e=>applySceneStrength(Number((e.target as HTMLInputElement).value)));
$('#scene-mix-mode').addEventListener('change',e=>{if(engine instanceof SceneVolumeEngine){engine.mixMode=parseMixMode((e.target as HTMLSelectElement).value);renderNeeded=true;updateSceneUI();}});
$('#scene-cut').addEventListener('input',e=>applySceneCut(Number((e.target as HTMLInputElement).value)));
$('#scene-cut-scope').addEventListener('change',e=>{if(engine instanceof SceneVolumeEngine){engine.setCutScope((e.target as HTMLSelectElement).value as 'all'|'selected');syncCutControls();renderNeeded=true;}});
$('#scene-fit').addEventListener('click',()=>$('#fit-object').click());
$('#move-object').addEventListener('click',()=>setTool('object'));

function applySceneStrength(value:number){if(engine instanceof SceneVolumeEngine){engine.interaction=value;updateSceneUI();renderNeeded=true;}}
function applySceneCut(value:number){if(engine instanceof SceneVolumeEngine)engine.setCut(value);else if(engine instanceof VolumeEngine)engine.cut=value;syncCutControls();renderNeeded=true;}
function syncCutControls(){
  if(!(engine instanceof VolumeEngine))return;
  for(const id of ['volume-cut','scene-cut'])$<HTMLInputElement>(`#${id}`).value=String(engine.cut);
  $('#cut-value').textContent=engine.cut===1?'Whole':`${Math.round((1-engine.cut)/2*100)}% removed`;
  $('#scene-cut').previousElementSibling!.textContent=engine instanceof SceneVolumeEngine&&engine.cutScope==='selected'?'Cut selected':'Cut all';
}
const objectHandles=new Map<string,HTMLButtonElement>();
let handlePointer:number|null=null;
let depthMove=false;
$('#scene-depth').addEventListener('click',()=>{depthMove=!depthMove;$('#scene-depth').setAttribute('aria-pressed',String(depthMove));updateSceneHandles();});
function updateSceneHandles(){
  if(!is3D||!(engine instanceof SceneVolumeEngine))return;
  const scene=engine,ids=new Set(scene.objects.map(o=>o.config.id));
  for(const [id,button] of objectHandles)if(!ids.has(id)){button.remove();objectHandles.delete(id);}
  const rect=$('#canvas-stage').getBoundingClientRect();
  const occupied:{x:number;y:number}[]=[];
  const topEdge=$('.hud-top').getBoundingClientRect().bottom+28;
  const leftEdge=!compact()&&docks.left?$('#dock-left').getBoundingClientRect().right+64:64;
  const rightEdge=!compact()&&docks.right?$('#dock-right').getBoundingClientRect().left-64:rect.width-64;
  const controlsEdge=$('#scene-quickbar').getBoundingClientRect().top-24;
  const bottomEdge=compact()&&(docks.left||docks.right)?Math.min($('#dock-'+(docks.left?'left':'right')).getBoundingClientRect().top-24,controlsEdge):controlsEdge;
  scene.objects.forEach((object,index)=>{
    let button=objectHandles.get(object.config.id);
    if(!button){
      button=document.createElement('button');button.type='button';button.className='scene-handle';button.dataset.objectId=object.config.id;
      button.innerHTML=`${icon('move')}<span></span>`;$('#scene-handles').append(button);objectHandles.set(object.config.id,button);
      button.addEventListener('pointerdown',e=>{
        if(!(engine instanceof SceneVolumeEngine)||switching||exporting||e.button!==0)return;
        e.preventDefault();e.stopPropagation();button!.focus({preventScroll:true});syncScene();const i=engine.objects.findIndex(o=>o.config.id===button!.dataset.objectId);
        if(i<0)return;engine.beginObjectDrag(i,e.clientX,e.clientY,zoom,e.shiftKey||depthMove);loadObjectControls();handlePointer=e.pointerId;button!.setPointerCapture(e.pointerId);$('#canvas-hint').classList.add('dismissed');
      });
      button.addEventListener('pointermove',e=>{if(handlePointer===e.pointerId&&engine instanceof SceneVolumeEngine&&engine.moveDrag(e.clientX,e.clientY,zoom)){updateSceneUI();renderNeeded=true;}});
      const release=()=>{if(engine instanceof SceneVolumeEngine)engine.endDrag();handlePointer=null;};
      button.addEventListener('pointerup',release);button.addEventListener('pointercancel',release);button.addEventListener('lostpointercapture',release);
      button.addEventListener('keydown',e=>{
        if(!(engine instanceof SceneVolumeEngine)||switching||exporting)return;
        const i=engine.objects.findIndex(o=>o.config.id===button!.dataset.objectId);if(i<0)return;
        if(e.key==='Enter'||e.key===' '){e.preventDefault();syncScene();engine.selected=i;loadObjectControls();}
        else if(e.key.startsWith('Arrow')){e.preventDefault();e.stopPropagation();syncScene();engine.selected=i;engine.loadActive();const amount=e.shiftKey?.05:.15;const axis=e.altKey?2:e.key==='ArrowLeft'||e.key==='ArrowRight'?0:1;engine.position[axis]+=(e.key==='ArrowLeft'||e.key==='ArrowDown'?-amount:amount);engine.position[axis]=Math.max(-6,Math.min(6,engine.position[axis]));engine.active.config.position=[...engine.position];loadObjectControls();renderNeeded=true;}
      });
    }
    button.querySelector('span')!.textContent=object.config.name;button.title='Drag to move · Shift-drag for depth · arrows to nudge';button.setAttribute('aria-label',`Move ${object.config.name}`);button.setAttribute('aria-pressed',String(index===scene.selected));button.style.setProperty('--object-color',object.config.palette.foreground);
    const p=scene.project(object.config.position,zoom);button.hidden=!p.visible;
    // Labels stay accessible at the edge even when a vessel is outside the current view.
    let x=Math.max(leftEdge,Math.min(rightEdge,p.x)),y=Math.max(topEdge,Math.min(bottomEdge,p.y-object.config.size*p.scale-20));
    for(let attempts=0;attempts<6&&occupied.some(point=>Math.abs(point.x-x)<120&&Math.abs(point.y-y)<31);attempts++){y+=34;if(y>bottomEdge){y=topEdge;x=Math.max(leftEdge,Math.min(rightEdge,x+124));}}
    occupied.push({x,y});button.style.left=`${x}px`;button.style.top=`${y}px`;
  });
  $('#scene-feedback').textContent=depthMove?'Depth mode · drag up/down to move toward or away · toggle Depth to return':scene.contacts>0?`${scene.contacts} overlap${scene.contacts===1?'':'s'} · ${mixNames[scene.mixMode]} · drag objects to reshape the junction`:'Drag objects or labels together · background drag orbits · Shift-drag moves in depth';
}

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
const reconcileCompactDocks = () => { if (compact() && docks.left && docks.right) setDock('right', false); };
matchMedia('(max-width: 820px)').addEventListener('change', reconcileCompactDocks);
reconcileCompactDocks();

// ---------- Parameters ----------
const matchesPreset = () => { const p = presets[presetIndex]; return params.feed === p.feed && params.kill === p.kill && params.diffusionA === 1 && params.diffusionB === .5; };
const matchesSaved = (p: SavedPreset) => (p.dimension === '3d') === is3D && p.feed === params.feed && p.kill === params.kill && p.diffusionA === params.diffusionA && p.diffusionB === params.diffusionB && p.background === palette.background && p.foreground === palette.foreground && p.threshold === threshold && p.speed === speed && (is3D ? parseVolumeResolution(p.resolution) : parseResolution(p.resolution)) === resolution;
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
  $('#iteration-count').textContent = '0'; setRunning(start.mode !== 'empty' && !start.paused);syncScene();updateSceneUI();
}
function makeStartField(settings = start, seedNumber = seed, targetWidth = width, targetHeight = height, volume = is3D) {
  if (volume) return makeVolumeSeed(targetWidth, seedNumber, settings, volumeShape);
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
  const field = is3D ? makeVolumeSeed(512, seed, start, volumeShape) : makeStartField();
  const image = context.createImageData(canvas.width, canvas.height);
  const color = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const background = color(palette.background), foreground = color(palette.foreground);
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    const cell = is3D ? (256 + Math.floor(y / canvas.height * 64)) * 512 + Math.floor(x / canvas.width * 64) : Math.floor(y / canvas.height * height) * width + Math.floor(x / canvas.width * width);
    const b = field[cell * 2 + 1];
    const offset = (y * canvas.width + x) * 4;
    for (let channel = 0; channel < 3; channel++) image.data[offset + channel] = b > 0 ? foreground[channel] : background[channel];
    image.data[offset + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  $('#start-preview-note').textContent = start.mode === 'empty' ? 'Empty · paint to begin' : start.mode === 'image' && !start.imageMask ? 'Choose an image to begin' : is3D ? 'Initial field · central Z slice' : 'Initial field · before growth';
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
  drawStartPreview();syncScene();updateSceneUI();
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
  const before = anchor && !is3D ? toGrid(anchor.clientX, anchor.clientY) : null;
  zoom = next;
  if (before && anchor) { const after = toGrid(anchor.clientX, anchor.clientY); setPan(pan.x + before.x - after.x, pan.y + before.y - after.y); }
  $('#zoom-reset').textContent = `${Math.round(zoom * 100)}%`; renderNeeded = true;
}
function orbitVolume(dx: number, dy: number) { if (engine instanceof VolumeEngine) { engine.orbit.x = (engine.orbit.x + dx) % (Math.PI * 2); engine.orbit.y = Math.max(-1.3, Math.min(1.3, engine.orbit.y + dy)); renderNeeded = true; } }
function resetView() { if (engine instanceof VolumeEngine) engine.orbit = { x: .45, y: -.25 }; setZoom(1); setPan(0, 0); }
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
    if (!engine || switching || exporting) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); canvas.setPointerCapture(e.pointerId); closeExport(); $('#canvas-hint').classList.add('dismissed');
    if (pointers.size === 2) {
      // Second finger: stop painting and start a pinch.
      drawing = false; brush = { ...idleBrush }; pendingBrush = null;
      const [a, b] = [...pointers.values()]; pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom, center: toGrid((a.x + b.x) / 2, (a.y + b.y) / 2) }; return;
    }
    if(tool==='object' && engine instanceof SceneVolumeEngine && e.button===0&&!e.altKey) {syncScene();panning=true;if(engine.beginDrag(e.clientX,e.clientY,zoom,e.shiftKey||depthMove)){loadObjectControls();}else last={x:e.clientX,y:e.clientY};e.preventDefault();return;}
    if (e.button === 1 || e.button === 2 || tool === 'hand' || (e.button === 0 && e.altKey)) { panning = true; last = { x: e.clientX, y: e.clientY }; e.preventDefault(); return; }
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
    if(panning && tool==='object' && engine instanceof SceneVolumeEngine && engine.dragging) {if(engine.moveDrag(e.clientX,e.clientY,zoom)){updateSceneUI();renderNeeded=true;}return;}
    if (panning && last && engine instanceof VolumeEngine) { orbitVolume(-(e.clientX-last.x)*.008, (e.clientY-last.y)*.008); last = { x: e.clientX, y: e.clientY }; renderNeeded = true; return; }
    if (panning && last) { const k = cellsPerPixel(); setPan(pan.x - (e.clientX - last.x) * k, pan.y - (e.clientY - last.y) * k); last = { x: e.clientX, y: e.clientY }; return; }
    if(tool==='hand'||tool==='object'){cursor.classList.remove('visible');return;}
    const rect = canvas.getBoundingClientRect(); const diameter = brushSize * resolution * 2 / cellsPerPixel();
    cursor.style.width = `${diameter}px`; cursor.style.height = `${diameter}px`; cursor.style.left = `${e.clientX - rect.left}px`; cursor.style.top = `${e.clientY - rect.top}px`; cursor.classList.add('visible');
    cursor.classList.toggle('erasing', tool === 'eraser' || e.shiftKey); if (drawing) paint(e);
  });
  const release = (e: PointerEvent) => { if(engine instanceof SceneVolumeEngine)engine.endDrag(); pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; if (pointers.size === 0) { drawing = false; panning = false; last = null; brush = { ...idleBrush }; } };
  canvas.addEventListener('pointerup', release); canvas.addEventListener('pointercancel', release); canvas.addEventListener('lostpointercapture', release);
  canvas.addEventListener('pointerleave', () => cursor.classList.remove('visible'));
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    if (is3D) { setZoom(zoom * Math.exp(-e.deltaY * .002)); return; }
    if (e.ctrlKey || e.metaKey) { setZoom(zoom * Math.exp(-e.deltaY * .01), e); return; }
    const k = cellsPerPixel(); setPan(pan.x + e.deltaX * k, pan.y + e.deltaY * k);
  }, { passive: false });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); if (!switching && canvas === $('#simulation')) { setRunning(false); toast('GPU context lost. Choose a compute engine to restart.'); $('#engine-status').textContent = 'GPU disconnected'; } });
}
function paint(e: PointerEvent) {
  syncScene();const selected=engine instanceof SceneVolumeEngine?engine.selected:-1;
  if (engine instanceof VolumeEngine && !engine.pick(e.clientX,e.clientY,zoom)) { brush = { ...idleBrush }; return; }
  if(engine instanceof SceneVolumeEngine&&selected!==engine.selected){loadRevision++;loadObjectControls();}
  const g = toGrid(e.clientX, e.clientY);
  brush = { x: wrap(g.x, width), y: wrap(g.y, height), radius: brushSize * resolution, mode: tool === 'eraser' || e.shiftKey ? -1 : 1, amount: start.amount };
  warmup = 0;
  // Preserve quick taps even when pointerup occurs before the next animation frame.
  pendingBrush = { ...brush };
  renderNeeded = true;
}
const sizeCanvas = (canvas: HTMLCanvasElement, volume = is3D) => { const rect = canvas.getBoundingClientRect(); const dpr = Math.min(window.devicePixelRatio, volume ? .8 : 2); canvas.width = Math.max(1, Math.round(rect.width * dpr)); canvas.height = Math.max(1, Math.round(rect.height * dpr)); renderNeeded = true; };
new ResizeObserver(() => sizeCanvas($<HTMLCanvasElement>('#simulation'))).observe($('#canvas-stage'));

// ---------- Engine lifecycle ----------
function updateResolutionUI() {
  if (is3D) {
    $<HTMLSelectElement>('#resolution').value = String(resolution);
    $('#grid-size').textContent = `${64 * resolution}³ cells`;
    $('#resolution-hint').textContent = `${(64 * resolution) ** 3 / 1048576 < 1 ? '262,144' : ((64 * resolution) ** 3 / 1000000).toFixed(1) + ' million'} cells · ${resolution ** 3}× compute · ${4 * resolution ** 3} MiB per object · ${engine instanceof SceneVolumeEngine?engine.objects.length:1} object(s). Higher resolutions preserve the current volume and use more GPU memory.`;
    return;
  }
  const highest = resolutions[resolutions.length - 1];
  $<HTMLSelectElement>('#resolution').value = String(resolution);
  $('#grid-size').textContent = `${width} × ${height}`;
  $('#resolution-hint').textContent = resolution === 1
    ? `Higher bases use more GPU memory and may run slower. 2× uses 4× as many cells; ${highest}× uses ${highest * highest}×.`
    : `${is3D ? resolution ** 3 : resolution * resolution}× as many cells as 1×. More GPU work and memory; may run slower on your device. Lower evolution speed if needed.`;
}
interface DimensionSession {
  field: Float32Array; width: number; height: number; resolution: Resolution;
  zoom: number; pan: View; tool: Tool; iterations: number; warmup: number; running: boolean;
  orbit?: View; cut?: number; scene?: VolumeSceneSnapshot;
}
const dimensionSessions = new Map<boolean, DimensionSession>();
let dimensionTransition = false;
async function switchDimension() {
  if (switching || exporting || dimensionTransition || !engine) return;
  dimensionTransition = true;
  closeExport();
  const target = !is3D;
  const ghost = document.createElement('canvas');
  const current = $<HTMLCanvasElement>('#simulation');
  engine.render(palette, threshold, zoom, pan);
  ghost.width = current.width; ghost.height = current.height; ghost.className = 'dimension-ghost';
  ghost.setAttribute('aria-hidden', 'true'); ghost.getContext('2d')!.drawImage(current, 0, 0);
  $('#canvas-stage').append(ghost); root.dataset.transitioning = 'true';
  $<HTMLButtonElement>('#dimension-toggle').disabled = true;
  try {
    const nextResolution = dimensionSessions.get(target)?.resolution ?? (target ? parseVolumeResolution(resolution) : resolution);
    if (!await initialize($<HTMLSelectElement>('#backend').value, nextResolution, target)) return;
    const q = stateParams(); q.set('paused', running ? '0' : '1');
    history.replaceState(null, '', `${location.pathname}?${q}${location.hash}`);
    const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 520;
    const incoming = $('#simulation').animate([
      { clipPath: target ? 'inset(0 100% 0 0)' : 'inset(0 0 0 100%)', opacity: .65 },
      { clipPath: 'inset(0 0 0 0)', opacity: 1 },
    ], { duration, easing: 'cubic-bezier(.2,.7,.2,1)' });
    ghost.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: target ? 'scale(.96)' : 'scale(1.04)' }], { duration, fill: 'forwards' });
    await incoming.finished;
  } finally {
    ghost.remove(); delete root.dataset.transitioning; dimensionTransition = false;
    $<HTMLButtonElement>('#dimension-toggle').disabled = false;
  }
}
async function initialize(backend = 'auto', nextResolution: Resolution = resolution, nextDimension = is3D): Promise<boolean> {
  if (switching || exporting) return false;
  loadRevision++; switching = true;
  $<HTMLSelectElement>('#backend').disabled = true; $<HTMLSelectElement>('#resolution').disabled = true;
  $('#loading').hidden = false; $('#loading-text').textContent = 'Preparing the simulation…';
  const previousDimension = is3D, changingDimension = nextDimension !== is3D;
  const previousEngine = engine, previousCanvas = $<HTMLCanvasElement>('#simulation');
  const nextSize = nextDimension ? volumeGridSize(nextResolution) : gridSize(nextResolution);
  const restored = changingDimension ? dimensionSessions.get(nextDimension) : undefined;
  let candidate: Engine | null = null;
  let canvas = previousCanvas;
  const replaceCanvas = () => {
    const replacement = previousCanvas.cloneNode(false) as HTMLCanvasElement;
    canvas.replaceWith(replacement); canvas = replacement;
    attachCanvas(); sizeCanvas(canvas, nextDimension); return canvas;
  };
  try {
    syncScene();
    let previousScene: VolumeSceneSnapshot | undefined;
    let previous: Float32Array | undefined;
    try { if(previousEngine instanceof SceneVolumeEngine) { previousScene=await previousEngine.snapshot();previous=previousScene.objects[previousScene.selected].field; } else previous = await previousEngine?.read(); }
    catch (error) { if (previousEngine && (changingDimension || nextResolution !== resolution)) throw error; }
    replaceCanvas();
    if (backend !== 'webgl') {
      try {
        const onLost = () => {
          if (engine === candidate) { toast('WebGPU disconnected. Restarting with WebGL.'); void initialize('webgl'); }
        };
        candidate = nextDimension
          ? await SceneVolumeEngine.create(canvas,64*nextResolution,'webgpu',activeObjectConfig(),onLost)
          : await WebGPUEngine.create(canvas, nextSize.width, nextSize.height, onLost);
      } catch (error) {
        if (backend === 'webgpu') toast('WebGPU unavailable. Using WebGL 2.');
        console.info('WebGPU fallback:', error); replaceCanvas();
      }
    }
    candidate ??= nextDimension ? await SceneVolumeEngine.create(canvas,64*nextResolution,'webgl',activeObjectConfig(),()=>{}) : new WebGLEngine(canvas, nextSize.width, nextSize.height);
    if (candidate instanceof VolumeEngine) {
      candidate.shape = volumeShape; candidate.objectSize = objectSize; candidate.showFloor = showFloor;
      candidate.orbit = restored?.orbit ? { ...restored.orbit } : previousEngine instanceof VolumeEngine ? { ...previousEngine.orbit } : { x: num('yaw', .45, -100, 100), y: num('pitch', -.25, -1.3, 1.3) };
      candidate.cut = restored?.cut ?? (previousEngine instanceof VolumeEngine ? previousEngine.cut : num('cut', 1, -.9, 1));
    }
    if(candidate instanceof SceneVolumeEngine){candidate.sceneCut=candidate.cut;candidate.active.config.cut=candidate.cut;}
    const sceneSnapshot=changingDimension?restored?.scene:previousScene;
    if(candidate instanceof SceneVolumeEngine) {
      if(sceneSnapshot)await candidate.restore(sceneSnapshot,changingDimension?restored!.width/8:previousEngine!.width/8);
      else {const shared=parseSceneRecipe(query.get('scene'));if(shared&&!previousEngine)await candidate.seedRecipe(shared);}
    }
    const preserved = changingDimension ? restored?.field : previous;
    if(!(candidate instanceof SceneVolumeEngine && (sceneSnapshot || (!previousEngine && parseSceneRecipe(query.get('scene')))))) candidate.seed(preserved && (restored || previousEngine)
      ? changingDimension ? preserved : nextDimension ? resizeVolume(preserved, previousEngine!.width / 8, nextSize.width / 8) : resizeField(preserved, previousEngine!.width, previousEngine!.height, nextSize.width, nextSize.height)
      : makeStartField(start, seed, nextSize.width, nextSize.height, nextDimension));
    if (changingDimension && previous && previousEngine) {
      dimensionSessions.set(previousDimension, { field: previous, width: previousEngine.width, height: previousEngine.height, resolution,
        zoom, pan: { ...pan }, tool, iterations, warmup, running, scene:previousScene,
        ...(previousEngine instanceof VolumeEngine ? { orbit: { ...previousEngine.orbit }, cut: previousEngine.cut } : {}),
      });
      // The active engine owns this field now; keep only the inactive mode's snapshot.
      dimensionSessions.delete(nextDimension);
    }
    const scale = nextResolution / resolution;
    is3D = nextDimension; resolution = nextResolution; ({ width, height } = nextSize);
    engine = candidate; previousEngine?.destroy();
    if (changingDimension) {
      setPan(restored?.pan.x ?? 0, restored?.pan.y ?? 0); setZoom(restored?.zoom ?? 1); setTool(restored?.tool ?? (is3D ? 'object' : 'brush'));
      iterations = restored?.iterations ?? 0; warmup = restored?.warmup ?? 0;
      if (restored) setRunning(restored.running);
      post({ type: 'leave', id: link.id }); link.sent = null; link.sentAt = -Infinity; link.captureBroken = null;
      link.layerDirty = true;
      renderSaved(); updateLinkUI();
    } else setPan(pan.x * scale, pan.y * scale);
    if(engine instanceof SceneVolumeEngine)loadObjectControls();
    updateDimensionUI();
    applyLayer();
    drawing = false; panning = false; pointers.clear(); pinch = null; last = null;
    brush = { ...idleBrush }; pendingBrush = null; $('#brush-cursor').classList.remove('visible');
    if (!previous && !changingDimension) { warmup = start.grown && !start.paused && start.mode !== 'empty' ? 1200 : 0; iterations = 0; setRunning(start.mode !== 'empty' && !start.paused && (start.mode !== 'image' || !!start.imageMask)); }
    $('#engine-status').textContent = engine.backend; $('#loading').hidden = true;
    $('#iteration-count').textContent = iterations.toLocaleString('en-US');
    const select = $<HTMLSelectElement>('#backend'); select.options[0].textContent = `Auto · ${engine.backend}`;
    if (backend !== 'auto') select.value = engine.backend === 'WebGPU' ? 'webgpu' : 'webgl';
    updateResolutionUI(); updateSpecimenLabel(); drawStartPreview(); renderNeeded = true;
    engine.render(palette, threshold, zoom, pan);
    return true;
  } catch (error) {
    candidate?.destroy();
    if (canvas !== previousCanvas) canvas.replaceWith(previousCanvas);
    engine = previousEngine;
    if (engine) {
      sizeCanvas(previousCanvas); $('#loading').hidden = true; $('#engine-status').textContent = engine.backend;
      if (backend !== 'auto') $<HTMLSelectElement>('#backend').value = engine.backend === 'WebGPU' ? 'webgpu' : 'webgl';
      toast('Could not change the simulation. Your previous field is preserved. Try a lower resolution or another compute engine.');
    } else {
      $('#loading-text').textContent = error instanceof Error ? error.message : 'Could not start the GPU. Try a lower base resolution.';
      $('#engine-status').textContent = 'GPU unavailable';
    }
    console.error(error); updateResolutionUI(); return false;
  } finally {
    switching = false; updateSceneUI(); $<HTMLSelectElement>('#backend').disabled = false; $<HTMLSelectElement>('#resolution').disabled = false;
  }
}
$('#backend').addEventListener('change', e => void initialize((e.target as HTMLSelectElement).value));
$('#resolution').addEventListener('change', async e => {
  const next = is3D ? parseVolumeResolution((e.target as HTMLSelectElement).value) : parseResolution((e.target as HTMLSelectElement).value);
  if (next === resolution || switching || exporting) { updateResolutionUI(); return; }
  if (await initialize($<HTMLSelectElement>('#backend').value, next)) {
    toast(is3D ? `${64*resolution}³ volume. Current field preserved.` : `${resolution}× base resolution. ${resolution === 1 ? 'Default GPU workload.' : `${resolution * resolution}× as many cells; performance depends on your device.`}`);
  }
});

// ---------- Linked windows ----------
// Same-origin windows share their screen rectangles and a small capture of their
// visible field over a BroadcastChannel. Where rectangles overlap, each window
// composites the others into a layer the compute shader couples with.
const linkable = !embed && window === window.top && 'BroadcastChannel' in window;
const newLinkId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
const link = {
  id: newLinkId(), channel: linkable ? new BroadcastChannel('morphlab-windows') : null,
  rect: { x: 0, y: 0, w: 0, h: 0 } as Rect, focusedAt: Date.now(),
  sent: null as PeerState | null, sentAt: -Infinity, capturedAt: 0, capturing: false, captureBroken: null as Engine | null,
  layerDirty: false, overlapping: false, peerCount: 0, layer: new Uint8Array(LAYER_WIDTH * LAYER_HEIGHT * 4),
};
const registry = new PeerRegistry(link.id);
const linkState = (): PeerState => ({ id: link.id, rect: { ...link.rect }, focusedAt: link.focusedAt, feed: params.feed, kill: params.kill, background: palette.background, foreground: palette.foreground, mix: mixMode, mixChangedAt });
function post(message: LinkMessage) { try { link.channel?.postMessage(message); } catch (error) { console.warn('Could not reach the other windows.', error); } }
function applyLayer() {
  link.layerDirty = false;
  if (!engine || is3D) return;
  const { data, slots } = compositeLayer(link.rect, link.focusedAt, registry.peers(), link.layer);
  engine.setCoupling({ layer: slots.length ? data : null, slots, mode: mixMode, strength: mixStrength });
  renderNeeded = true;
}
function updateLinkUI() {
  const peers = link.peerCount, { overlapping } = link;
  $('#link-chip').hidden = is3D || !peers; $('#link-chip').classList.toggle('overlapping', overlapping);
  $('#link-chip-text').textContent = `${peers + 1} windows`;
  $('#link-count').textContent = peers ? `${peers + 1} linked` : '';
  $('#link-status').classList.toggle('overlapping', overlapping);
  $('#link-status').textContent = !linkable ? 'Linking works in a full browser window, not inside an embed.'
    : !peers ? 'No other windows yet. Open one, then drag it over this one.'
    : overlapping ? `Overlapping ${peers === 1 ? 'another window' : `${peers} windows`} · ${mixNames[mixMode].toLowerCase()}`
    : `${peers} other window${peers === 1 ? '' : 's'} open. Drag them together to mix.`;
}
function setMix(mode: MixMode, at = Date.now(), announce = true) {
  mixMode = mode; mixChangedAt = at;
  $<HTMLSelectElement>('#mix-mode').value = mode; $('#mix-hint').textContent = mixHints[mode];
  link.layerDirty = true; if (announce) link.sentAt = -Infinity;
  updateLinkUI();
}
function linkTick(now: number) {
  if (!link.channel || is3D) return;
  const rect = viewportRect(window);
  if (!sameRect(rect, link.rect)) { link.rect = rect; link.layerDirty = true; }
  const state = linkState();
  if (!link.sent || !sameState(state, link.sent) || now - link.sentAt > 500) { post({ type: 'state', state }); link.sent = state; link.sentAt = now; }
  if (registry.expire(Date.now())) link.layerDirty = true;
  const peers = registry.peers().length, overlapping = registry.overlapping(rect).length > 0;
  if (peers !== link.peerCount || overlapping !== link.overlapping) { link.peerCount = peers; link.overlapping = overlapping; link.layerDirty = true; updateLinkUI(); }
}
async function shareField(view: ViewState, now: number) {
  if (!engine || link.capturing || link.captureBroken === engine) return;
  const target = engine, rect = { ...link.rect };
  link.capturing = true; link.capturedAt = now;
  try {
    const rgba = await target.capture(view);
    if (rgba && engine === target) post({ type: 'field', id: link.id, snapshot: { rect, width: LAYER_WIDTH, height: LAYER_HEIGHT, data: stripToAB(rgba) } });
  } catch (error) { console.warn('Could not share the field with the other windows.', error); link.captureBroken = target; }
  finally { link.capturing = false; }
}
function openLinkedWindow() {
  if (is3D) { toast('3D currently supports one isolated object.'); return; }
  if (!linkable) { toast('Linking works in a full browser window, not inside an embed.'); return; }
  const q = new URLSearchParams();
  q.set('p', String((presetIndex + 1 + Math.floor(Math.random() * (presets.length - 1))) % presets.length));
  q.set('seed', String(crypto.getRandomValues(new Uint32Array(1))[0]));
  const next = palettes[(paletteIndex + 1 + Math.floor(Math.random() * (palettes.length - 1))) % palettes.length];
  q.set('bg', next.background.slice(1)); q.set('fg', next.foreground.slice(1));
  q.set('w', threshold.toFixed(3)); q.set('s', String(speed)); if (resolution !== 1) q.set('r', String(resolution)); if (mixMode !== 'melt') q.set('mix', mixMode);
  const features = `popup=yes,width=${innerWidth},height=${innerHeight},left=${screenX + 72},top=${screenY + 72}`;
  if (!window.open(`${location.origin}${location.pathname}?${q}`, '_blank', features)) { toast('Allow pop-ups for this site to open a linked window.'); return; }
  toast('Drag the new window over this one and watch the two patterns mix.');
}
if (link.channel) {
  link.channel.onmessage = e => {
    if (is3D) return;
    const message = e.data as LinkMessage;
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;
    const known = message.type !== 'state' || registry.peers().some(p => p.id === message.state.id);
    if (registry.receive(message, Date.now())) link.layerDirty = true;
    // Introduce ourselves to a new window right away instead of waiting for the heartbeat.
    if (!known) link.sentAt = -Infinity;
    if (message.type === 'state') { const newest = newestMix([message.state, { mix: mixMode, mixChangedAt }]); if (newest && newest.mix !== mixMode) setMix(newest.mix, newest.mixChangedAt, false); }
  };
  window.addEventListener('focus', () => { link.focusedAt = Date.now(); link.layerDirty = true; });
  window.addEventListener('pagehide', () => post({ type: 'leave', id: link.id }));
}
$('#open-window').addEventListener('click', openLinkedWindow);
$('#link-chip').addEventListener('click', () => { setDock('left', true); $('#mix-mode').closest('.section')?.scrollIntoView({ block: 'nearest' }); });
$('#mix-mode').addEventListener('change', e => setMix(parseMixMode((e.target as HTMLSelectElement).value)));
const updateStrengthLabel = () => { $('#mix-strength-value').textContent = `${Math.round(mixStrength * 100)}%`; };
$('#mix-strength').addEventListener('input', e => { mixStrength = Number((e.target as HTMLInputElement).value); updateStrengthLabel(); link.layerDirty = true; });

let lastTime = 0, frames = 0, fpsTime = 0;
function frame(time: number) {
  requestAnimationFrame(frame); syncSelects();
  if (!engine || switching || document.hidden || exporting) return;
  // Limit submission to 60 Hz so high refresh displays do not change the evolution speed.
  if (time - lastTime < 15) return; lastTime = time;
  try {
    syncScene();linkTick(time);
    if (link.layerDirty) applyLayer();
    const view: ViewState = { zoom, pan: { ...pan } };
    if (warmup > 0 && running) { const steps = Math.min(Math.max(1, Math.floor(80 / (is3D ? resolution ** 3 : resolution * resolution))), warmup); engine.step(params, steps, undefined, view); warmup -= steps; iterations += steps; renderNeeded = true; }
    else if (running || drawing || pendingBrush) { const steps = running ? speed : 1; engine.step(params, steps, pendingBrush ?? brush, view); pendingBrush = null; iterations += steps; renderNeeded = true; }
    if (renderNeeded) { engine.render(palette, threshold, zoom, pan); renderNeeded = false; }
    if (!is3D && link.overlapping && time - link.capturedAt > 33) void shareField(view, time);
    updateSceneHandles();
    if (!fpsTime) fpsTime = time;
    frames++;
    if (time - fpsTime > 650) { if (running) $('#fps').textContent = `${Math.min(60, Math.round(frames * 1000 / (time - fpsTime)))} fps`; $('#iteration-count').textContent = iterations.toLocaleString('en-US'); frames = 0; fpsTime = time; }
  } catch (error) { setRunning(false); console.error(error); $('#engine-status').textContent = 'GPU interrupted'; engine?.destroy(); engine = null; toast('The GPU stopped. Select a compute engine to restart.'); }
}

// ---------- Export ----------
function closeExport() { $('#export-menu').hidden = true; $('#export-toggle').setAttribute('aria-expanded', 'false'); }
$('#export-toggle').addEventListener('click', () => { const open = $('#export-menu').hidden; $('#export-menu').hidden = !open; $('#export-toggle').setAttribute('aria-expanded', String(open)); });
document.addEventListener('click', e => { if (!(e.target as HTMLElement).closest('.export-wrap')) closeExport(); });
async function exportPattern(format: 'png' | 'svg', baseScale = 4) {
  if (!engine || exporting || switching) return;
  if (is3D) {
    closeExport(); engine.render(palette, threshold, zoom, pan);
    $<HTMLCanvasElement>('#simulation').toBlob(blob => { if (blob) { download(blob, `morph-3d-${seed}.png`); toast('3D view exported.'); } else toast('Could not export the 3D view.'); });
    return;
  }
  exporting = true; closeExport();
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
$('#export-3d').addEventListener('click', () => {
  if(!(engine instanceof SceneVolumeEngine)||switching||exporting)return;
  closeExport();
  showDialog(`<h2>Export a 3D mesh</h2><p>The solid follows each object's chemical B surface at its current pattern weight. Export the selected object for slicing, or keep the entire arrangement.</p>
    <div class="embed-options"><label class="select-field"><span>Format</span><select id="mesh-format"><option value="stl">STL · slicers / printing</option><option value="obj">OBJ · 3D modeling</option></select></label>
    <label class="select-field"><span>Objects</span><select id="mesh-scope"><option value="selected">Selected object</option><option value="scene">Entire scene</option></select></label></div>
    <label class="select-field"><span>Mesh resolution</span><select id="mesh-samples"><option value="64">64³ · smaller file</option><option value="96" selected>96³ · balanced</option><option value="128">128³ · finer surface</option><option value="256">Simulation resolution · full detail</option></select></label>
    <label class="select-field" for="mesh-mm"><span>Longest dimension in millimetres</span></label><input id="mesh-mm" class="text-input" type="number" min="10" max="500" step="1" value="100"/>
    <label class="check-field"><input id="mesh-cutaway" type="checkbox"/><span>Include cutaways, with closed caps</span></label>
    <p class="field-hint">STL uses millimetres and Z up. Multiple shells can need supports or repair in your slicer. Melt and Crossbreed export the fused scene. Other modes keep separate solids. Wall thickness and print strength are not assessed.</p>
    <div class="mesh-report" id="mesh-report" role="status">Ready to extract the surface.</div>
    <div class="dialog-actions"><button class="primary-button" id="mesh-build">${icon('cube')} Build mesh</button><button class="primary-button" id="mesh-download" hidden>${icon('download')} Download</button><button class="text-button" id="mesh-cancel">Close</button></div>`);
  let worker:Worker|null=null,cancelled=false,blob:Blob|null=null,extension='stl';
  const report=$('#mesh-report'),button=$<HTMLButtonElement>('#mesh-build'),save=$<HTMLButtonElement>('#mesh-download');
  const cancel=()=>{cancelled=true;worker?.terminate();worker=null;exporting=false;renderNeeded=true;updateSceneUI();};
  dialog.addEventListener('close',cancel,{once:true});$('#mesh-cancel').addEventListener('click',()=>dialog.close());
  save.addEventListener('click',()=>{if(blob)download(blob,`morph-scene-${seed}.${extension}`);});
  const finish=()=>{worker?.terminate();worker=null;exporting=false;button.disabled=false;renderNeeded=true;updateSceneUI();};
  button.addEventListener('click',async()=>{
    if(!(engine instanceof SceneVolumeEngine)||exporting||switching)return;
    const millimetres=$<HTMLInputElement>('#mesh-mm').valueAsNumber;
    if(!Number.isFinite(millimetres)||millimetres<10||millimetres>500){report.textContent='Choose a size between 10 and 500 mm.';return;}
    exporting=true;button.disabled=true;save.hidden=true;blob=null;syncScene();updateSceneUI();
    const scene=engine,scope=$<HTMLSelectElement>('#mesh-scope').value;
    const objects=(scope==='scene'?scene.objects:[scene.active]).map(object=>({config:{...structuredClone(object.config),cut:scene.effectiveCut(object.config)},engine:object.engine}));
    const format=$<HTMLSelectElement>('#mesh-format').value as 'stl'|'obj';extension=format;
    const samples=Math.min(scene.size,Number($<HTMLSelectElement>('#mesh-samples').value));
    const cutaway=$<HTMLInputElement>('#mesh-cutaway').checked;
    report.textContent='Reading the chemical fields…';
    try {
      const fields=await Promise.all(objects.map(object=>object.engine.read()));if(cancelled){finish();return;}
      worker=new Worker(new URL('./mesh3d.worker.ts',import.meta.url),{type:'module'});
      worker.onerror=event=>{report.textContent=`Mesh export failed: ${event.message}`;finish();};
      worker.onmessage=event=>{
        if(cancelled)return;
        const message=event.data;
        if(message.kind==='progress'){report.textContent=`Extracting surface · ${Math.round(message.fraction*100)}%`;return;}
        if(message.kind==='error'){report.textContent=message.message;finish();return;}
        if(message.kind==='complete') {
          const triangles=message.stats.reduce((n:number,s:{triangles:number})=>n+s.triangles,0);
          const shells=message.stats.reduce((n:number,s:{components:number})=>n+s.components,0);
          const closed=message.stats.every((s:{closed:boolean})=>s.closed);
          blob=new Blob([message.data],{type:format==='stl'?'model/stl':'text/plain'});
          report.textContent=`${triangles.toLocaleString()} triangles · ${shells} shell(s)\n${message.dimensions.map((v:number)=>v.toFixed(1)).join(' × ')} mm · ${(blob.size/1048576).toFixed(1)} MiB\n${closed?'Closed surfaces, no open or non-manifold edges.':'Open or non-manifold edges detected. Repair before slicing.'}${scope==='scene'&&objects.length>1?(message.merged?'\nFused scene surface.':'\nObjects retain their positions and separate shells.'):''}`;
          save.hidden=false;finish();
        }
      };
      worker.postMessage({objects:objects.map((object,i)=>({config:object.config,field:fields[i]})),size:scene.size,samples,millimetres,format,cutaway,mode:scene.mixMode,strength:scene.interaction,merge:scope==='scene'},fields.map(field=>field.buffer));
    } catch(error){report.textContent=error instanceof Error?error.message:String(error);finish();}
  });
});
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
  showDialog(`<h2>Embed this pattern</h2><p>Runs live on the viewer's GPU with your current recipe, colors, seed, and ${resolution}× base resolution. Paste it into any page.</p>${resolution > 1 ? `<p>This base uses ${is3D ? resolution ** 3 : resolution * resolution}× as many cells as 1× and may run slower on visitors' devices.</p>` : ''}
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
  const saved = store.getState().saved.filter(p => (p.dimension === '3d') === is3D);
  $('#saved-count').textContent = saved.length ? String(saved.length) : '';
  $('#saved-list').innerHTML = saved.length ? saved.map(p => `<div class="preset saved-card" data-saved="${p.id}" role="button" tabindex="0" aria-pressed="false"><span class="preset-art" style="${p.art ? `background-image:url('${p.art}')` : `background:linear-gradient(135deg,${p.background} 50%,${p.foreground} 50%)`}"></span><span class="preset-info"><span class="preset-name">${escapeHTML(p.name)}</span><small>${new Date(p.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</small><code>f ${p.feed.toFixed(4)} · k ${p.kill.toFixed(4)}</code></span><button class="icon-button small preset-delete" data-delete="${p.id}" title="Delete" aria-label="Delete ${escapeHTML(p.name)}">${icon('trash')}</button></div>`).join('')
    : `<p class="saved-empty">Nothing saved yet. Tune a recipe you like, then save it to come back later.</p>`;
  updateSpecimenLabel();
}
async function applySaved(p: SavedPreset) {
  if (!engine || switching || exporting) { toast('Wait for the simulation to be ready, then try again.'); return; }
  const savedResolution = is3D ? parseVolumeResolution(p.resolution) : parseResolution(p.resolution);
  const savedSize = simulationSize(savedResolution);
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
  if (engine instanceof VolumeEngine) { showFloor = p.showFloor ?? true; engine.showFloor = showFloor; $<HTMLInputElement>('#show-floor').checked = showFloor; objectSize = p.objectSize ?? 1; engine.objectSize = objectSize; $<HTMLInputElement>('#object-size').value = String(objectSize); $('#object-size-value').textContent = `${objectSize.toFixed(1)}×`; volumeShape = p.shape ?? 'sphere'; engine.shape = volumeShape; engine.orbit = p.orbit ? { ...p.orbit } : { x: .45, y: -.25 }; engine.cut = p.cut ?? 1; $<HTMLInputElement>('#volume-cut').value = String(engine.cut); $('#volume-cut').dispatchEvent(new Event('input')); $$('[data-shape]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.shape === volumeShape))); }
  start = normalizeStart(p.start ?? defaultStart(p.seedMode), p.seedMode);
  imagePixels = null; imageRevision++;
  if(engine instanceof SceneVolumeEngine) {
    switching=true;
    try {if(snapshot?.scene)await engine.restore(snapshot.scene);else {while(engine.objects.length>1){engine.selected=engine.objects.length-1;await engine.remove();}engine.selected=0;engine.shape=p.shape??'sphere';engine.objectSize=p.objectSize??1;engine.cut=p.cut??1;engine.position=[0,0,0];engine.seed(snapshot?.field??makeStartField(start,p.seed));}}
    catch(error){console.error(error);toast('Could not restore all scene objects.');return;}finally{switching=false;}
  } else engine!.seed(snapshot?.field ?? makeStartField(start, p.seed));
  loadingObjectControls=!!snapshot?.scene;
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
  loadingObjectControls=false;
  if(engine instanceof SceneVolumeEngine){if(snapshot?.scene)loadObjectControls();else syncScene();updateSceneUI();}
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
function volumeThumbnail() {
  const thumbnail = document.createElement('canvas'); thumbnail.width = 280; thumbnail.height = 175;
  thumbnail.getContext('2d')!.drawImage($<HTMLCanvasElement>('#simulation'), 0, 0, 280, 175);
  return thumbnail.toDataURL('image/webp', .7);
}
async function openSaveDialog() {
  if (embed || dialog.open) return;
  if (!engine || switching || exporting) { toast('Wait for the simulation to be ready, then save again.'); return; }
  loadRevision++;
  const base = matchesPreset() ? presets[presetIndex].name : 'Experiment'; const count = store.getState().saved.length + 1;
  // Capture the field and settings together when Save current is clicked, before naming it.
  const draft = { ...params, ...(engine instanceof VolumeEngine ? { dimension: '3d' as const, shape: volumeShape, objectSize, showFloor, orbit: { ...engine.orbit }, cut: engine.cut } : {}), resolution, background: palette.background, foreground: palette.foreground, threshold, speed, seed, seedMode: start.mode, start: { ...start } };
  const view = { iterations, zoom, pan: { ...pan } };
  const { width, height } = engine;
  syncScene();
  let capturedArt: string | undefined;
  if (is3D) { engine.render(palette, threshold, zoom, pan); try { capturedArt = volumeThumbnail(); } catch { /* Thumbnail is optional. */ } }
  syncScene();
  const source=engine;
  const capture = (source instanceof SceneVolumeEngine ? source.snapshot().then(scene=>({version:1 as const,width,height,field:scene.objects[scene.selected].field,scene,...view})) : source.read().then(field => ({ version: 1 as const, width, height, field, ...view })))
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
      try { art = is3D ? capturedArt : fieldToThumbnail(snapshot.field, snapshot.width, snapshot.height, draft.threshold, { name: 'Saved', background: draft.background, foreground: draft.foreground }); } catch { /* Thumbnail is optional. */ }
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
const science = () => `<h2>How does a pattern grow itself?</h2><p>Two imaginary chemicals spread across the canvas. A feeds the reaction; B consumes A and slowly fades. Tiny differences grow into stripes, spots, and winding branches.</p><div class="equations"><div>∂A/∂t = D<sub>A</sub>∇²A − AB² + f(1 − A)</div><div>∂B/∂t = D<sub>B</sub>∇²B + AB² − (k + f)B</div></div><p>This is the <strong>Gray–Scott reaction–diffusion model</strong>, a relative of the mechanism Alan Turing proposed for biological pattern formation. ${is3D ? 'In 3D, chemicals diffuse between six neighboring cells inside a closed sphere or box. The visible surface follows the concentration of B. The cutaway reveals the interior.' : 'The field wraps at its edges like a torus, which is why you can move across it endlessly.'}</p><div class="field-tip"><strong>Try this</strong><p>Choose Coral, lower the feed rate by a few ten-thousandths, then paint into the canvas. Click any number to type an exact value, or scroll over a slider to nudge it one step at a time. Small changes can make a completely different world.</p></div><p class="source-note">Model and stencil reference: <a href="https://www.karlsims.com/rd.html" target="_blank" rel="noopener noreferrer">Karl Sims' reaction–diffusion tutorial ↗</a></p>`;
const shortcutRows = (): [string, string][] => [
  ['Play / pause', 'Space'], ['Paint chemical B', 'B'], ['Eraser', 'E'], ...(is3D?[['Move object','G'] as [string,string]]:[]), [is3D ? 'Orbit object' : 'Move around', 'V'], [is3D ? 'Move object in depth' : 'Temporarily erase', 'Shift + drag'], ['Temporarily move', 'Alt + drag / middle button'],
  ['Brush size', ', / .'], ['Fine-tune a slider', 'Scroll over it'], ['Fine-tune a typed value', '↑ / ↓ while editing'], ['Exact value', 'Click the number'], ['Plant fresh seeds', 'R'], ['Surprise me', 'S'], ...(!is3D ? [['Open a linked window', 'N'] as [string, string]] : []), ['Save version', '⌘ S'], ['Choose specimen', `1 – ${presets.length}`], ['Cycle palette', 'C'], ['Swap colors', 'X'],
  [is3D ? 'Orbit' : 'Move', is3D ? 'Drag / arrows' : 'Scroll / arrows'], ['Zoom', is3D ? 'Scroll / pinch / − / +' : '⌘ Scroll / − / +'], ['Reset view', '0'], ['Fullscreen', 'F'], ['Hide or show interface', 'H'], ['Recipe panel', '['], ['Specimens panel', ']'], ['Close menu or dialog', 'Esc'],
];
const shortcuts = () => `<h2>Less clicking. More growing.</h2><div class="shortcut-list">${shortcutRows().map(([label, key]) => `<div><span>${label}</span><kbd>${key}</kbd></div>`).join('')}</div>`;
const dialog = $<HTMLDialogElement>('#info-dialog');
function showDialog(content: string) { $('#dialog-content').innerHTML = content; dialog.showModal(); }
$('#about').addEventListener('click', () => showDialog(science())); $('#reaction-help').addEventListener('click', e => { e.preventDefault(); showDialog(science()); }); $('#shortcuts').addEventListener('click', () => showDialog(shortcuts()));
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
  if (target?.closest('.select-trigger, .select-popup')) return;
  if(target?.closest('.scene-handle')&&(e.key.startsWith('Arrow')||e.key==='Enter'||e.key===' '))return;
  if(target?.matches('input[type=range]')&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(e.key))return;
  if (target?.isContentEditable || target?.closest('input:not([type="range"]):not([type="color"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]),textarea,[role="textbox"]') || e.metaKey || e.ctrlKey || e.altKey) return;
  const key = e.key.toLowerCase(); const nudge = 24 * resolution / zoom;
  if (e.code === 'Space') { e.preventDefault(); setRunning(!running); }
  else if(key==='g' && is3D)setTool('object');
  else if (key === 'b') setTool('brush'); else if (key === 'e') setTool('eraser'); else if (key === 'v') setTool('hand');
  else if (key === 'r') $('#reseed').click(); else if (key === 's') $('#surprise').click();
  else if (key === 'h') setHud(!hudVisible); else if (key === 'f') void toggleFullscreen(); else if (key === 'n') openLinkedWindow();
  else if (key === 'c') setPalette(paletteIndex + 1); else if (key === 'x') $('#swap-colors').click();
  else if (e.key === '[') setDock('left', !docks.left); else if (e.key === ']') setDock('right', !docks.right);
  else if (e.key === ',') setBrushSize(brushSize - 2); else if (e.key === '.') setBrushSize(brushSize + 2);
  else if (e.key === '-' || e.key === '_') zoomStep(-1); else if (e.key === '+' || e.key === '=') zoomStep(1); else if (e.key === '0') resetView();
  else if (is3D && e.key.startsWith('Arrow')) orbitVolume(e.key === 'ArrowLeft' ? -.12 : e.key === 'ArrowRight' ? .12 : 0, e.key === 'ArrowUp' ? -.12 : e.key === 'ArrowDown' ? .12 : 0);
  else if (e.key === 'ArrowLeft') setPan(pan.x - nudge, pan.y); else if (e.key === 'ArrowRight') setPan(pan.x + nudge, pan.y);
  else if (e.key === 'ArrowUp') setPan(pan.x, pan.y - nudge); else if (e.key === 'ArrowDown') setPan(pan.x, pan.y + nudge);
  else if (e.key === '?') showDialog(shortcuts());
  else if (/^[1-9]$/.test(e.key) && Number(e.key) <= presets.length) setPreset(Number(e.key) - 1);
  else return;
  // Capture before saved-card handlers and suppress native button activation,
  // slider nudges, select typeahead, and page scrolling for handled shortcuts.
  e.preventDefault(); e.stopPropagation();
}, { capture: true });
window.addEventListener('blur', () => { drawing = false; panning = false; pointers.clear(); pinch = null; brush = { ...idleBrush }; });

// ---------- Boot ----------
updateDimensionUI(); updateResolutionUI(); renderSaved(); applyPalette(); updateSliders(); updateSpecimenLabel(); updateThresholdLabel(); updateSpeedLabel(); updateStart(); setTool(is3D ? 'object' : 'brush'); setZoom(zoom);
setMix(mixMode, 0, false); updateStrengthLabel(); updateLinkUI(); $<HTMLButtonElement>('#open-window').disabled = !linkable;
if (embed && !interactive) $('#simulation').style.pointerEvents = 'none';
installSelects(); void initialize(); requestAnimationFrame(frame);
