import { glSceneField } from './scene-shaders';
import { mixModes, type MixMode } from './link';
import type { Engine, Coupling } from './engine';
import { idleBrush, rgb, type Brush, type Palette, type Parameters, type View } from './model';
import { volumeGridSize, type VolumeShape } from './volume';

const vertex = `#version 300 es
void main() { vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2)); gl_Position=vec4(p*2.-1.,0.,1.); }`;
const common = `
precision highp float;
precision highp int;
uniform sampler2D cells;
uniform int shape;
uniform int size;
out vec4 result;
vec2 at(ivec3 p) {
 p=clamp(p,ivec3(0),ivec3(size-1));
 return texelFetch(cells,ivec2((p.z%8)*size+p.x,(p.z/8)*size+p.y),0).rg;
}
bool inside(vec3 p) { return all(lessThanEqual(abs(p),vec3(1.))) && (shape==1 || length(p)<.98); }
`;
const compute = `#version 300 es
${common}
uniform vec4 recipe;
uniform vec4 brush;
uniform float amount;
uniform sampler2D foreign1,foreign2;
uniform vec4 ownTransform,peerTransform[2],peerInfo,peerRecipes[2],mixSettings;
vec2 peerAt(sampler2D source, vec3 local) {
 ivec3 q=clamp(ivec3((local+1.)*.5*float(size)),ivec3(0),ivec3(size-1));
 return texelFetch(source,ivec2((q.z%8)*size+q.x,(q.z/8)*size+q.y),0).rg;
}
vec2 neighbor(ivec3 p, vec2 center) {
 return inside((vec3(p)+.5)/float(size)*2.-1.) ? at(p) : center;
}
void main() {
 ivec2 tile=ivec2(gl_FragCoord.xy); ivec3 p=ivec3(tile%size,(tile.y/size)*8+tile.x/size);
 vec3 position=(vec3(p)+.5)/float(size)*2.-1.; vec2 c=at(p);
 if (!inside(position)) { result=vec4(1,0,0,1); return; }
 // Six face neighbors, no-flux boundary. Sum of weights is zero.
 vec2 lap=(neighbor(p+ivec3(1,0,0),c)+neighbor(p-ivec3(1,0,0),c)
 +neighbor(p+ivec3(0,1,0),c)+neighbor(p-ivec3(0,1,0),c)
 +neighbor(p+ivec3(0,0,1),c)+neighbor(p-ivec3(0,0,1),c))/6.-c;
 float reaction=c.x*c.y*c.y;
 vec3 world=position*ownTransform.w+ownTransform.xyz;
 vec2 other=vec2(0.); vec2 otherRecipe=vec2(0.);float contacts=0.,selectedContact=0.;
 for(int i=0;i<2;i++) {
  if(float(i)>=peerInfo.w)break;
  vec3 local=(world-peerTransform[i].xyz)/peerTransform[i].w;
  if(all(lessThanEqual(abs(local),vec3(1.)))&&(peerInfo[i]==1.||length(local)<.98)) {
   other+=i==0?peerAt(foreign1,local):peerAt(foreign2,local);otherRecipe+=peerRecipes[i].xy;contacts+=1.;selectedContact=max(selectedContact,peerRecipes[i].z);
  }
 }
 float feed=recipe.x,kill=recipe.y;int mode=int(mixSettings.x+.5);float strength=peerInfo.z;
 if(contacts>0. && mode==1){feed=mix(feed,otherRecipe.x/contacts,strength*.65);kill=mix(kill,otherRecipe.y/contacts,strength*.65);}
 vec2 next=clamp(c+.5*vec2(recipe.z*lap.x-reaction+feed*(1.-c.x),recipe.w*lap.y+reaction-(feed+kill)*c.y),0.,1.);
 if(contacts>0. && strength>0.) {
  vec2 average=other/contacts;
  if(mode==0)next=mix(next,average,strength*.14);
  else if(mode==1)next=mix(next,average,strength*.06);
  else if(mode==2){if(mixSettings.y>.5)next.y=min(1.,next.y+strength*average.y*.12);else if(selectedContact>.5)next.y*=1.-strength*.12;}
  else if(mode==3){next.y*=1.-strength*average.y*.35;}
 }
 if (brush.w!=0. && distance(position,brush.xyz)<amount) next=brush.w>0. ? vec2(.5,abs(brush.w)) : vec2(1,0);
 result=vec4(next,0,1);
}`;
const render = `#version 300 es
${common}
uniform vec2 viewport;
uniform vec3 bg,fg;
uniform float threshold,zoom,cut,objectSize;
uniform vec2 orbit;
uniform bool floorVisible;
uniform vec4 placement;
uniform int renderLayer;
mat3 rotation() {
 float a=orbit.x,b=orbit.y;
 return mat3(cos(a),0.,-sin(a),0.,1.,0.,sin(a),0.,cos(a))*mat3(1.,0.,0.,0.,cos(b),sin(b),0.,-sin(b),cos(b));
}
${glSceneField}
void main() {
 vec2 uv=(gl_FragCoord.xy*2.-viewport)/min(viewport.x,viewport.y);
 mat3 rot=rotation(); vec3 ro=rot*vec3(0,0,max(placement.w,max(4.2,objectSize*1.9))),rd=rot*normalize(vec3(uv/max(.45,sqrt(zoom)), -2.8));
 vec3 color=mix(vec3(.025,.033,.043),vec3(.075,.09,.105),clamp(gl_FragCoord.y/viewport.y,0.,1.));
 // Ground plane with a quiet grid and contact shadow.
 float floorT=(-1.16*objectSize-ro.y)/rd.y;
 if (floorVisible && floorT>0.) {
  vec3 floorP=ro+rd*floorT; vec2 g=abs(fract(floorP.xz*2.-.5)-.5)/max(fwidth(floorP.xz*2.),vec2(.001));
  float grid=1.-min(min(g.x,g.y),1.); float fade=exp(-length(floorP.xz)*.35);
  color+=vec3(.09,.11,.13)*grid*fade;
  color*=1.-.55*exp(-dot(floorP.xz,floorP.xz)/(objectSize*objectSize)*1.6);
 }
 ro=(ro-placement.xyz)/objectSize;
 vec3 lower,upper;bounds(lower,upper);
 vec3 inv=1./rd, nearT=(lower-ro)*inv, farT=(upper-ro)*inv;
 vec3 lo=min(nearT,farT),hi=max(nearT,farT);
 float entry=max(max(lo.x,lo.y),lo.z), leave=min(min(hi.x,hi.y),hi.z);
 if(shape==0 && !fused()) {
  float b=dot(ro,rd), d=b*b-dot(ro,ro)+.98*.98;
  if(d<0.) { if(renderLayer>0) discard; gl_FragDepth=1.; result=vec4(pow(max(color,vec3(0.)),vec3(.9)),1.); return; }
  entry=max(entry,-b-sqrt(d)); leave=min(leave,-b+sqrt(d));
 }
 float stride=1.15/float(size);
 float t=max(entry,0.),lastStride=stride; bool hit=false; vec3 p=vec3(0);
 for(int i=0;i<1800;i++) {
  if(t>leave) break;
  p=ro+rd*t;
  if(density(p,false)>threshold-.09 && field(p)>threshold) {
   float low=max(entry,t-lastStride),high=t;
   for(int j=0;j<4;j++) { float mid=(low+high)*.5; vec3 q=ro+rd*mid; if(field(q)>threshold) high=mid; else low=mid; }
   p=ro+rd*high; t=high; hit=true;break;
  }
  lastStride=marchStride(p);t+=lastStride;
 }
 if(!hit && renderLayer>0) discard;
 gl_FragDepth=hit ? (t*objectSize)/(t*objectSize+1.) : 1.;
 if(hit) {
  float e=1.4/float(size); vec3 n=-vec3(field(p+vec3(e,0,0))-field(p-vec3(e,0,0)),field(p+vec3(0,e,0))-field(p-vec3(0,e,0)),field(p+vec3(0,0,e))-field(p-vec3(0,0,e)));
  if(!fused() && shape==0 && length(p)>.95) n=p;
  if(!fused() && shape==1 && max(max(abs(p.x),abs(p.y)),abs(p.z))>.975) n=sign(p)*step(vec3(.975),abs(p));
  if(abs(p.z-cut)<stride*1.3) n=vec3(0,0,1);
  n=length(n)>.0001 ? normalize(n) : -rd;
  if(dot(n,rd)>0.) n=-n;
  vec3 light=normalize(vec3(-.6,1.,1.4));
  float diffuse=max(0.,dot(n,light)), rim=pow(1.-max(0.,dot(n,-rd)),3.);
  float spec=pow(max(0.,dot(n,normalize(light-rd))),35.);
  vec3 materialBG,materialFG;materialColors(p,materialBG,materialFG);
  vec3 material=mix(materialBG,materialFG,smoothstep(threshold,threshold+.13,field(p))*.55+.45);
  color=material*(.25+.85*diffuse)+vec3(.55,.7,.85)*rim*.23+spec*.3;
  color*=.83+.17*clamp((p.y+1.)*.5,0.,1.);
 } else if(leave>max(entry,0.)) {
  // Faint vessel silhouette makes an empty or cleared field navigable.
  float outline=shape==1 ? .08 : .025+.1*pow(1.-clamp((leave-entry)*.5,0.,1.),5.);
  color+=vec3(.25,.35,.45)*outline;
 }
 result=vec4(pow(max(color,vec3(0.)),vec3(.9)),1.);
}`;

