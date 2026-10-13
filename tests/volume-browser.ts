/** Run on a secure preview in DevTools:
 * await (await import('/tests/volume-browser.ts')).checkVolumeBackends()
 * These checks need a real GPU; the node unit suite cannot compile WGSL.
 */
import { configureCapture, gpuPixels } from './gpu-pixels';
import { WebGPUVolumeEngine } from '../src/engine3d-webgpu';
import { WebGLVolumeEngine } from '../src/engine3d';
import { defaultStart, idleBrush, type Parameters } from '../src/model';
import { makeVolumeSeed, type VolumeShape } from '../src/volume';

function assert(condition: boolean, message: string) { if (!condition) throw new Error(message); }
const recipe: Parameters = { feed: .0367, kill: .0649, diffusionA: 1, diffusionB: .5 };
const palette = { name: 'Test', background: '#20221d', foreground: '#e3e5cc' };
function canvas() {
  const c = document.createElement('canvas'); c.width = 160; c.height = 100;
  c.style.cssText = 'position:fixed;left:-200px;top:0;width:160px;height:100px;';
  document.body.append(c); return c;
}
function pixels(c: HTMLCanvasElement) {
  const copy = document.createElement('canvas'); copy.width = c.width; copy.height = c.height;
  const context = copy.getContext('2d')!; context.drawImage(c, 0, 0);
  return context.getImageData(0, 0, c.width, c.height).data;
}
function maxDifference(a: Float32Array, b: Float32Array) {
  assert(a.length === b.length, 'Readback dimensions differ.');
  let maximum = 0;
  for (let i = 0; i < a.length; i++) {
    assert(Number.isFinite(a[i]) && Number.isFinite(b[i]), `Non-finite chemical at ${i}.`);
    maximum = Math.max(maximum, Math.abs(a[i] - b[i]));
  }
  return maximum;
}
export async function checkVolumeBackends() {
  const results: { shape: string; maximum: number; paintedMaximum: number; renderMean: number }[] = [];
  for (const shape of ['sphere', 'box'] as VolumeShape[]) {
    const a = canvas(), b = canvas();
    let gpu: WebGPUVolumeEngine | undefined, gl: WebGLVolumeEngine | undefined;
    try {
      gpu = await WebGPUVolumeEngine.create(a, 64); configureCapture(gpu); gl = new WebGLVolumeEngine(b, 64);
      gpu.shape = gl.shape = shape;
      const seed = makeVolumeSeed(512, 42, { ...defaultStart(), mode: 'scatter', count: 120, radius: 5, amount: .5 }, shape);
      gpu.seed(seed); gl.seed(seed); gpu.step(recipe, 24); gl.step(recipe, 24);
      const maximum = maxDifference(await gpu.read(), await gl.read());
      assert(maximum < .00001, `${shape}: simulation backends differ by ${maximum}.`);
      for (const engine of [gpu, gl]) { engine.cut = .4; engine.objectSize = 2; engine.showFloor = false; }
      const beforePaint = await gpu.read();
      const rect = a.getBoundingClientRect();
      assert(gpu.pick(rect.left+80, rect.top+50, 1) && gl.pick(rect.left+80, rect.top+50, 1), 'Cutaway brush missed the object.');
      const brush = { ...idleBrush, mode: 1 as const, amount: .8, radius: 14 };
      gpu.step(recipe, 1, brush); gl.step(recipe, 1, brush);
      const painted = await gpu.read();
      assert(maxDifference(beforePaint, painted) > .1, 'Brush did not change the field.');
      const paintedMaximum = maxDifference(painted, await gl.read());
      assert(paintedMaximum < .00001, `${shape}: brushes differ between backends.`);
      gpu.render(palette, .19, 1, { x: 0, y: 0 }); gl.render(palette, .19, 1, { x: 0, y: 0 });
      const renderedPixels = await gpuPixels(gpu,a), glPixels = pixels(b); let error = 0;
      for (let i = 0; i < renderedPixels.length; i++) error += Math.abs(renderedPixels[i] - glPixels[i]);
      const renderMean = error / renderedPixels.length;
      assert(renderMean < 2, `${shape}: render orientation or lighting differs (${renderMean}).`);
      gpu.showFloor = true; gpu.render(palette, .19, 1, { x: 0, y: 0 });
      const floorPixels = await gpuPixels(gpu,a);
      assert(floorPixels.some((value, i) => value !== renderedPixels[i]), 'Show floor did not change the rendered view.');
      results.push({ shape, maximum, paintedMaximum, renderMean });
    } finally { gpu?.destroy(); gl?.destroy(); a.remove(); b.remove(); }
  }
  return results;
}
export async function checkVolumeResolution(size: number) {
  const c = canvas(); let gpu: WebGPUVolumeEngine | undefined;
  try {
    gpu = await WebGPUVolumeEngine.create(c, size); configureCapture(gpu); gpu.shape = 'box';
    const seed = makeVolumeSeed(size*8, 42, { ...defaultStart(), mode: 'spot', radius: 8, amount: .5 }, 'box');
    gpu.seed(seed); gpu.step(recipe, 1);
    const field = await gpu.read();
    assert(field.length === size**3*2, `${size}³ readback dimensions are wrong.`);
    assert(field.every(value => Number.isFinite(value) && value >= 0 && value <= 1), `${size}³ chemical values are invalid.`);
    assert(field.some((value, index) => index % 2 === 1 && value > .1), `${size}³ lost the seed.`);
    gpu.render(palette, .19, 1, { x: 0, y: 0 });
    assert((await gpuPixels(gpu,c)).some((value, index) => index % 4 !== 3 && value > 40), `${size}³ did not render the object.`);
    return { size, cells: field.length / 2, bytes: field.byteLength };
  } finally { gpu?.destroy(); c.remove(); }
}

