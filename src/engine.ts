import { idleBrush, rgb, type Brush, type Palette, type Parameters, type View } from './model';

export interface Engine {
  readonly backend: 'WebGPU' | 'WebGL 2';
  readonly width: number;
  readonly height: number;
  seed(data: Float32Array): void;
  step(params: Parameters, iterations: number, brush?: Brush): void;
  render(palette: Palette, threshold: number, zoom: number, pan: View): void;
  read(): Promise<Float32Array>;
  destroy(): void;
}

const computeWGSL = `
struct Params { size: vec2f, feed: f32, kill: f32, da: f32, db: f32, dt: f32, pad: f32, brush: vec4f }
@group(0) @binding(0) var<storage, read> input: array<vec2f>;
@group(0) @binding(1) var<storage, read_write> output: array<vec2f>;
@group(0) @binding(2) var<uniform> p: Params;
fn sampleAt(q: vec2i) -> vec2f {
  let s = vec2i(p.size); let t = (q + s) % s;
  return input[u32(t.y * s.x + t.x)];
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= u32(p.size.x) || id.y >= u32(p.size.y)) { return; }
  let q = vec2i(id.xy); let c = sampleAt(q);
  var lap = -c;
  lap += .2 * (sampleAt(q+vec2i(1,0)) + sampleAt(q+vec2i(-1,0)) + sampleAt(q+vec2i(0,1)) + sampleAt(q+vec2i(0,-1)));
  lap += .05 * (sampleAt(q+vec2i(1,1)) + sampleAt(q+vec2i(-1,1)) + sampleAt(q+vec2i(1,-1)) + sampleAt(q+vec2i(-1,-1)));
  let reaction = c.x * c.y * c.y;
  var next = clamp(c + vec2f(p.da*lap.x - reaction + p.feed*(1.-c.x), p.db*lap.y + reaction - (p.kill+p.feed)*c.y) * p.dt, vec2f(0), vec2f(1));
  let d = abs(vec2f(id.xy) - p.brush.xy); let dw = min(d, p.size - d);
  if (p.brush.w != 0. && length(dw) < p.brush.z) {
    next = select(vec2f(1,0), vec2f(.5,.25), p.brush.w > 0.);
  }
  output[id.y * u32(p.size.x) + id.x] = next;
}`;
const renderWGSL = `
struct Display { size: vec2f, threshold: f32, zoom: f32, bg: vec4f, fg: vec4f, pan: vec2f, pad: vec2f }
@group(0) @binding(0) var<storage, read> cells: array<vec2f>;
@group(0) @binding(1) var<uniform> p: Display;
struct Vertex { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> Vertex {
  let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var v: Vertex; v.position = vec4f(xy * 2. - 1., 0., 1.); v.uv = vec2f(xy.x, 1.-xy.y); return v;
}
fn at(q: vec2i) -> f32 {
  let s = vec2i(p.size); let t = (q+s)%s; return cells[u32(t.y*s.x+t.x)].y;
}
@fragment fn fs(v: Vertex) -> @location(0) vec4f {
  let uv = (v.uv-.5)*vec2f(p.bg.w,p.fg.w)/p.zoom+.5;
  let q = uv * p.size + p.pan - .5; let i = vec2i(floor(q)); let f = fract(q);
  let b = mix(mix(at(i),at(i+vec2i(1,0)),f.x),mix(at(i+vec2i(0,1)),at(i+vec2i(1,1)),f.x),f.y);
  let t = smoothstep(p.threshold-.045,p.threshold+.045,b);
  return vec4f(mix(p.bg.rgb,p.fg.rgb,t),1.);
}`;

