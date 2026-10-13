import { gpuSceneField } from './scene-shaders';
import { mixModes } from './link';
import { VolumeEngine } from './engine3d';
import { idleBrush, rgb, type Brush, type Palette, type Parameters, type View } from './model';

// Keep the same atlas order as WebGL and saved snapshots. Work is dispatched in XYZ.
const addressing = `
fn address(p: vec3i, size: i32) -> u32 {
 let q = clamp(p, vec3i(0), vec3i(size - 1));
 return u32(((q.z / 8) * size + q.y) * (size * 8) + (q.z % 8) * size + q.x);
}
fn inside(p: vec3f, shape: f32) -> bool {
 return all(abs(p) <= vec3f(1.)) && (shape == 1. || length(p) < .98);
}`;
const compute = `
struct Settings { recipe: vec4f, brush: vec4f, geometry: vec4f, ownTransform: vec4f, peer1: vec4f, peer2: vec4f, peerInfo: vec4f, recipe1: vec4f, recipe2: vec4f, mixing: vec4f }
@group(0) @binding(0) var<storage, read> cells: array<vec2f>;
@group(0) @binding(1) var<storage, read_write> outputCells: array<vec2f>;
@group(0) @binding(2) var<uniform> settings: Settings;
@group(0) @binding(3) var<storage, read> foreign1: array<vec2f>;
@group(0) @binding(4) var<storage, read> foreign2: array<vec2f>;
${addressing}
fn neighbor(p: vec3i, center: vec2f) -> vec2f {
 let size = i32(settings.geometry.x);
 if (inside((vec3f(p) + .5) / f32(size) * 2. - 1., settings.geometry.y)) {
  return cells[address(p, size)];
 }
 return center;
}
@compute @workgroup_size(8, 4, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
 let size = i32(settings.geometry.x);
 if (any(id >= vec3u(u32(size)))) { return; }
 let p = vec3i(id); let index = address(p, size);
 let position = (vec3f(p) + .5) / f32(size) * 2. - 1.;
 let c = cells[index];
 if (!inside(position, settings.geometry.y)) { outputCells[index] = vec2f(1., 0.); return; }
 let lap = (neighbor(p + vec3i(1,0,0), c) + neighbor(p - vec3i(1,0,0), c)
  + neighbor(p + vec3i(0,1,0), c) + neighbor(p - vec3i(0,1,0), c)
  + neighbor(p + vec3i(0,0,1), c) + neighbor(p - vec3i(0,0,1), c)) / 6. - c;
 let recipe=settings.recipe;let reaction=c.x*c.y*c.y;
 let world=position*settings.ownTransform.w+settings.ownTransform.xyz;
 var other=vec2f(0.);var otherRecipe=vec2f(0.);var contacts=0.;var selectedContact=0.;
 for(var i=0u;i<2u;i++) {
  if(f32(i)>=settings.peerInfo.w){break;}var transform=settings.peer1;var peerRecipe=settings.recipe1;
  if(i==1u){transform=settings.peer2;peerRecipe=settings.recipe2;}
  let local=(world-transform.xyz)/transform.w;
  if(inside(local,settings.peerInfo[i])){
   let index=address(vec3i((local+1.)*.5*f32(size)),size);var value=foreign1[index];if(i==1u){value=foreign2[index];}
   other+=value;otherRecipe+=peerRecipe.xy;contacts+=1.;selectedContact=max(selectedContact,peerRecipe.z);
  }
 }
 let mode=u32(settings.mixing.x);let strength=settings.peerInfo.z;var feed=recipe.x;var kill=recipe.y;
 if(contacts>0. && mode==1u){feed=mix(feed,otherRecipe.x/contacts,strength*.65);kill=mix(kill,otherRecipe.y/contacts,strength*.65);}
 var next=clamp(c+.5*vec2f(recipe.z*lap.x-reaction+feed*(1.-c.x),recipe.w*lap.y+reaction-(feed+kill)*c.y),vec2f(0.),vec2f(1.));
 if(contacts>0. && strength>0.){
  let average=other/contacts;
  if(mode==0u){next=mix(next,average,strength*.14);}
  else if(mode==1u){next=mix(next,average,strength*.06);}
  else if(mode==2u){if(settings.mixing.y>.5){next.y=min(1.,next.y+strength*average.y*.12);}else if(selectedContact>.5){next.y*=1.-strength*.12;}}
  else if(mode==3u){next.y*=1.-strength*average.y*.35;}
 }
 if (settings.brush.w != 0. && distance(position, settings.brush.xyz) < settings.geometry.z) {
  next = select(vec2f(1., 0.), vec2f(.5, abs(settings.brush.w)), settings.brush.w > 0.);
 }
 outputCells[index] = next;
}`;
const render = `
struct Display {
 viewport: vec4f, background: vec4f, foreground: vec4f,
 camera: vec4f, volume: vec4f, placement: vec4f,
 peer1:vec4f,peer2:vec4f,color1:vec4f,color2:vec4f,background1:vec4f,background2:vec4f,peerInfo:vec4f,mixing:vec4f
}
@group(0) @binding(0) var<storage, read> cells: array<vec2f>;
@group(0) @binding(1) var<uniform> display: Display;
@group(0) @binding(2) var<storage,read> foreign1:array<vec2f>;
@group(0) @binding(3) var<storage,read> foreign2:array<vec2f>;
${addressing}
fn at(p: vec3i) -> vec2f { return cells[address(p, i32(display.volume.x))]; }
fn rotate(p: vec3f) -> vec3f {
 let a = display.camera.x; let b = display.camera.y;
 let yy = cos(b) * p.y - sin(b) * p.z; let zz = sin(b) * p.y + cos(b) * p.z;
 return vec3f(cos(a) * p.x + sin(a) * zz, yy, -sin(a) * p.x + cos(a) * zz);
}
${gpuSceneField}
@vertex fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
 let p = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
 return vec4f(p * 2. - 1., 0., 1.);
}
struct Fragment { @location(0) color: vec4f, @builtin(frag_depth) depth: f32 }
fn finish(color: vec3f, depth: f32) -> Fragment { return Fragment(vec4f(pow(max(color,vec3f(0.)),vec3f(.9)),1.), depth); }
@fragment fn fs(@builtin(position) pixel: vec4f) -> Fragment {
 // WebGPU framebuffer Y starts at the top; the WebGL camera starts at the bottom.
 let screen = vec2f(pixel.x, display.viewport.y - pixel.y);
 let uv = (screen * 2. - display.viewport.xy) / min(display.viewport.x, display.viewport.y);
 let objectSize = display.volume.z; let shape = display.volume.y;
 let threshold = display.background.w; let zoom = display.camera.z; let cut = display.camera.w;
 var ro = rotate(vec3f(0., 0., max(display.placement.w, max(4.2, objectSize * 1.9))));
 let rd = rotate(normalize(vec3f(uv / max(.45, sqrt(zoom)), -2.8)));
 var color = mix(vec3f(.025,.033,.043), vec3f(.075,.09,.105), clamp(screen.y / display.viewport.y, 0., 1.));
 let floorT = (-1.16 * objectSize - ro.y) / rd.y;
 // Derivatives must run uniformly, even when the floor is hidden.
 let floorP = ro + rd * floorT;
 let g = abs(fract(floorP.xz * 2. - .5) - .5) / max(fwidth(floorP.xz * 2.), vec2f(.001));
 if (display.volume.w > .5 && floorT > 0.) {
  let grid = 1. - min(min(g.x, g.y), 1.); let fade = exp(-length(floorP.xz) * .35);
  color += vec3f(.09,.11,.13) * grid * fade;
  color *= 1. - .55 * exp(-dot(floorP.xz, floorP.xz) / (objectSize * objectSize) * 1.6);
 }
 ro = (ro-display.placement.xyz)/objectSize;
 let bounds=sceneBounds();let inv = 1. / rd; let nearT = (bounds.lower - ro) * inv; let farT = (bounds.upper - ro) * inv;
 let lo = min(nearT, farT); let hi = max(nearT, farT);
 var entry = max(max(lo.x, lo.y), lo.z); var leave = min(min(hi.x, hi.y), hi.z);
 if (shape == 0. && !fused()) {
  let b = dot(ro, rd); let d = b*b - dot(ro,ro) + .98*.98;
  if (d < 0.) { if (display.viewport.z > .5) { discard; } return finish(color, 1.); }
  entry = max(entry, -b-sqrt(d)); leave = min(leave, -b+sqrt(d));
 }
 let stride = 1.15 / display.volume.x;
 var t = max(entry, 0.);var lastStride=stride; var hit = false; var p = vec3f(0.);
 for (var i = 0; i < 1800; i++) {
  if (t > leave) { break; }
  p = ro + rd*t;
  if (density(p,false) > threshold-.09 && field(p) > threshold) {
   var low = max(entry, t-lastStride); var high = t;
   for (var j = 0; j < 4; j++) {
    let mid = (low+high)*.5; let q = ro+rd*mid;
    if (field(q) > threshold) { high = mid; } else { low = mid; }
   }
   p = ro+rd*high; t = high; hit = true; break;
  }
  lastStride=marchStride(p);t += lastStride;
 }
 if (!hit && display.viewport.z > .5) { discard; }
 if (hit) {
  let e = 1.4 / display.volume.x;
  var n = -vec3f(field(p+vec3f(e,0.,0.))-field(p-vec3f(e,0.,0.)),
   field(p+vec3f(0.,e,0.))-field(p-vec3f(0.,e,0.)), field(p+vec3f(0.,0.,e))-field(p-vec3f(0.,0.,e)));
  if (!fused() && shape == 0. && length(p) > .95) { n = p; }
  if (!fused() && shape == 1. && max(max(abs(p.x),abs(p.y)),abs(p.z)) > .975) { n = sign(p)*step(vec3f(.975), abs(p)); }
  if (abs(p.z-cut) < stride*1.3) { n = vec3f(0.,0.,1.); }
  if (length(n) > .0001) { n = normalize(n); } else { n = -rd; }
  if (dot(n,rd) > 0.) { n = -n; }
  let light = normalize(vec3f(-.6,1.,1.4));
  let diffuse = max(0.,dot(n,light)); let rim = pow(1.-max(0.,dot(n,-rd)),3.);
  let spec = pow(max(0.,dot(n,normalize(light-rd))),35.);
  let colors=materialColors(p);let material = mix(colors.background, colors.foreground, smoothstep(threshold,threshold+.13,field(p))*.55+.45);
  color = material*(.25+.85*diffuse) + vec3f(.55,.7,.85)*rim*.23 + spec*.3;
  color *= .83+.17*clamp((p.y+1.)*.5,0.,1.);
 } else if (leave > max(entry,0.)) {
  let outline = select(.025+.1*pow(1.-clamp((leave-entry)*.5,0.,1.),5.), .08, shape == 1.);
  color += vec3f(.25,.35,.45)*outline;
 }
 return finish(color, select(1., (t*objectSize)/(t*objectSize+1.), hit));
}`;

