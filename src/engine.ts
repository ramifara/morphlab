import { idleBrush, rgb, type Brush, type Palette, type Parameters, type View } from './model';
import { LAYER_HEIGHT, LAYER_WIDTH, MAX_PEERS, mixModes, type MixMode, type PeerSlot } from './link';

export interface ViewState { zoom: number; pan: View }
/** What other windows contribute where they overlap this one. See link.ts for the layer format. */
export interface Coupling { layer: Uint8Array | null; slots: PeerSlot[]; mode: MixMode; strength: number }
export const noCoupling: Coupling = { layer: null, slots: [], mode: 'off', strength: 0 };

export interface Engine {
  readonly backend: 'WebGPU' | 'WebGL 2';
  readonly width: number;
  readonly height: number;
  seed(data: Float32Array): void;
  /** Advance the field. Passing the view lets overlapping windows couple into this one. */
  step(params: Parameters, iterations: number, brush?: Brush, view?: ViewState): void;
  render(palette: Palette, threshold: number, zoom: number, pan: View): void;
  read(): Promise<Float32Array>;
  /** Upload the foreign layer and the peers it refers to. */
  setCoupling(coupling: Coupling): void;
  /** The visible viewport as RGBA8, A in red and B in green, row 0 at the top. Null while an earlier capture is still being read. */
  capture(view: ViewState): Promise<Uint8Array | null>;
  destroy(): void;
}

/** Mix uniform: zoom, strength, mode, pad, viewScale, pan, 4 peers (feed, kill, above, 0), 8 colors (bg, fg per peer). */
const MIX_BYTES = 224;
function viewScale(canvas: HTMLCanvasElement, width: number, height: number) {
  const aspect = canvas.width / canvas.height / (width / height);
  return { x: Math.min(1, aspect), y: Math.min(1, 1 / aspect) };
}
function packMix(view: ViewState | undefined, scale: { x: number; y: number }, coupling: Coupling) {
  const buffer = new ArrayBuffer(MIX_BYTES), f32 = new Float32Array(buffer), u32 = new Uint32Array(buffer);
  const mode = view && coupling.layer ? mixModes.indexOf(coupling.mode) : mixModes.indexOf('off');
  f32.set([view?.zoom ?? 1, coupling.strength, 0, 0, scale.x, scale.y, view?.pan.x ?? 0, view?.pan.y ?? 0]); u32[2] = mode;
  coupling.slots.slice(0, MAX_PEERS).forEach((slot, i) => {
    f32.set([slot.feed, slot.kill, slot.above ? 1 : 0, 0], 8 + i * 4);
    f32.set([...rgb(slot.background), 1, ...rgb(slot.foreground), 1], 24 + i * 8);
  });
  return { f32, u32, mode };
}