/** Run in an isolated preview tab. Verifies field readback and DOM identity across switches. */
export async function checkDimensionSwitches() {
  const { WebGPUEngine, WebGLEngine } = await import('../src/engine');
  const root = document.querySelector<HTMLElement>('#app-root')!;
  const feed = document.querySelector<HTMLInputElement>('#feed')!;
  const origin = performance.timeOrigin, originalFeed = feed.value;
  const button = document.querySelector<HTMLButtonElement>('#dimension-toggle')!;
  const prototypes = [WebGPUVolumeEngine.prototype, WebGLVolumeEngine.prototype, WebGPUEngine.prototype, WebGLEngine.prototype];
  const reads: Float32Array[] = [];
  const originals = prototypes.map(prototype => prototype.read);
  prototypes.forEach((prototype, i) => {
    prototype.read = async function () { const field = await originals[i].call(this as never); reads.push(field); return field; };
  });
  const wait = async (condition: () => boolean) => {
    const start = performance.now();
    while (!condition()) { assert(performance.now() - start < 15000, 'Switch did not finish.'); await new Promise(resolve => setTimeout(resolve, 25)); }
  };
  const input = (id: string, value: string) => {
    const e = document.querySelector<HTMLInputElement>(id)!; e.value = value; e.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const toggle = async () => {
    button.click(); await wait(() => !button.disabled && document.querySelector('#loading')!.hasAttribute('hidden'));
    assert(document.querySelector('#app-root') === root && document.querySelector('#feed') === feed && performance.timeOrigin === origin, 'Switch reloaded the page or rebuilt the controls.');
    assert(feed.value === originalFeed, 'Recipe changed during switch.');
  };
  try {
    assert(root.dataset.dimension === '3d', 'Start this check in 3D mode.');
    const play = document.querySelector<HTMLButtonElement>('#play')!;
    if (play.getAttribute('aria-label') === 'Pause simulation') play.click();
    input('#scene-cut', '.3'); input('#object-size', '2');
    document.querySelector<HTMLInputElement>('#show-floor')!.checked = false;
    document.querySelector('#show-floor')!.dispatchEvent(new Event('change'));
    document.querySelector<HTMLButtonElement>('#step')!.click();
    document.querySelector<HTMLButtonElement>('#zoom-in')!.click();
    const zoom3D = document.querySelector('#zoom-reset')!.textContent;
    await toggle();
    assert(root.dataset.dimension === '2d' && !new URLSearchParams(location.search).has('mode'), '2D UI or URL did not update.');
    assert(document.querySelector<HTMLInputElement>('#object-size')!.closest<HTMLElement>('.section')!.hidden, 'Object controls remained visible in 2D.');
    assert(document.querySelector('#resolution-control')!.getAttribute('aria-label') === 'Base resolution', 'Resolution menu label is stale.');
    document.querySelector<HTMLButtonElement>('#step')!.click();
    document.querySelector<HTMLButtonElement>('#zoom-in')!.click(); document.querySelector<HTMLButtonElement>('#zoom-in')!.click();
    const zoom2D = document.querySelector('#zoom-reset')!.textContent;
    await toggle();
    assert(root.dataset.dimension === '3d' && new URLSearchParams(location.search).get('mode') === '3d', '3D UI or URL did not update.');
    assert(document.querySelector<HTMLInputElement>('#scene-cut')!.value === '.3' || document.querySelector<HTMLInputElement>('#scene-cut')!.value === '0.3', 'Cutaway was not restored.');
    assert(document.querySelector('#zoom-reset')!.textContent === zoom3D, '3D zoom was not restored.');
    assert(document.querySelector<HTMLInputElement>('#object-size')!.value === '2' && !document.querySelector<HTMLInputElement>('#show-floor')!.checked, 'Object size or floor visibility was lost.');
    await toggle();
    assert(maxDifference(reads[0], reads[2]) === 0, 'The 3D field changed while inactive.');
    assert(document.querySelector('#zoom-reset')!.textContent === zoom2D, '2D zoom was not restored.');
    await toggle();
    assert(maxDifference(reads[1], reads[3]) === 0, 'The 2D field changed while inactive.');
    return { samePage: true, sameControls: true, preservedFields: true, preservedViews: true, switches: 4 };
  } finally { prototypes.forEach((prototype, i) => { prototype.read = originals[i]; }); }
}

export async function checkVolumeBackendSwitches() {
  const root = document.querySelector<HTMLElement>('#app-root')!;
  assert(root.dataset.dimension === '3d', 'Start this check in 3D mode.');
  const select = document.querySelector<HTMLSelectElement>('#backend')!;
  const prototypes = [WebGPUVolumeEngine.prototype, WebGLVolumeEngine.prototype];
  const originals = prototypes.map(prototype => prototype.read);
  const reads: Float32Array[] = [];
  prototypes.forEach((prototype, i) => {
    prototype.read = async function () { const field = await originals[i].call(this as never); reads.push(field); return field; };
  });
  const originalCreate = WebGPUVolumeEngine.create;
  const choose = async (value: string, expected: string) => {
    select.value = value; select.dispatchEvent(new Event('change', { bubbles: true }));
    const start = performance.now();
    while (select.disabled || document.querySelector('#engine-status')!.textContent !== expected) {
      assert(performance.now() - start < 15000, `Could not switch to ${expected}.`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  try {
    const play = document.querySelector<HTMLButtonElement>('#play')!;
    if (play.getAttribute('aria-label') === 'Pause simulation') play.click();
    await choose('webgl', 'WebGL 2'); await choose('webgpu', 'WebGPU');
    assert(maxDifference(reads[0], reads[1]) === 0, 'Field changed while switching backends.');
    WebGPUVolumeEngine.create = async () => { throw new Error('Unavailable adapter for fallback verification.'); };
    await choose('auto', 'WebGL 2');
    assert(maxDifference(reads[1], reads[2]) === 0, 'Fallback changed the chemical field.');
    assert(select.value === 'auto', 'Auto fallback did not retain the engine preference.');
    WebGPUVolumeEngine.create = originalCreate;
    await choose('auto', 'WebGPU');
    assert(maxDifference(reads[2], reads[3]) === 0, 'Returning from fallback changed the chemical field.');
    return { explicitWebGL: true, explicitWebGPU: true, automaticFallback: true, preservedField: true };
  } finally {
    WebGPUVolumeEngine.create = originalCreate;
    prototypes.forEach((prototype, i) => { prototype.read = originals[i]; });
  }
}