/** Compute shaders advance the same Gray–Scott volume used by the WebGL fallback. */
export class WebGPUVolumeEngine extends VolumeEngine {
  readonly backend = 'WebGPU' as const;
  private alive = true;
  private index = 0;
  override get currentIndex() { return this.index; }
  private sharedTarget: { depth?: GPUTexture; width: number; height: number } = { width: 0, height: 0 };
  private ownsDevice = true;
  private peerRenderGroups=new Map<string,GPUBindGroup>();
  private peerGroups = new Map<string, GPUBindGroup>();
  private context: GPUCanvasContext;
  private buffers: GPUBuffer[] = [];
  private settings: GPUBuffer;
  private display: GPUBuffer;
  private compute: GPUComputePipeline;
  private renderer: GPURenderPipeline;
  private groups: GPUBindGroup[];
  private renderGroups: GPUBindGroup[];

  static async create(canvas: HTMLCanvasElement, size = 64, onLost: () => void = () => {}) {
    if (!navigator.gpu) throw new Error('WebGPU is not available in this browser.');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter is available.');
    const bytes = size ** 3 * 8;
    if (bytes > adapter.limits.maxStorageBufferBindingSize || bytes > adapter.limits.maxBufferSize) {
      throw new Error(`${size}³ exceeds this GPU's storage buffer limit.`);
    }
    const device = await adapter.requestDevice({ requiredLimits: {
      maxStorageBufferBindingSize: Math.max(128 * 1024 * 1024, bytes),
      maxBufferSize: Math.max(256 * 1024 * 1024, bytes),
    } });
    let engine: WebGPUVolumeEngine | undefined;
    device.pushErrorScope('out-of-memory'); device.pushErrorScope('validation');
    try {
      engine = new WebGPUVolumeEngine(canvas, size, device);
      await engine.buildPipelines();
      const validation = await device.popErrorScope(); const allocation = await device.popErrorScope();
      if (validation || allocation) throw new Error((validation ?? allocation)!.message);
      device.lost.then(() => { if (engine?.alive) onLost(); });
      return engine;
    } catch (error) {
      if (engine) engine.destroy(); else device.destroy();
      throw error;
    }
  }
  private constructor(canvas: HTMLCanvasElement, size: number, private device: GPUDevice) {
    super(canvas, size);
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('Cannot create a WebGPU canvas.');
    this.context = context;
    context.configure({ device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: 'opaque' });
    this.buffers = [0,1].map(() => device.createBuffer({ size: size ** 3 * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC }));
    this.settings = device.createBuffer({ size: 160, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.display = device.createBuffer({ size: 224, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // Assigned by buildPipelines before the engine is returned.
    this.compute = null!; this.renderer = null!; this.groups = []; this.renderGroups = [];
  }
  private async buildPipelines() {
    const device = this.device;
    const computeModule = device.createShaderModule({ code: compute });
    const renderModule = device.createShaderModule({ code: render });
    for (const module of [computeModule, renderModule]) {
      const info = await module.getCompilationInfo();
      const errors = info.messages.filter(message => message.type === 'error');
      if (errors.length) throw new Error(errors.map(message => `${message.lineNum}:${message.linePos} ${message.message}`).join('\n'));
    }
    this.compute = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: computeModule, entryPoint: 'main' } });
    this.renderer = await device.createRenderPipelineAsync({ layout: 'auto', vertex: { module: renderModule, entryPoint: 'vs' },
      fragment: { module: renderModule, entryPoint: 'fs', targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }] }, primitive: { topology: 'triangle-list' }, depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' } });
    this.buildGroups();
  }
  private buildGroups() {
    const device=this.device;
    this.groups = [0,1].map(i => device.createBindGroup({ layout: this.compute.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.buffers[i] } }, { binding: 1, resource: { buffer: this.buffers[1-i] } }, { binding: 2, resource: { buffer: this.settings } }, { binding: 3, resource: { buffer: this.buffers[i] } }, { binding: 4, resource: { buffer: this.buffers[i] } },
    ] }));
    this.renderGroups = [0,1].map(i => device.createBindGroup({ layout: this.renderer.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.buffers[i] } }, { binding: 1, resource: { buffer: this.display } },{binding:2,resource:{buffer:this.buffers[i]}},{binding:3,resource:{buffer:this.buffers[i]}},
    ] }));
  }
  seed(data: Float32Array) {
    if (data.length !== this.width * this.height * 2) throw new Error('Invalid volume dimensions.');
    for (const buffer of this.buffers) this.device.queue.writeBuffer(buffer, 0, data as Float32Array<ArrayBuffer>);
    this.index = 0;
  }
  async fork() {
    this.device.pushErrorScope('out-of-memory'); this.device.pushErrorScope('validation');
    let child:WebGPUVolumeEngine|undefined,scopesOpen=true;
    try {
      child=new WebGPUVolumeEngine(this.canvas,this.size,this.device);
      child.ownsDevice=false;child.sharedTarget=this.sharedTarget;
      child.compute=this.compute;child.renderer=this.renderer;child.buildGroups();
      const validation=await this.device.popErrorScope();const allocation=await this.device.popErrorScope();scopesOpen=false;
      if(validation||allocation)throw new Error((validation??allocation)!.message);
      return child;
    } catch(error){child?.destroy();throw error;}
    finally{if(scopesOpen){await this.device.popErrorScope().catch(()=>{});await this.device.popErrorScope().catch(()=>{});}}
  }
  private prepare(p: Parameters, brush: Brush) {
    const point = this.paintPoint;
    const peers = this.peers;
    this.device.queue.writeBuffer(this.settings, 0, new Float32Array([
      p.feed, p.kill, p.diffusionA, p.diffusionB, ...(point ?? [0,0,0]), point && brush.mode ? brush.mode * brush.amount : 0,
      this.size, this.shape === 'box' ? 1 : 0, brush.radius / this.size, 0,
      ...this.position,this.objectSize,
      ...(peers[0]?.position ?? [0,0,0]),peers[0]?.objectSize ?? 1,
      ...(peers[1]?.position ?? [0,0,0]),peers[1]?.objectSize ?? 1,
      peers[0]?.shape === 'box' ? 1 : 0,peers[1]?.shape === 'box' ? 1 : 0,this.interaction,peers.length,
      ...(peers[0]?.sceneRecipe??[0,0]),peers[0]?.isSelected?1:0,0,...(peers[1]?.sceneRecipe??[0,0]),peers[1]?.isSelected?1:0,0,
      mixModes.indexOf(this.mixMode),this.isSelected?1:0,0,0,
    ]));
  }
  private dispatch(pass: GPUComputePassEncoder) {
    let group = this.groups[this.index];
    if (this.peers.length) {
      const peers = this.peers as WebGPUVolumeEngine[];
      const indices = peers.map((peer,i) => this.peerIndices[i] ?? peer.index);
      const key = `${this.index}:${indices.join(':')}`;
      group = this.peerGroups.get(key)!;
      if (!group) {
        group = this.device.createBindGroup({ layout: this.compute.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer: this.buffers[this.index] } }, { binding: 1, resource: { buffer: this.buffers[1-this.index] } },
          { binding: 2, resource: { buffer: this.settings } },
          { binding: 3, resource: { buffer: peers[0].buffers[indices[0]] } },
          { binding: 4, resource: { buffer: peers[1]?.buffers[indices[1]] ?? peers[0].buffers[indices[0]] } },
        ] }); this.peerGroups.set(key, group);
      }
    }
    pass.setPipeline(this.compute); pass.setBindGroup(0,group);
    pass.dispatchWorkgroups(Math.ceil(this.size/8),Math.ceil(this.size/4),Math.ceil(this.size/4)); this.index=1-this.index;
  }
  resetPeers() { this.peerGroups.clear();this.peerRenderGroups.clear(); }
  static advanceScene(objects: WebGPUVolumeEngine[], recipes: Parameters[], iterations: number, brush: Brush, selected: number) {
    objects.forEach((object,i) => object.prepare(recipes[i], i===selected ? brush : idleBrush));
    const encoder=objects[0].device.createCommandEncoder(); const pass=encoder.beginComputePass();
    for(let i=0;i<iterations;i++) {
      const indices=new Map(objects.map(object=>[object,object.index]));
      objects.forEach(object=>{ object.peerIndices=object.peers.map(peer=>indices.get(peer as WebGPUVolumeEngine)!); object.dispatch(pass); });
    }
    pass.end(); objects[0].device.queue.submit([encoder.finish()]);
  }
  step(p: Parameters, iterations: number, brush: Brush = idleBrush) {
    this.prepare(p,brush);
    const encoder=this.device.createCommandEncoder(); const pass=encoder.beginComputePass();
    for(let i=0;i<iterations;i++) this.dispatch(pass);
    pass.end(); this.device.queue.submit([encoder.finish()]);
  }
  render(palette: Palette, threshold: number, zoom: number, _pan: View) {
    const peers=this.peers as WebGPUVolumeEngine[];
    this.device.queue.writeBuffer(this.display, 0, new Float32Array([
      this.canvas.width, this.canvas.height, this.renderLayer, 0, ...rgb(palette.background), threshold, ...rgb(palette.foreground), 0,
      this.orbit.x, this.orbit.y, zoom, this.cut, this.size, this.shape === 'box' ? 1 : 0, this.objectSize, this.showFloor ? 1 : 0, ...this.position, this.sceneDistance,
      ...(peers[0]?.position??[0,0,0]),peers[0]?.objectSize??1,...(peers[1]?.position??[0,0,0]),peers[1]?.objectSize??1,
      ...rgb(peers[0]?.scenePalette.foreground??palette.foreground),peers[0]?.sceneThreshold??threshold,
      ...rgb(peers[1]?.scenePalette.foreground??palette.foreground),peers[1]?.sceneThreshold??threshold,
      ...rgb(peers[0]?.scenePalette.background??palette.background),0,...rgb(peers[1]?.scenePalette.background??palette.background),0,
      peers[0]?.shape==='box'?1:0,peers[1]?.shape==='box'?1:0,this.interaction,peers.length,
      mixModes.indexOf(this.mixMode),peers[0]?.cut??1,peers[1]?.cut??1,0,
    ]));
    let group=this.renderGroups[this.index];
    if(peers.length){
      const key=`${this.index}:${peers.map(peer=>peer.index).join(':')}`;
      group=this.peerRenderGroups.get(key)!;
      if(!group){group=this.device.createBindGroup({layout:this.renderer.getBindGroupLayout(0),entries:[
        {binding:0,resource:{buffer:this.buffers[this.index]}},{binding:1,resource:{buffer:this.display}},
        {binding:2,resource:{buffer:peers[0].buffers[peers[0].index]}},{binding:3,resource:{buffer:peers[1]?.buffers[peers[1].index]??peers[0].buffers[peers[0].index]}},
      ]});this.peerRenderGroups.set(key,group);}
    }
    const target = this.sharedTarget;
    if (!target.depth || target.width !== this.canvas.width || target.height !== this.canvas.height) {
      target.depth?.destroy(); target.width=this.canvas.width; target.height=this.canvas.height;
      target.depth=this.device.createTexture({size:[target.width,target.height],format:'depth24plus',usage:GPUTextureUsage.RENDER_ATTACHMENT});
    }
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: this.context.getCurrentTexture().createView(), loadOp: this.renderLayer===0 ? 'clear' : 'load', storeOp: 'store', clearValue: [0,0,0,1] }], depthStencilAttachment: { view: target.depth.createView(), depthLoadOp: this.renderLayer===0 ? 'clear' : 'load', depthStoreOp:'store', depthClearValue:1 } });
    pass.setPipeline(this.renderer); pass.setBindGroup(0, group); pass.draw(3); pass.end(); this.device.queue.submit([encoder.finish()]);
  }
  async read() {
    const staging = this.device.createBuffer({ size: this.size ** 3 * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const encoder = this.device.createCommandEncoder(); encoder.copyBufferToBuffer(this.buffers[this.index], 0, staging, 0, staging.size);
      this.device.queue.submit([encoder.finish()]); await staging.mapAsync(GPUMapMode.READ);
      const data = new Float32Array(staging.getMappedRange().slice(0)); staging.unmap(); return data;
    } finally { staging.destroy(); }
  }
  destroy() {
    this.alive = false; if(this.ownsDevice) { this.context.unconfigure(); this.sharedTarget.depth?.destroy(); } this.buffers.forEach(buffer => buffer.destroy());
    this.settings.destroy(); this.display.destroy(); if(this.ownsDevice) this.device.destroy();
  }
}