export class WebGPUEngine implements Engine {
  readonly backend = 'WebGPU' as const;
  private buffers: GPUBuffer[];
  private params: GPUBuffer;
  private display: GPUBuffer;
  private compute: GPUComputePipeline;
  private renderer: GPURenderPipeline;
  private groups: GPUBindGroup[];
  private renderGroups: GPUBindGroup[];
  private index = 0;
  private context: GPUCanvasContext;
  private alive = true;
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
    this.compute = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: computeWGSL }), entryPoint: 'main' } });
    const renderModule = device.createShaderModule({ code: renderWGSL });
    this.renderer = device.createRenderPipeline({ layout: 'auto', vertex: { module: renderModule, entryPoint: 'vs' }, fragment: { module: renderModule, entryPoint: 'fs', targets: [{ format }] }, primitive: { topology: 'triangle-list' } });
    this.groups = [0,1].map(i => device.createBindGroup({ layout: this.compute.getBindGroupLayout(0), entries: [this.buffers[i],this.buffers[1-i],this.params].map((buffer,binding) => ({ binding, resource: { buffer } })) }));
    this.renderGroups = [0,1].map(i => device.createBindGroup({ layout: this.renderer.getBindGroupLayout(0), entries: [this.buffers[i],this.display].map((buffer,binding) => ({ binding, resource: { buffer } })) }));
  }
  seed(data: Float32Array) { for (const buffer of this.buffers) this.device.queue.writeBuffer(buffer, 0, data as Float32Array<ArrayBuffer>); this.index = 0; }
  step(p: Parameters, iterations: number, brush = idleBrush) {
    this.device.queue.writeBuffer(this.params,0,new Float32Array([this.width,this.height,p.feed,p.kill,p.diffusionA,p.diffusionB,1,0,brush.x,brush.y,brush.radius,brush.mode]));
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass(); pass.setPipeline(this.compute);
    for (let i = 0; i < iterations; i++) { pass.setBindGroup(0,this.groups[this.index]); pass.dispatchWorkgroups(Math.ceil(this.width/8),Math.ceil(this.height/8)); this.index = 1-this.index; }
    pass.end(); this.device.queue.submit([encoder.finish()]);
  }
  render(palette: Palette, threshold: number, zoom: number, pan: View) {
    const aspect = this.canvas.width/this.canvas.height/(this.width/this.height);
    this.device.queue.writeBuffer(this.display,0,new Float32Array([this.width,this.height,threshold,zoom,...rgb(palette.background),Math.min(1,aspect),...rgb(palette.foreground),Math.min(1,1/aspect),pan.x,pan.y,0,0]));
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: this.context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0,0,0,1] }] });
    pass.setPipeline(this.renderer); pass.setBindGroup(0,this.renderGroups[this.index]); pass.draw(3); pass.end(); this.device.queue.submit([encoder.finish()]);
  }
  async read() {
    const staging = this.device.createBuffer({ size: this.width*this.height*8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const encoder = this.device.createCommandEncoder(); encoder.copyBufferToBuffer(this.buffers[this.index],0,staging,0,staging.size); this.device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ); const data = new Float32Array(staging.getMappedRange().slice(0)); staging.unmap(); return data;
    } finally { staging.destroy(); }
  }
  destroy() { this.alive = false; this.context.unconfigure(); this.buffers.forEach(b=>b.destroy()); this.params.destroy(); this.display.destroy(); this.device.destroy(); }
}

const vertexGL = `#version 300 es
precision highp float;
out vec2 uv;
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); uv = p; gl_Position = vec4(p*2.-1.,0.,1.); }`;
const computeGL = `#version 300 es
precision highp float;
uniform sampler2D cells;
uniform vec2 size;
uniform vec4 params;
uniform vec4 brush;
out vec4 result;
vec2 at(ivec2 q) { ivec2 s = ivec2(size); return texelFetch(cells,(q+s)%s,0).rg; }
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy); vec2 c = at(q);
  vec2 lap = -c + .2*(at(q+ivec2(1,0))+at(q+ivec2(-1,0))+at(q+ivec2(0,1))+at(q+ivec2(0,-1)))
    + .05*(at(q+ivec2(1,1))+at(q+ivec2(-1,1))+at(q+ivec2(1,-1))+at(q+ivec2(-1,-1)));
  float reaction = c.x*c.y*c.y;
  vec2 n = clamp(c + vec2(params.z*lap.x-reaction+params.x*(1.-c.x),params.w*lap.y+reaction-(params.x+params.y)*c.y),0.,1.);
  vec2 d = abs(vec2(q)-brush.xy); vec2 dw = min(d,size-d);
  if (brush.w != 0. && length(dw)<brush.z) n = brush.w>0. ? vec2(.5,.25) : vec2(1,0);
  result = vec4(n,0,1);
}`;
const renderGL = `#version 300 es
precision highp float;
uniform sampler2D cells;
uniform vec2 size;
uniform vec3 bg;
uniform vec3 fg;
uniform float threshold;
uniform float zoom;
uniform vec2 viewScale;
uniform vec2 pan;
in vec2 uv;
out vec4 result;
float at(ivec2 q) { ivec2 s = ivec2(size); return texelFetch(cells,(q+s)%s,0).g; }
void main() {
  vec2 q = ((vec2(uv.x,1.-uv.y)-.5)*viewScale/zoom+.5)*size+pan-.5; ivec2 i = ivec2(floor(q)); vec2 f = fract(q);
  float b = mix(mix(at(i),at(i+ivec2(1,0)),f.x),mix(at(i+ivec2(0,1)),at(i+ivec2(1,1)),f.x),f.y);
  result = vec4(mix(bg,fg,smoothstep(threshold-.045,threshold+.045,b)),1.);
}`;

