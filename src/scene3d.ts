import { mixModes, type MixMode } from './link';
import { VolumeEngine, WebGLVolumeEngine } from './engine3d';
import { WebGPUVolumeEngine } from './engine3d-webgpu';
import { defaultStart, idleBrush, type Brush, type Palette, type Parameters, type StartSettings, type View } from './model';
import { makeVolumeSeed, resizeVolume, type VolumeShape } from './volume';

export interface VolumeObjectConfig {
  id: string; name: string; shape: VolumeShape; position: [number,number,number]; size: number;
  recipe: Parameters; palette: Palette; threshold: number; seed: number; start: StartSettings; cut: number;
}
export interface VolumeSceneSnapshot { selected: number; interaction: number; cameraDistance?:number; mode?:MixMode; sceneCut?:number; cutScope?:'all'|'selected'; objects: { config: VolumeObjectConfig; field: Float32Array }[] }
export interface VolumeSceneRecipe { selected: number; interaction: number; cameraDistance?:number; mode?:MixMode; sceneCut?:number; cutScope?:'all'|'selected'; objects: VolumeObjectConfig[] }
export const MAX_OBJECTS = 3;
export const copyObject = (config: VolumeObjectConfig): VolumeObjectConfig => structuredClone(config);
export function defaultObject(index = 0): VolumeObjectConfig {
  return { id: crypto.randomUUID(), name: `Object ${index+1}`, shape: index===1 ? 'box' : 'sphere', position: [index===0?0:index===1?.95:-.95,0,0], size: 1,
    recipe: { feed: .0367, kill: .0649, diffusionA: 1, diffusionB: .5 }, palette: { name:'Ivory',background:'#20221d',foreground:'#e3e5cc' },
    threshold:.19, seed:42+index*977, start:defaultStart(), cut:1 };
}
export function parseSceneRecipe(value: unknown): VolumeSceneRecipe | undefined {
  try {
    const scene = typeof value === 'string' ? JSON.parse(value) : value;
    if (!scene || !Array.isArray(scene.objects) || scene.objects.length<1 || scene.objects.length>MAX_OBJECTS) return;
    const finite = (v: unknown,min:number,max:number) => typeof v==='number' && Number.isFinite(v) && v>=min && v<=max;
    for (const c of scene.objects) {
      if (!c || typeof c.id!=='string' || typeof c.name!=='string' || c.name.length>40 || !['sphere','box'].includes(c.shape)
        || !Array.isArray(c.position) || c.position.length!==3 || !c.position.every((v:unknown)=>finite(v,-6,6)) || !finite(c.size,.5,3)
        || !finite(c.threshold,.08,.3) || !finite(c.seed,0,4294967295) || !finite(c.cut,-.9,1)
        || !c.recipe || !finite(c.recipe.feed,.005,.095) || !finite(c.recipe.kill,.03,.075) || !finite(c.recipe.diffusionA,.1,1) || !finite(c.recipe.diffusionB,.05,.8)
        || !c.palette || !/^#[0-9a-f]{6}$/i.test(c.palette.background) || !/^#[0-9a-f]{6}$/i.test(c.palette.foreground)
        || !c.start || !['empty','scatter','center','spot','ring','line','grid','image'].includes(c.start.mode)
        || !finite(c.start.count,1,1000) || !finite(c.start.radius,1,30) || !finite(c.start.amount,.05,.8)
        || typeof c.start.grown!=='boolean' || typeof c.start.paused!=='boolean'
        || !finite(c.start.x,0,1) || !finite(c.start.y,0,1) || !finite(c.start.imageScale,.1,1)) return;
    }
    if (!Number.isInteger(scene.selected) || scene.selected<0 || scene.selected>=scene.objects.length || !finite(scene.interaction,0,1)) return;
    if(scene.mode!==undefined && !mixModes.includes(scene.mode))return;
    if(scene.sceneCut!==undefined && !finite(scene.sceneCut,-.9,1))return;
    if(scene.cutScope!==undefined && !['all','selected'].includes(scene.cutScope))return;
    if(scene.cameraDistance!==undefined && !finite(scene.cameraDistance,0,100))return;
    if(new Set(scene.objects.map((c:VolumeObjectConfig)=>c.id)).size!==scene.objects.length)return;
    return structuredClone(scene);
  } catch { return; }
}

export function objectsOverlap(a:VolumeObjectConfig,b:VolumeObjectConfig) {
  const delta=a.position.map((v,i)=>Math.abs(v-b.position[i]));
  if(a.shape==='sphere'&&b.shape==='sphere')return Math.hypot(...delta)<.98*(a.size+b.size);
  if(a.shape==='box'&&b.shape==='box')return delta.every(v=>v<a.size+b.size);
  const sphere=a.shape==='sphere'?a:b,box=a.shape==='box'?a:b;
  return Math.hypot(...delta.map(v=>Math.max(0,v-box.size)))<sphere.size*.98;
}