const mixWGSL = `
struct Mix { zoom: f32, strength: f32, mode: u32, pad: u32, viewScale: vec2f, pan: vec2f, peers: array<vec4f, 4>, colors: array<vec4f, 8> }
fn peerSlot(f: vec4f) -> u32 { return min(3u, u32(max(round(f.b * 255.) - 1., 0.))); }`;
const computeWGSL = `
struct Params { size: vec2f, feed: f32, kill: f32, da: f32, db: f32, dt: f32, amount: f32, brush: vec4f }
${mixWGSL}
@group(0) @binding(0) var<storage, read> input: array<vec2f>;
@group(0) @binding(1) var<storage, read_write> output: array<vec2f>;
@group(0) @binding(2) var<uniform> p: Params;
@group(0) @binding(3) var foreign: texture_2d<f32>;
@group(0) @binding(4) var foreignSampler: sampler;
@group(0) @binding(5) var<uniform> m: Mix;
fn sampleAt(q: vec2i) -> vec2f {
  let s = vec2i(p.size); let t = (q + s) % s;
  return input[u32(t.y * s.x + t.x)];
}
// What another window shows at this cell: the display projection inverted, using the on-screen instance nearest the view centre.
fn layerAt(id: vec2u) -> vec4f {
  if (m.mode == 4u) { return vec4f(0.); }
  let n = fract((vec2f(id) + .5 - m.pan) / p.size) - .5;
  let uv = n * m.zoom / m.viewScale + .5;
  if (any(uv < vec2f(0.)) || any(uv > vec2f(1.))) { return vec4f(0.); }
  return textureSampleLevel(foreign, foreignSampler, uv, 0.);
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= u32(p.size.x) || id.y >= u32(p.size.y)) { return; }
  let q = vec2i(id.xy); let c = sampleAt(q);
  var lap = -c;
  lap += .2 * (sampleAt(q+vec2i(1,0)) + sampleAt(q+vec2i(-1,0)) + sampleAt(q+vec2i(0,1)) + sampleAt(q+vec2i(0,-1)));
  lap += .05 * (sampleAt(q+vec2i(1,1)) + sampleAt(q+vec2i(-1,1)) + sampleAt(q+vec2i(1,-1)) + sampleAt(q+vec2i(-1,-1)));
  let f = layerAt(id.xy); let w = f.a * m.strength; let peer = m.peers[peerSlot(f)];
  var feed = p.feed; var kill = p.kill;
  if (m.mode == 1u) { feed = mix(feed, peer.x, .5 * w); kill = mix(kill, peer.y, .5 * w); }
  let reaction = c.x * c.y * c.y;
  var next = clamp(c + vec2f(p.da*lap.x - reaction + feed*(1.-c.x), p.db*lap.y + reaction - (kill+feed)*c.y) * p.dt, vec2f(0), vec2f(1));
  if (w > 0.) {
    if (m.mode == 0u) { next = mix(next, f.xy, w * .02); }
    else if (m.mode == 2u) { if (peer.z < .5) { next.y = min(1., next.y + w * .03 * f.y); } else { next.y *= 1. - w * .03; } }
    else if (m.mode == 3u) { next.y *= 1. - w * .08 * f.y; }
  }
  let d = abs(vec2f(id.xy) - p.brush.xy); let dw = min(d, p.size - d);
  if (p.brush.w != 0. && length(dw) < p.brush.z) {
    next = select(vec2f(1,0), vec2f(.5,p.amount), p.brush.w > 0.);
  }
  output[id.y * u32(p.size.x) + id.x] = next;
}`;
const renderWGSL = `
struct Display { size: vec2f, threshold: f32, zoom: f32, bg: vec4f, fg: vec4f, pan: vec2f, pad: vec2f }
${mixWGSL}
@group(0) @binding(0) var<storage, read> cells: array<vec2f>;
@group(0) @binding(1) var<uniform> p: Display;
@group(0) @binding(2) var foreign: texture_2d<f32>;
@group(0) @binding(3) var foreignSampler: sampler;
@group(0) @binding(4) var<uniform> m: Mix;
struct Vertex { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> Vertex {
  let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var v: Vertex; v.position = vec4f(xy * 2. - 1., 0., 1.); v.uv = vec2f(xy.x, 1.-xy.y); return v;
}
fn at(q: vec2i) -> vec2f {
  let s = vec2i(p.size); let t = (q+s)%s; return cells[u32(t.y*s.x+t.x)];
}
fn field(uv: vec2f) -> vec2f {
  let q = uv * p.size + p.pan - .5; let i = vec2i(floor(q)); let f = fract(q);
  return mix(mix(at(i),at(i+vec2i(1,0)),f.x),mix(at(i+vec2i(0,1)),at(i+vec2i(1,1)),f.x),f.y);
}
fn project(uv: vec2f) -> vec2f { return (uv-.5)*vec2f(p.bg.w,p.fg.w)/p.zoom+.5; }
@fragment fn fs(v: Vertex) -> @location(0) vec4f {
  let b = field(project(v.uv)).y;
  let t = smoothstep(p.threshold-.045,p.threshold+.045,b);
  var color = mix(p.bg.rgb, p.fg.rgb, t);
  // Where another window overlaps: tint the region a little and ghost its pattern in whichever of its colors shows on our background.
  let f = textureSampleLevel(foreign, foreignSampler, v.uv, 0.);
  if (f.a > 0. && m.mode != 4u) {
    let slot = peerSlot(f) * 2u; let peerBg = m.colors[slot].rgb; let peerFg = m.colors[slot + 1u].rgb;
    color = mix(mix(p.bg.rgb, peerBg, f.a * .18), mix(p.fg.rgb, peerFg, f.a * .18), t);
    let ghostColor = select(peerBg, peerFg, distance(peerFg, p.bg.rgb) > distance(peerBg, p.bg.rgb));
    color = mix(color, ghostColor, smoothstep(p.threshold-.045, p.threshold+.045, f.g) * f.a * .6);
  }
  return vec4f(color,1.);
}
@fragment fn fsCapture(v: Vertex) -> @location(0) vec4f { return vec4f(field(project(v.uv)), 0., 1.); }`;