/** Shared volume controls and camera picking for either GPU backend. */
export abstract class VolumeEngine implements Engine {
  abstract readonly backend: 'WebGPU' | 'WebGL 2';
  readonly width: number;
  readonly height: number;
  position: [number,number,number] = [0,0,0];
  sceneDistance = 0;
  renderLayer = 0;
  peers: VolumeEngine[] = [];
  peerIndices: number[] = [];
  interaction = .85;
  mixMode: MixMode='melt';
  isSelected=false;
  scenePalette: Palette={name:'',background:'#20221d',foreground:'#e3e5cc'};
  sceneThreshold=.19;
  sceneRecipe: [number,number]=[.0367,.0649];
  get currentIndex() { return 0; }
  objectSize = 1;
  showFloor = true;
  orbit = { x: .45, y: -.25 };
  cut = 1;
  shape: VolumeShape = 'sphere';
  pickDistance = Infinity;
  protected paintPoint: number[] | null = null;
  constructor(protected canvas: HTMLCanvasElement, readonly size = 64) {
    if (![64, 128, 192, 256].includes(size)) throw new Error('Unsupported volume resolution.');
    ({ width: this.width, height: this.height } = volumeGridSize(size / 64));
  }
  abstract seed(data: Float32Array): void;
  abstract step(params: Parameters, iterations: number, brush?: Brush): void;
  abstract render(palette: Palette, threshold: number, zoom: number, pan: View): void;
  abstract read(): Promise<Float32Array>;
  abstract destroy(): void;
  setCoupling(_coupling: Coupling) { /* One isolated object in phase one. */ }
  async capture() { return null; }
  ray(clientX:number,clientY:number,zoom:number) {
    const rect=this.canvas.getBoundingClientRect(),a=this.orbit.x,b=this.orbit.y;
    const rotate=([x,y,z]:number[])=>{const yy=Math.cos(b)*y-Math.sin(b)*z,zz=Math.sin(b)*y+Math.cos(b)*z;return [Math.cos(a)*x+Math.sin(a)*zz,yy,-Math.sin(a)*x+Math.cos(a)*zz];};
    const origin=rotate([0,0,Math.max(this.sceneDistance,4.2,this.objectSize*1.9)]);
    const direction=rotate([(2*(clientX-rect.left)-rect.width)/Math.min(rect.width,rect.height)/Math.max(.45,Math.sqrt(zoom)),(rect.height-2*(clientY-rect.top))/Math.min(rect.width,rect.height)/Math.max(.45,Math.sqrt(zoom)),-2.8]);
    const length=Math.hypot(...direction);return {origin,direction:direction.map(v=>v/length)};
  }
  /** Pick the vessel boundary or cut plane using the same world-space camera. */
  pick(clientX:number,clientY:number,zoom:number) {
    const ray=this.ray(clientX,clientY,zoom),ro=ray.origin.map((v,i)=>(v-this.position[i])/this.objectSize),rd=ray.direction;
    this.pickDistance=Infinity;
    this.paintPoint=null;
    let entry=-Infinity,leave=Infinity;
    for(let i=0;i<3;i++){
      if(Math.abs(rd[i])<1e-9){if(Math.abs(ro[i])>1)return false;continue;}
      const a=(-1-ro[i])/rd[i],b=(1-ro[i])/rd[i];entry=Math.max(entry,Math.min(a,b));leave=Math.min(leave,Math.max(a,b));
    }
    if(this.shape==='sphere'){
      const b=ro.reduce((sum,v,i)=>sum+v*rd[i],0),d=b*b-ro.reduce((sum,v)=>sum+v*v,0)+.98**2;
      if(d<0)return false;entry=Math.max(entry,-b-Math.sqrt(d));leave=Math.min(leave,-b+Math.sqrt(d));
    }
    if(Math.abs(rd[2])<1e-9){if(ro[2]>=this.cut)return false;}
    else{const t=(this.cut-ro[2])/rd[2];if(rd[2]>0)leave=Math.min(leave,t);else entry=Math.max(entry,t);}
    entry=Math.max(0,entry);if(leave<=entry)return false;
    const t=entry+Math.min(.5/this.size,(leave-entry)*.25);
    this.paintPoint=ro.map((v,i)=>v+rd[i]*t);this.pickDistance=entry*this.objectSize;return true;
  }
}