/** Up to three independent GPU volumes sharing the canvas, camera and depth buffer. */
export class SceneVolumeEngine extends VolumeEngine {
  readonly backend: 'WebGPU' | 'WebGL 2';
  objects: { config: VolumeObjectConfig; engine: VolumeEngine }[];
  selected = 0;
  cameraDistance=0;
  sceneCut=1;
  cutScope:'all'|'selected'='all';
  private contactPairs=0;
  get contacts(){return this.contactPairs;}
  get dragging(){return this.drag!==null;}
  private drag: { point: number[]; position: number[]; normal: number[]; screen:[number,number]; depth:boolean } | null = null;
  private constructor(canvas: HTMLCanvasElement, size: number, root: VolumeEngine, config: VolumeObjectConfig) {
    super(canvas,size); this.backend=root.backend; this.objects=[{config:copyObject(config),engine:root}]; this.loadActive();
  }
  static async create(canvas: HTMLCanvasElement,size:number,backend:string,config:VolumeObjectConfig,onLost:()=>void) {
    const root=backend==='webgl' ? new WebGLVolumeEngine(canvas,size) : await WebGPUVolumeEngine.create(canvas,size,onLost);
    return new SceneVolumeEngine(canvas,size,root,config);
  }
  get active() { return this.objects[this.selected]; }
  loadActive() {
    const c=this.active.config;
    this.shape=c.shape; this.objectSize=c.size; this.position=[...c.position]; this.cut=this.cutScope==='all'?this.sceneCut:c.cut;
  }
  syncActive(recipe: Parameters,palette:Palette,threshold:number,seed:number,start:StartSettings) {
    Object.assign(this.active.config,{recipe:{...recipe},palette:{...palette},threshold,seed,start:{...start},shape:this.shape,size:this.objectSize,cut:this.cutScope==='selected'?this.cut:this.active.config.cut,position:[...this.position]});
  }
  private configure() {
    // A stable camera distance while dragging avoids the scene moving under the pointer.
    this.sceneDistance=Math.max(this.cameraDistance,this.objects.length===1 ? Math.max(4.2,this.objectSize*1.9) : 6.5);
    this.objects.forEach((object,i)=>{
      const e=object.engine,c=object.config; e.shape=c.shape;e.objectSize=c.size;e.position=[...c.position];e.cut=this.effectiveCut(c);
      e.orbit={...this.orbit};e.showFloor=this.showFloor;e.sceneDistance=this.sceneDistance;e.renderLayer=i;
      e.interaction=this.mixMode==='off'?0:this.interaction;e.mixMode=this.mixMode;e.isSelected=i===this.selected;
      e.scenePalette={...c.palette};e.sceneThreshold=c.threshold;e.sceneRecipe=[c.recipe.feed,c.recipe.kill];e.peers=this.objects.filter(other=>other!==object).map(other=>other.engine);
    });
    this.contactPairs=0;
    for(let i=0;i<this.objects.length;i++)for(let j=i+1;j<this.objects.length;j++)if(objectsOverlap(this.objects[i].config,this.objects[j].config))this.contactPairs++;
  }
  effectiveCut(config:VolumeObjectConfig) {
    if(this.cutScope==='selected')return config.cut;
    if(this.sceneCut>=1)return 1;
    const min=Math.min(...this.objects.map(o=>o.config.position[2]-o.config.size));
    const max=Math.max(...this.objects.map(o=>o.config.position[2]+o.config.size));
    const world=min+(this.sceneCut+1)*.5*(max-min);
    return Math.max(-1,Math.min(1,(world-config.position[2])/config.size));
  }
  setCut(value:number){this.cut=value;if(this.cutScope==='all')this.sceneCut=value;else this.active.config.cut=value;this.configure();}
  setCutScope(scope:'all'|'selected'){this.cutScope=scope;this.loadActive();this.configure();}
  project(position:number[],zoom:number) {
    const rect=this.canvas.getBoundingClientRect(),a=this.orbit.x,b=this.orbit.y;
    const x=Math.cos(a)*position[0]-Math.sin(a)*position[2],zz=Math.sin(a)*position[0]+Math.cos(a)*position[2];
    const y=Math.cos(b)*position[1]+Math.sin(b)*zz,z=-Math.sin(b)*position[1]+Math.cos(b)*zz-this.sceneDistance;
    const scale=Math.min(rect.width,rect.height)*.5*2.8*Math.max(.45,Math.sqrt(zoom))/Math.max(.01,-z);
    return {x:rect.width*.5+x*scale,y:rect.height*.5-y*scale,scale,visible:z<-.01};
  }
  async add(shape: VolumeShape) {
    if(this.objects.length>=MAX_OBJECTS) throw new Error('A scene can hold at most three objects.');
    const root=this.objects[0].engine;
    const engine=root instanceof WebGPUVolumeEngine ? await root.fork() : new WebGLVolumeEngine(this.canvas,this.size);
    try {
      const config=defaultObject(this.objects.length);config.shape=shape;
      config.name=`Object ${Math.max(...this.objects.map(o=>Number(o.config.name.match(/\d+$/)?.[0]??0)))+1}`;
      config.palette=copyObject(this.active.config).palette;
      if(this.objects.length===1) { config.palette.foreground='#c4e36f';config.recipe={feed:.03,kill:.062,diffusionA:1,diffusionB:.5}; }
      else { config.palette.foreground='#a5b9f0';config.recipe={feed:.0545,kill:.062,diffusionA:1,diffusionB:.5}; }
      engine.seed(makeVolumeSeed(this.width,config.seed,config.start,shape));
      this.objects.push({config,engine});this.selected=this.objects.length-1;this.loadActive();this.resetPeers();
    } catch(error) { engine.destroy();throw error; }
  }
  async remove() {
    if(this.objects.length===1) return;
    // Retain the root WebGPU device while deleting its object.
    if(this.selected===0) {
      const last=this.objects[this.objects.length-1];const field=await last.engine.read();
      this.objects[0].config=copyObject(last.config);this.objects[0].engine.seed(field);
      this.objects.pop()!.engine.destroy();
    } else this.objects.splice(this.selected,1)[0].engine.destroy();
    this.selected=Math.min(this.selected,this.objects.length-1);this.loadActive();this.resetPeers();
  }
  private resetPeers() { this.objects.forEach(object=>{if(object.engine instanceof WebGPUVolumeEngine)object.engine.resetPeers();});this.configure(); }
  recipe(): VolumeSceneRecipe { return {selected:this.selected,interaction:this.interaction,cameraDistance:this.cameraDistance,mode:this.mixMode,sceneCut:this.sceneCut,cutScope:this.cutScope,objects:this.objects.map(object=>copyObject(object.config))}; }
  async snapshot(): Promise<VolumeSceneSnapshot> {
    const recipe=this.recipe();const fields=await Promise.all(this.objects.map(object=>object.engine.read()));
    return {selected:recipe.selected,interaction:recipe.interaction,cameraDistance:recipe.cameraDistance,mode:recipe.mode,sceneCut:recipe.sceneCut,cutScope:recipe.cutScope,objects:recipe.objects.map((config,i)=>({config,field:fields[i]}))};
  }
  async restore(snapshot: VolumeSceneSnapshot, oldSize=this.size) {
    if(!parseSceneRecipe({selected:snapshot.selected,interaction:snapshot.interaction,cameraDistance:snapshot.cameraDistance,mode:snapshot.mode,sceneCut:snapshot.sceneCut,cutScope:snapshot.cutScope,objects:snapshot.objects.map(object=>object.config)})) throw new Error('Invalid scene settings.');
    if(snapshot.objects.some(object=>object.field.length!==oldSize**3*2)) throw new Error('Invalid scene field dimensions.');
    const added:VolumeEngine[]=[],root=this.objects[0].engine;
    try {
      while(this.objects.length+added.length<snapshot.objects.length) added.push(root instanceof WebGPUVolumeEngine ? await root.fork() : new WebGLVolumeEngine(this.canvas,this.size));
      const prepared=snapshot.objects.map(object=>({config:copyObject(object.config),field:resizeVolume(object.field,oldSize,this.size)}));
      const engines=[...this.objects.map(object=>object.engine),...added];
      prepared.forEach((object,i)=>engines[i].seed(object.field));
      const discarded=engines.slice(prepared.length);
      this.objects=prepared.map((object,i)=>({config:object.config,engine:engines[i]}));
      discarded.forEach(engine=>engine.destroy());
      this.selected=snapshot.selected;this.interaction=snapshot.interaction;this.cameraDistance=snapshot.cameraDistance??0;this.mixMode=snapshot.mode??'melt';this.sceneCut=snapshot.sceneCut??snapshot.objects[snapshot.selected].config.cut;this.cutScope=snapshot.cutScope??'all';
      this.loadActive();this.resetPeers();
    } catch(error) {added.forEach(engine=>engine.destroy());throw error;}
  }
  fitScene() {
    const extent=Math.max(...this.objects.map(object=>Math.hypot(...object.config.position)+object.config.size*Math.sqrt(3)));
    this.cameraDistance=Math.max(4.2,extent*1.9);this.configure();
    return (this.sceneDistance/(2.8*extent*1.15))**2;
  }
  async seedRecipe(recipe: VolumeSceneRecipe) {
    await this.restore({selected:recipe.selected,interaction:recipe.interaction,cameraDistance:recipe.cameraDistance,mode:recipe.mode,sceneCut:recipe.sceneCut,cutScope:recipe.cutScope,objects:recipe.objects.map(config=>({config,field:makeVolumeSeed(this.width,config.seed,config.start,config.shape)}))});
  }
  restartSeeds() {
    for(const object of this.objects){const c=object.config;object.engine.seed(makeVolumeSeed(this.width,c.seed,c.start,c.shape));}
  }
  seed(data: Float32Array) { this.active.engine.seed(data); }
  read() { return this.active.engine.read(); }
  step(recipe:Parameters,iterations:number,brush:Brush=idleBrush) {
    this.active.config.recipe={...recipe};this.configure();
    const objects=this.objects.map(object=>object.engine), recipes=this.objects.map(object=>object.config.recipe);
    if(objects[0] instanceof WebGPUVolumeEngine) WebGPUVolumeEngine.advanceScene(objects as WebGPUVolumeEngine[],recipes,iterations,brush,this.selected);
    else for(let i=0;i<iterations;i++) {
      const indices=new Map(objects.map(object=>[object,object.currentIndex]));
      objects.forEach((object,j)=>{object.peerIndices=object.peers.map(peer=>indices.get(peer)!);object.step(recipes[j],1,j===this.selected?brush:idleBrush);});
    }
  }
  render(palette:Palette,threshold:number,zoom:number,pan:View) {
    this.active.config.palette={...palette};this.active.config.threshold=threshold;this.configure();
    const fused=this.objects.length>1&&this.interaction>0&&(this.mixMode==='melt'||this.mixMode==='cross');
    (fused?this.objects.slice(0,1):this.objects).forEach(object=>object.engine.render(object.config.palette,object.config.threshold,zoom,pan));
  }
  override pick(x:number,y:number,zoom:number) {
    this.configure();let nearest=Infinity,selected=-1;
    this.objects.forEach((object,i)=>{if(object.engine.pick(x,y,zoom)&&object.engine.pickDistance<nearest){nearest=object.engine.pickDistance;selected=i;}});
    if(selected<0)return false;
    this.selected=selected;this.loadActive();return true;
  }
  beginObjectDrag(index:number,x:number,y:number,zoom:number,depth=false) {
    this.configure();this.selected=index;this.loadActive();
    const rect=this.canvas.getBoundingClientRect(),normal=this.ray(rect.left+rect.width/2,rect.top+rect.height/2,zoom).direction;
    const ray=this.ray(x,y,zoom),dot=(a:number[],b:number[])=>a.reduce((sum,v,i)=>sum+v*b[i],0);
    const t=dot(this.position.map((v,i)=>v-ray.origin[i]),normal)/dot(ray.direction,normal);
    const point=ray.origin.map((v,i)=>v+ray.direction[i]*t);
    this.drag={point,normal,position:[...this.position],screen:[x,y],depth};return true;
  }
  beginDrag(x:number,y:number,zoom:number,depth=false) {
    if(!this.pick(x,y,zoom))return false;
    const ray=this.ray(x,y,zoom),distance=this.active.engine.pickDistance;
    const point=ray.origin.map((v,i)=>v+ray.direction[i]*distance);
    this.beginObjectDrag(this.selected,x,y,zoom,depth);this.drag!.point=point;return true;
  }
  moveDrag(x:number,y:number,zoom:number) {
    if(!this.drag)return false;
    const ray=this.ray(x,y,zoom),d=this.drag;const dot=(a:number[],b:number[])=>a.reduce((sum,v,i)=>sum+v*b[i],0);
    if(d.depth){
      const amount=(y-d.screen[1])*this.sceneDistance*.003/Math.max(.45,Math.sqrt(zoom));
      this.position=d.position.map((v,i)=>Math.max(-6,Math.min(6,v+d.normal[i]*amount))) as [number,number,number];
      this.active.config.position=[...this.position];return true;
    }
    const t=dot(d.point.map((v,i)=>v-ray.origin[i]),d.normal)/dot(ray.direction,d.normal);
    this.position=d.position.map((v,i)=>Math.max(-6,Math.min(6,v+ray.origin[i]+ray.direction[i]*t-d.point[i]))) as [number,number,number];
    this.active.config.position=[...this.position];return true;
  }
  endDrag(){this.drag=null;}
  destroy() { for(let i=this.objects.length-1;i>=0;i--)this.objects[i].engine.destroy(); }
}