export class WebGPUEngine implements Engine {
  readonly backend = 'WebGPU' as const;
  private buffers: GPUBuffer[];
  private params: GPUBuffer;
  private display: GPUBuffer;
  private mix: GPUBuffer;
  private foreign: GPUTexture;
  private captureTexture: GPUTexture;
  private staging: GPUBuffer;
  private compute: GPUComputePipeline;
  private renderer: GPURenderPipeline;
  private capturer: GPURenderPipeline;
  private groups: GPUBindGroup[];
  private renderGroups: GPUBindGroup[];
  private captureGroups: GPUBindGroup[];
  private index = 0;
  private context: GPUCanvasContext;
  private alive = true;
  private coupling: Coupling = noCoupling;
  private capturing = false;
  static async create(canvas: HTMLCanvasElement, width: number, height: number, onLost: () => void) {
    if (!navigator.gpu) throw new Error('WebGPU is not available in this browser.');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter is available.');
    const device = await adapter.requestDevice();
    device.pushErrorScope('validation');
    let engine: WebGPUEngine;
    try { engine = new WebGPUEngine(canvas, width, height, device); }
    catch (error) { device.destroy(); throw error; }
    const error = await device.popErrorScope();
    if (error) { engine.destroy(); throw new Error(error.message); }
    device.lost.then(() => { if (engine.alive) onLost(); });
    return engine;
  }
  private constructor(private canvas: HTMLCanvasElement, readonly width: number, readonly height: number, private device: GPUDevice) {
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('Cannot create a WebGPU canvas.');
    this.context = context;
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque' });
    this.buffers = [0,1].map(() => device.createBuffer({ size: width*height*8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC }));
    this.params = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.display = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.mix = device.createBuffer({ size: MIX_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.foreign = device.createTexture({ size: [LAYER_WIDTH, LAYER_HEIGHT], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.captureTexture = device.createTexture({ size: [LAYER_WIDTH, LAYER_HEIGHT], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    this.staging = device.createBuffer({ size: LAYER_WIDTH*4*LAYER_HEIGHT, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.compute = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: computeWGSL }), entryPoint: 'main' } });
    const renderModule = device.createShaderModule({ code: renderWGSL });
    this.renderer = device.createRenderPipeline({ layout: 'auto', vertex: { module: renderModule, entryPoint: 'vs' }, fragment: { module: renderModule, entryPoint: 'fs', targets: [{ format }] }, primitive: { topology: 'triangle-list' } });
    this.capturer = device.createRenderPipeline({ layout: 'auto', vertex: { module: renderModule, entryPoint: 'vs' }, fragment: { module: renderModule, entryPoint: 'fsCapture', targets: [{ format: 'rgba8unorm' }] }, primitive: { topology: 'triangle-list' } });
    const foreignView = this.foreign.createView();
    this.groups = [0,1].map(i => device.createBindGroup({ layout: this.compute.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.buffers[i] } }, { binding: 1, resource: { buffer: this.buffers[1-i] } }, { binding: 2, resource: { buffer: this.params } },
      { binding: 3, resource: foreignView }, { binding: 4, resource: sampler }, { binding: 5, resource: { buffer: this.mix } }] }));
    this.renderGroups = [0,1].map(i => device.createBindGroup({ layout: this.renderer.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.buffers[i] } }, { binding: 1, resource: { buffer: this.display } },
      { binding: 2, resource: foreignView }, { binding: 3, resource: sampler }, { binding: 4, resource: { buffer: this.mix } }] }));
    this.captureGroups = [0,1].map(i => device.createBindGroup({ layout: this.capturer.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.buffers[i] } }, { binding: 1, resource: { buffer: this.display } }] }));
    this.setCoupling(noCoupling);
  }
  seed(data: Float32Array) { for (const buffer of this.buffers) this.device.queue.writeBuffer(buffer, 0, data as Float32Array<ArrayBuffer>); this.index = 0; }
  setCoupling(coupling: Coupling) {
    this.coupling = coupling;
    const layer = coupling.layer ?? new Uint8Array(LAYER_WIDTH*LAYER_HEIGHT*4);
    this.device.queue.writeTexture({ texture: this.foreign }, layer as Uint8Array<ArrayBuffer>, { bytesPerRow: LAYER_WIDTH*4, rowsPerImage: LAYER_HEIGHT }, [LAYER_WIDTH, LAYER_HEIGHT]);
  }
  step(p: Parameters, iterations: number, brush = idleBrush, view?: ViewState) {
    this.device.queue.writeBuffer(this.params,0,new Float32Array([this.width,this.height,p.feed,p.kill,p.diffusionA,p.diffusionB,1,brush.amount,brush.x,brush.y,brush.radius,brush.mode]));
    this.device.queue.writeBuffer(this.mix,0,packMix(view, viewScale(this.canvas, this.width, this.height), this.coupling).f32);
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass(); pass.setPipeline(this.compute);
    for (let i = 0; i < iterations; i++) { pass.setBindGroup(0,this.groups[this.index]); pass.dispatchWorkgroups(Math.ceil(this.width/8),Math.ceil(this.height/8)); this.index = 1-this.index; }
    pass.end(); this.device.queue.submit([encoder.finish()]);
  }
  private writeDisplay(palette: Palette, threshold: number, zoom: number, pan: View) {
    const scale = viewScale(this.canvas, this.width, this.height);
    this.device.queue.writeBuffer(this.display,0,new Float32Array([this.width,this.height,threshold,zoom,...rgb(palette.background),scale.x,...rgb(palette.foreground),scale.y,pan.x,pan.y,0,0]));
  }
  render(palette: Palette, threshold: number, zoom: number, pan: View) {
    this.writeDisplay(palette, threshold, zoom, pan);
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: this.context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0,0,0,1] }] });
    pass.setPipeline(this.renderer); pass.setBindGroup(0,this.renderGroups[this.index]); pass.draw(3); pass.end(); this.device.queue.submit([encoder.finish()]);
  }
  async capture(view: ViewState) {
    if (this.capturing) return null;
    this.capturing = true;
    try {
      this.writeDisplay({ name: '', background: '#000000', foreground: '#ffffff' }, 0, view.zoom, view.pan);
      const encoder = this.device.createCommandEncoder();
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: this.captureTexture.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0,0,0,1] }] });
      pass.setPipeline(this.capturer); pass.setBindGroup(0,this.captureGroups[this.index]); pass.draw(3); pass.end();
      encoder.copyTextureToBuffer({ texture: this.captureTexture }, { buffer: this.staging, bytesPerRow: LAYER_WIDTH*4 }, [LAYER_WIDTH, LAYER_HEIGHT]);
      this.device.queue.submit([encoder.finish()]);
      await this.staging.mapAsync(GPUMapMode.READ);
      const data = new Uint8Array(this.staging.getMappedRange().slice(0)); this.staging.unmap();
      return data;
    } finally { this.capturing = false; }
  }
  async read() {
    const staging = this.device.createBuffer({ size: this.width*this.height*8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const encoder = this.device.createCommandEncoder(); encoder.copyBufferToBuffer(this.buffers[this.index],0,staging,0,staging.size); this.device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ); const data = new Float32Array(staging.getMappedRange().slice(0)); staging.unmap(); return data;
    } finally { staging.destroy(); }
  }
  destroy() { this.alive = false; this.context.unconfigure(); this.buffers.forEach(b=>b.destroy()); this.params.destroy(); this.display.destroy(); this.mix.destroy(); this.staging.destroy(); this.foreign.destroy(); this.captureTexture.destroy(); this.device.destroy(); }
}