/** WebGL volume stored as an atlas with eight columns of Z slices. */
export class WebGLVolumeEngine extends VolumeEngine {
  readonly backend = 'WebGL 2' as const;
  private gl: WebGL2RenderingContext;
  private programs: WebGLProgram[] = [];
  private textures: WebGLTexture[] = [];
  private frames: WebGLFramebuffer[] = [];
  private locations = new Map<string, WebGLUniformLocation | null>();
  private index = 0;
  override get currentIndex() { return this.index; }
  constructor(canvas: HTMLCanvasElement, size = 64) {
    super(canvas, size);
    const gl=canvas.getContext('webgl2',{alpha:false,antialias:false,preserveDrawingBuffer:true});
    if(!gl || !gl.getExtension('EXT_color_buffer_float')) throw new Error('3D needs WebGPU or WebGL 2 with floating-point textures.');
    this.gl=gl;
    try {
      const limit = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
      if (this.width > limit || this.height > limit) throw new Error(`${size}³ exceeds this GPU's texture size limit. Choose a lower resolution.`);
      for(const source of [compute,render]) {
        const program=gl.createProgram()!; this.programs.push(program);
        for(const [type,code] of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,source]] as const) {
          const shader=gl.createShader(type)!; gl.shaderSource(shader,code); gl.compileShader(shader);
          const ok=gl.getShaderParameter(shader,gl.COMPILE_STATUS), log=gl.getShaderInfoLog(shader);
          if(ok) gl.attachShader(program,shader); gl.deleteShader(shader);
          if(!ok) throw new Error(log || '3D shader compilation failed.');
        }
        gl.linkProgram(program); if(!gl.getProgramParameter(program,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || '3D shader linking failed.');
      }
      for(let i=0;i<2;i++) {
        const texture=gl.createTexture()!; this.textures.push(texture); gl.bindTexture(gl.TEXTURE_2D,texture);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RG32F,this.width,this.height,0,gl.RG,gl.FLOAT,null);
        const frame=gl.createFramebuffer()!; this.frames.push(frame); gl.bindFramebuffer(gl.FRAMEBUFFER,frame); gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
        if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE) throw new Error('3D floating-point framebuffer is unavailable.');
      }
    } catch(error) { this.destroy(); throw error; }
  }
  private loc(program: number,name: string) {
    const key=`${program}:${name}`;
    if(!this.locations.has(key)) this.locations.set(key,this.gl.getUniformLocation(this.programs[program],name));
    return this.locations.get(key)!;
  }
  seed(data: Float32Array) {
    if(data.length!==this.width*this.height*2) throw new Error('Invalid volume dimensions.');
    const gl=this.gl; this.index=0;
    for(const texture of this.textures) { gl.bindTexture(gl.TEXTURE_2D,texture); gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,this.width,this.height,gl.RG,gl.FLOAT,data); }
  }
  step(p: Parameters,iterations: number,brush: Brush=idleBrush) {
    const gl=this.gl; gl.useProgram(this.programs[0]); gl.viewport(0,0,this.width,this.height);
    gl.uniform1i(this.loc(0,'size'),this.size); gl.uniform1i(this.loc(0,'cells'),0); gl.uniform1i(this.loc(0,'shape'),this.shape==='box'?1:0);
    gl.uniform4f(this.loc(0,'recipe'),p.feed,p.kill,p.diffusionA,p.diffusionB);
    const point=this.paintPoint;
    gl.uniform4f(this.loc(0,'brush'),...(point??[0,0,0]) as [number,number,number],point && brush.mode ? brush.mode*brush.amount : 0);
    gl.uniform1f(this.loc(0,'amount'),brush.radius/this.size);
    gl.uniform4f(this.loc(0,'mixSettings'),mixModes.indexOf(this.mixMode),this.isSelected?1:0,0,0);
    gl.uniform4f(this.loc(0,'ownTransform'),...this.position,this.objectSize);
    gl.uniform4f(this.loc(0,'peerInfo'),this.peers[0]?.shape==='box'?1:0,this.peers[1]?.shape==='box'?1:0,this.interaction,this.peers.length);
    this.peers.forEach((peer,i)=>{
      const other=peer as WebGLVolumeEngine;
      gl.activeTexture(gl.TEXTURE1+i); gl.bindTexture(gl.TEXTURE_2D,other.textures[this.peerIndices[i]??other.index]);
      gl.uniform1i(this.loc(0,i===0?'foreign1':'foreign2'),i+1);
      gl.uniform4f(this.loc(0,`peerTransform[${i}]`),...peer.position,peer.objectSize);
      gl.uniform4f(this.loc(0,`peerRecipes[${i}]`),...(peer as VolumeEngine).sceneRecipe,peer.isSelected?1:0,0);
    });
    // Both sampler uniforms need a different unit from the output attachment.
    if(!this.peers.length) { gl.uniform1i(this.loc(0,'foreign1'),0); gl.uniform1i(this.loc(0,'foreign2'),0); }
    else if(this.peers.length===1) gl.uniform1i(this.loc(0,'foreign2'),1);
    gl.activeTexture(gl.TEXTURE0);
    for(let i=0;i<iterations;i++) { gl.bindTexture(gl.TEXTURE_2D,this.textures[this.index]); gl.bindFramebuffer(gl.FRAMEBUFFER,this.frames[1-this.index]); gl.drawArrays(gl.TRIANGLES,0,3); this.index=1-this.index; }
  }
  render(palette: Palette,threshold: number,zoom: number,_pan: View) {
    const gl=this.gl; gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.bindFramebuffer(gl.FRAMEBUFFER,null); if(this.renderLayer===0) { gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT); } gl.activeTexture(gl.TEXTURE0); gl.useProgram(this.programs[1]); gl.bindFramebuffer(gl.FRAMEBUFFER,null); gl.viewport(0,0,this.canvas.width,this.canvas.height); gl.bindTexture(gl.TEXTURE_2D,this.textures[this.index]);
    gl.uniform4f(this.loc(1,'peerInfo'),this.peers[0]?.shape==='box'?1:0,this.peers[1]?.shape==='box'?1:0,this.interaction,this.peers.length);
    gl.uniform4f(this.loc(1,'sceneMix'),mixModes.indexOf(this.mixMode),this.peers[0]?.cut??1,this.peers[1]?.cut??1,0);
    for(let i=0;i<2;i++){
      const peer=this.peers[i] as WebGLVolumeEngine|undefined;
      gl.activeTexture(gl.TEXTURE1+i);gl.bindTexture(gl.TEXTURE_2D,peer?peer.textures[peer.index]:this.textures[this.index]);gl.uniform1i(this.loc(1,i===0?'foreign1':'foreign2'),i+1);
      gl.uniform4f(this.loc(1,`peerTransform[${i}]`),...(peer?.position??[0,0,0]) as [number,number,number],peer?.objectSize??1);
      gl.uniform4f(this.loc(1,`peerColors[${i}]`),...(rgb(peer?.scenePalette.foreground??palette.foreground) as [number,number,number]),peer?.sceneThreshold??threshold);
      gl.uniform4f(this.loc(1,`peerBackgrounds[${i}]`),...(rgb(peer?.scenePalette.background??palette.background) as [number,number,number]),0);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform4f(this.loc(1,'placement'),...this.position,this.sceneDistance); gl.uniform1i(this.loc(1,'renderLayer'),this.renderLayer);
    gl.uniform1i(this.loc(1,'size'),this.size); gl.uniform1f(this.loc(1,'objectSize'),this.objectSize); gl.uniform1i(this.loc(1,'floorVisible'),this.showFloor ? 1 : 0); gl.uniform1i(this.loc(1,'cells'),0); gl.uniform1i(this.loc(1,'shape'),this.shape==='box'?1:0);
    gl.uniform2f(this.loc(1,'viewport'),this.canvas.width,this.canvas.height); gl.uniform2f(this.loc(1,'orbit'),this.orbit.x,this.orbit.y);
    gl.uniform3fv(this.loc(1,'bg'),rgb(palette.background)); gl.uniform3fv(this.loc(1,'fg'),rgb(palette.foreground));
    gl.uniform1f(this.loc(1,'threshold'),threshold); gl.uniform1f(this.loc(1,'zoom'),zoom); gl.uniform1f(this.loc(1,'cut'),this.cut);
    gl.drawArrays(gl.TRIANGLES,0,3); gl.disable(gl.DEPTH_TEST);
  }
  async read() {
    const gl=this.gl, rgba=new Float32Array(this.width*this.height*4); gl.bindFramebuffer(gl.FRAMEBUFFER,this.frames[this.index]); gl.readPixels(0,0,this.width,this.height,gl.RGBA,gl.FLOAT,rgba);
    if(gl.getError()!==gl.NO_ERROR) throw new Error('Could not read the volume.');
    const data=new Float32Array(this.width*this.height*2); for(let i=0;i<this.width*this.height;i++) {data[i*2]=rgba[i*4];data[i*2+1]=rgba[i*4+1];} return data;
  }
  destroy() { const gl=this.gl; this.frames.forEach(f=>gl.deleteFramebuffer(f)); this.textures.forEach(t=>gl.deleteTexture(t)); this.programs.forEach(p=>gl.deleteProgram(p)); }
}