export class WebGLEngine implements Engine {
  readonly backend = 'WebGL 2' as const;
  private gl: WebGL2RenderingContext;
  private programs: WebGLProgram[];
  private textures: WebGLTexture[];
  private frames: WebGLFramebuffer[];
  private index = 0;
  private locations = new Map<string, WebGLUniformLocation | null>();
  constructor(private canvas: HTMLCanvasElement, readonly width: number, readonly height: number) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: true });
    if (!gl || !gl.getExtension('EXT_color_buffer_float')) throw new Error('This device needs WebGPU or WebGL 2 with floating-point textures.');
    this.gl = gl;
    this.programs = [computeGL, renderGL].map(fragment => {
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
  step(p: Parameters, iterations: number, brush = idleBrush) {
    const gl = this.gl; gl.useProgram(this.programs[0]); gl.viewport(0,0,this.width,this.height);
    gl.uniform1i(this.loc(0,'cells'),0); gl.uniform2f(this.loc(0,'size'),this.width,this.height);
    gl.uniform4f(this.loc(0,'params'),p.feed,p.kill,p.diffusionA,p.diffusionB); gl.uniform4f(this.loc(0,'brush'),brush.x,brush.y,brush.radius,brush.mode);
    for (let i = 0; i < iterations; i++) { gl.bindFramebuffer(gl.FRAMEBUFFER,this.frames[1-this.index]); gl.bindTexture(gl.TEXTURE_2D,this.textures[this.index]); gl.drawArrays(gl.TRIANGLES,0,3); this.index = 1-this.index; }
  }
  render(palette: Palette, threshold: number, zoom: number, pan: View) {
    const gl = this.gl; gl.useProgram(this.programs[1]); gl.bindFramebuffer(gl.FRAMEBUFFER,null); gl.viewport(0,0,this.canvas.width,this.canvas.height); gl.bindTexture(gl.TEXTURE_2D,this.textures[this.index]);
    gl.uniform1i(this.loc(1,'cells'),0); gl.uniform2f(this.loc(1,'size'),this.width,this.height); gl.uniform3fv(this.loc(1,'bg'),rgb(palette.background)); gl.uniform3fv(this.loc(1,'fg'),rgb(palette.foreground));
    const aspect = this.canvas.width/this.canvas.height/(this.width/this.height);
    gl.uniform2f(this.loc(1,'viewScale'),Math.min(1,aspect),Math.min(1,1/aspect));
    gl.uniform2f(this.loc(1,'pan'),pan.x,pan.y);
    gl.uniform1f(this.loc(1,'threshold'),threshold); gl.uniform1f(this.loc(1,'zoom'),zoom); gl.drawArrays(gl.TRIANGLES,0,3);
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
  destroy() { const gl = this.gl; this.programs.forEach(p=>gl.deleteProgram(p)); this.textures.forEach(t=>gl.deleteTexture(t)); this.frames.forEach(f=>gl.deleteFramebuffer(f)); gl.getExtension('WEBGL_lose_context')?.loseContext(); }
}