const vertexGL = `#version 300 es
precision highp float;
out vec2 uv;
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); uv = p; gl_Position = vec4(p*2.-1.,0.,1.); }`;
const mixGL = `
uniform sampler2D foreign;
uniform vec4 mixMap; // zoom, strength, mode, unused
int peerSlot(vec4 f) { return int(clamp(floor(f.b * 255. + .5) - 1., 0., 3.)); }`;
const computeGL = `#version 300 es
precision highp float;
uniform sampler2D cells;
uniform vec2 size;
uniform vec4 params;
uniform vec4 brush;
uniform float amount;
uniform vec2 viewScale;
uniform vec2 pan;
uniform vec4 peers[4];
${mixGL}
out vec4 result;
vec2 at(ivec2 q) { ivec2 s = ivec2(size); return texelFetch(cells,(q+s)%s,0).rg; }
vec4 layerAt(ivec2 q) {
  if (mixMap.z > 3.5) return vec4(0.);
  vec2 n = fract((vec2(q) + .5 - pan) / size) - .5;
  vec2 uv = n * mixMap.x / viewScale + .5;
  if (any(lessThan(uv, vec2(0.))) || any(greaterThan(uv, vec2(1.)))) return vec4(0.);
  return texture(foreign, uv);
}
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy); vec2 c = at(q);
  vec2 lap = -c + .2*(at(q+ivec2(1,0))+at(q+ivec2(-1,0))+at(q+ivec2(0,1))+at(q+ivec2(0,-1)))
    + .05*(at(q+ivec2(1,1))+at(q+ivec2(-1,1))+at(q+ivec2(1,-1))+at(q+ivec2(-1,-1)));
  vec4 f = layerAt(q); float w = f.a * mixMap.y; vec4 peer = peers[peerSlot(f)]; int mode = int(mixMap.z + .5);
  float feed = params.x, kill = params.y;
  if (mode == 1) { feed = mix(feed, peer.x, .5 * w); kill = mix(kill, peer.y, .5 * w); }
  float reaction = c.x*c.y*c.y;
  vec2 n = clamp(c + vec2(params.z*lap.x-reaction+feed*(1.-c.x),params.w*lap.y+reaction-(feed+kill)*c.y),0.,1.);
  if (w > 0.) {
    if (mode == 0) n = mix(n, f.xy, w * .02);
    else if (mode == 2) { if (peer.z < .5) n.y = min(1., n.y + w * .03 * f.y); else n.y *= 1. - w * .03; }
    else if (mode == 3) n.y *= 1. - w * .08 * f.y;
  }
  vec2 d = abs(vec2(q)-brush.xy); vec2 dw = min(d,size-d);
  if (brush.w != 0. && length(dw)<brush.z) n = brush.w>0. ? vec2(.5,amount) : vec2(1,0);
  result = vec4(n,0,1);
}`;
const viewGL = `
uniform sampler2D cells;
uniform vec2 size;
uniform float zoom;
uniform vec2 viewScale;
uniform vec2 pan;
in vec2 uv;
out vec4 result;
vec2 at(ivec2 q) { ivec2 s = ivec2(size); return texelFetch(cells,(q+s)%s,0).rg; }
vec2 field(vec2 screen) {
  vec2 q = ((screen-.5)*viewScale/zoom+.5)*size+pan-.5; ivec2 i = ivec2(floor(q)); vec2 f = fract(q);
  return mix(mix(at(i),at(i+ivec2(1,0)),f.x),mix(at(i+ivec2(0,1)),at(i+ivec2(1,1)),f.x),f.y);
}`;
const renderGL = `#version 300 es
precision highp float;
uniform vec3 bg;
uniform vec3 fg;
uniform float threshold;
uniform vec3 peerColors[8];
${mixGL}
${viewGL}
void main() {
  vec2 screen = vec2(uv.x, 1.-uv.y);
  float t = smoothstep(threshold-.045,threshold+.045,field(screen).y);
  vec3 color = mix(bg, fg, t);
  vec4 f = texture(foreign, screen);
  if (f.a > 0. && mixMap.z < 3.5) {
    int slot = peerSlot(f) * 2; vec3 peerBg = peerColors[slot], peerFg = peerColors[slot + 1];
    color = mix(mix(bg, peerBg, f.a * .18), mix(fg, peerFg, f.a * .18), t);
    vec3 ghostColor = distance(peerFg, bg) > distance(peerBg, bg) ? peerFg : peerBg;
    color = mix(color, ghostColor, smoothstep(threshold-.045, threshold+.045, f.g) * f.a * .6);
  }
  result = vec4(color,1.);
}`;
// Framebuffer row 0 is the bottom, so the unflipped uv puts the screen's top row first in readPixels.
const captureGL = `#version 300 es
precision highp float;
${viewGL}
void main() { result = vec4(field(uv), 0., 1.); }`;

export class WebGLEngine implements Engine {
  readonly backend = 'WebGL 2' as const;
  private gl: WebGL2RenderingContext;
  private programs: WebGLProgram[];
  private textures: WebGLTexture[];
  private frames: WebGLFramebuffer[];
  private foreign: WebGLTexture;
  private captureFrame: WebGLFramebuffer;
  private captureTexture: WebGLTexture;
  private index = 0;
  private locations = new Map<string, WebGLUniformLocation | null>();
  private coupling: Coupling = noCoupling;
  constructor(private canvas: HTMLCanvasElement, readonly width: number, readonly height: number) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: true });
    if (!gl || !gl.getExtension('EXT_color_buffer_float')) throw new Error('This device needs WebGPU or WebGL 2 with floating-point textures.');
    this.gl = gl;
    this.programs = [computeGL, renderGL, captureGL].map(fragment => {
      const program = gl.createProgram()!;
      for (const [type,source] of [[gl.VERTEX_SHADER,vertexGL],[gl.FRAGMENT_SHADER,fragment]] as const) {
        const shader = gl.createShader(type)!; gl.shaderSource(shader,source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'Shader compilation failed.');
        gl.attachShader(program,shader); gl.deleteShader(shader);
      }
      gl.linkProgram(program); if (!gl.getProgramParameter(program,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'Shader linking failed.');
      return program;
    });
    this.textures = [0,1].map(() => {
      const texture = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.REPEAT);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RG32F,width,height,0,gl.RG,gl.FLOAT,null); return texture;
    });
    this.frames = this.textures.map(texture => {
      const frame = gl.createFramebuffer()!; gl.bindFramebuffer(gl.FRAMEBUFFER,frame); gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE) throw new Error('Floating-point framebuffer is incomplete.');
      return frame;
    });
    const rgba8 = (filter: number) => {
      const texture = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,filter); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,filter);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,LAYER_WIDTH,LAYER_HEIGHT,0,gl.RGBA,gl.UNSIGNED_BYTE,null); return texture;
    };
    this.captureTexture = rgba8(gl.NEAREST);
    this.captureFrame = gl.createFramebuffer()!; gl.bindFramebuffer(gl.FRAMEBUFFER,this.captureFrame); gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,this.captureTexture,0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE) throw new Error('Capture framebuffer is incomplete.');
    // The foreign layer stays bound to texture unit 1; the field textures use unit 0.
    gl.activeTexture(gl.TEXTURE1); this.foreign = rgba8(gl.LINEAR); gl.activeTexture(gl.TEXTURE0);
    this.setCoupling(noCoupling);
  }
  private loc(program: number, name: string) {
    const key = `${program}:${name}`;
    if (!this.locations.has(key)) this.locations.set(key,this.gl.getUniformLocation(this.programs[program],name));
    return this.locations.get(key)!;
  }
  seed(data: Float32Array) {
    const gl = this.gl; this.index = 0;
    for (const texture of this.textures) { gl.bindTexture(gl.TEXTURE_2D,texture); gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,this.width,this.height,gl.RG,gl.FLOAT,data); }
  }
  setCoupling(coupling: Coupling) {
    const gl = this.gl; this.coupling = coupling;
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D,this.foreign);
    gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,LAYER_WIDTH,LAYER_HEIGHT,gl.RGBA,gl.UNSIGNED_BYTE,coupling.layer ?? new Uint8Array(LAYER_WIDTH*LAYER_HEIGHT*4));
    gl.activeTexture(gl.TEXTURE0);
  }
  private writeMix(program: number, view: ViewState | undefined) {
    const gl = this.gl; const scale = viewScale(this.canvas, this.width, this.height);
    const { f32, mode } = packMix(view, scale, this.coupling);
    gl.uniform1i(this.loc(program,'foreign'),1);
    gl.uniform4f(this.loc(program,'mixMap'),view?.zoom ?? 1,this.coupling.strength,mode,0);
    if (program === 0) { gl.uniform2f(this.loc(0,'viewScale'),scale.x,scale.y); gl.uniform2f(this.loc(0,'pan'),view?.pan.x ?? 0,view?.pan.y ?? 0); gl.uniform4fv(this.loc(0,'peers'),f32.subarray(8,24)); }
    else { const colors = new Float32Array(24); for (let i = 0; i < 8; i++) colors.set(f32.subarray(24+i*4,27+i*4),i*3); gl.uniform3fv(this.loc(1,'peerColors'),colors); }
  }
  step(p: Parameters, iterations: number, brush = idleBrush, view?: ViewState) {
    const gl = this.gl; gl.useProgram(this.programs[0]); gl.viewport(0,0,this.width,this.height);
    gl.uniform1i(this.loc(0,'cells'),0); gl.uniform2f(this.loc(0,'size'),this.width,this.height);
    gl.uniform4f(this.loc(0,'params'),p.feed,p.kill,p.diffusionA,p.diffusionB); gl.uniform4f(this.loc(0,'brush'),brush.x,brush.y,brush.radius,brush.mode);
    gl.uniform1f(this.loc(0,'amount'),brush.amount);
    this.writeMix(0, view);
    for (let i = 0; i < iterations; i++) { gl.bindFramebuffer(gl.FRAMEBUFFER,this.frames[1-this.index]); gl.bindTexture(gl.TEXTURE_2D,this.textures[this.index]); gl.drawArrays(gl.TRIANGLES,0,3); this.index = 1-this.index; }
  }
  private writeView(program: number, zoom: number, pan: View) {
    const gl = this.gl; const scale = viewScale(this.canvas, this.width, this.height);
    gl.uniform1i(this.loc(program,'cells'),0); gl.uniform2f(this.loc(program,'size'),this.width,this.height);
    gl.uniform2f(this.loc(program,'viewScale'),scale.x,scale.y); gl.uniform2f(this.loc(program,'pan'),pan.x,pan.y); gl.uniform1f(this.loc(program,'zoom'),zoom);
  }
  render(palette: Palette, threshold: number, zoom: number, pan: View) {
    const gl = this.gl; gl.useProgram(this.programs[1]); gl.bindFramebuffer(gl.FRAMEBUFFER,null); gl.viewport(0,0,this.canvas.width,this.canvas.height); gl.bindTexture(gl.TEXTURE_2D,this.textures[this.index]);
    this.writeView(1, zoom, pan); this.writeMix(1, { zoom, pan });
    gl.uniform3fv(this.loc(1,'bg'),rgb(palette.background)); gl.uniform3fv(this.loc(1,'fg'),rgb(palette.foreground));
    gl.uniform1f(this.loc(1,'threshold'),threshold); gl.drawArrays(gl.TRIANGLES,0,3);
  }
  async capture(view: ViewState) {
    const gl = this.gl; gl.useProgram(this.programs[2]); gl.bindFramebuffer(gl.FRAMEBUFFER,this.captureFrame); gl.viewport(0,0,LAYER_WIDTH,LAYER_HEIGHT); gl.bindTexture(gl.TEXTURE_2D,this.textures[this.index]);
    this.writeView(2, view.zoom, view.pan); gl.drawArrays(gl.TRIANGLES,0,3);
    const data = new Uint8Array(LAYER_WIDTH*LAYER_HEIGHT*4); gl.readPixels(0,0,LAYER_WIDTH,LAYER_HEIGHT,gl.RGBA,gl.UNSIGNED_BYTE,data);
    if (gl.getError() !== gl.NO_ERROR) throw new Error('Could not capture the visible field.');
    return data;
  }
  async read() {
    const gl = this.gl; gl.bindFramebuffer(gl.FRAMEBUFFER,this.frames[this.index]);
    // RGBA/FLOAT readback is guaranteed for float render targets; RG/FLOAT is not.
    const rgba = new Float32Array(this.width*this.height*4); gl.readPixels(0,0,this.width,this.height,gl.RGBA,gl.FLOAT,rgba);
    if (gl.getError() !== gl.NO_ERROR) throw new Error('Could not read the GPU texture.');
    const data = new Float32Array(this.width*this.height*2);
    for (let i = 0; i < this.width*this.height; i++) { data[i*2] = rgba[i*4]; data[i*2+1] = rgba[i*4+1]; }
    return data;
  }
  destroy() { const gl = this.gl; this.programs.forEach(p=>gl.deleteProgram(p)); [...this.textures,this.foreign,this.captureTexture].forEach(t=>gl.deleteTexture(t)); [...this.frames,this.captureFrame].forEach(f=>gl.deleteFramebuffer(f)); gl.getExtension('WEBGL_lose_context')?.loseContext(); }
}
