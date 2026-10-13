import { SceneVolumeEngine,defaultObject } from '../src/scene3d';
import { WebGPUVolumeEngine } from '../src/engine3d-webgpu';
import { configureCapture,gpuPixels } from './gpu-pixels';
import { voxelIndex } from '../src/volume';
function assert(value:boolean,message:string){if(!value)throw new Error(message);}
function filled(b:number){const data=new Float32Array(64**3*2);for(let i=0;i<data.length;i+=2){data[i]=.5;data[i+1]=b;}return data;}
export async function checkVisibleMixing(){
  const results=[];
  for(const backend of ['webgpu','webgl']){
    const canvas=document.createElement('canvas');canvas.width=200;canvas.height=140;canvas.style.cssText='position:fixed;left:-240px;top:0;width:200px;height:140px;';document.body.append(canvas);
    let scene:SceneVolumeEngine|undefined;
    try{
      const config=defaultObject();config.palette.foreground='#f05a69';scene=await SceneVolumeEngine.create(canvas,64,backend,config,()=>{});await scene.add('sphere');
      scene.objects[1].config.position=[.8,0,0];scene.objects[1].config.palette.foreground='#6ed9b6';scene.objects[1].config.recipe={feed:.005,kill:.03,diffusionA:1,diffusionB:.5};
      scene.selected=0;scene.loadActive();scene.objects.forEach(object=>object.engine.seed(filled(.12)));scene.interaction=.85;
      const root=scene.objects[0].engine;if(root instanceof WebGPUVolumeEngine)configureCapture(root);
      const pixels=async()=>{if(root instanceof WebGPUVolumeEngine)return gpuPixels(root,canvas);const copy=document.createElement('canvas');copy.width=canvas.width;copy.height=canvas.height;const ctx=copy.getContext('2d')!;ctx.drawImage(canvas,0,0);return ctx.getImageData(0,0,copy.width,copy.height).data;};
      const bright=(pixels:Uint8ClampedArray)=>{let count=0;for(let i=0;i<pixels.length;i+=4)if(Math.max(pixels[i],pixels[i+1],pixels[i+2])>80)count++;return count;};
      scene.mixMode='off';scene.render(scene.active.config.palette,.19,1,{x:0,y:0});const apart=bright(await pixels());
      scene.mixMode='melt';scene.render(scene.active.config.palette,.19,1,{x:0,y:0});const meltPixels=await pixels(),fused=bright(meltPixels);
      assert(fused>apart+100,'Melt did not make overlapping sub-threshold fields visibly fuse.');
      scene.setCut(0);scene.render(scene.active.config.palette,.19,1,{x:0,y:0});const cutPixels=await pixels(),clipped=bright(cutPixels);let changedPixels=0;for(let i=0;i<cutPixels.length;i+=4)if(cutPixels[i]!==meltPixels[i]||cutPixels[i+1]!==meltPixels[i+1]||cutPixels[i+2]!==meltPixels[i+2])changedPixels++;assert(changedPixels>100,'The shared cutaway did not change the fused surface.');
      assert(scene.objects.every(object=>Math.abs(object.engine.cut*object.config.size+object.config.position[2])<.00001),'Objects do not share the same cut plane.');
      scene.setCut(1);const initial=await scene.snapshot();const center=voxelIndex(32,32,32,64)+1;
      scene.mixMode='off';scene.step(scene.active.config.recipe,1);const isolated=await scene.snapshot();
      await scene.restore(initial);scene.mixMode='cross';scene.interaction=1;scene.step(scene.active.config.recipe,1);const cross=await scene.snapshot();
      assert(cross.objects[0].field[center]>isolated.objects[0].field[center]+.001,'Crossbreed did not blend the recipes.');
      await scene.restore(initial);scene.objects[0].engine.seed(filled(.1));scene.objects[1].engine.seed(filled(.8));const siphonInitial=await scene.snapshot();
      scene.mixMode='off';scene.step(scene.active.config.recipe,1);const siphonApart=await scene.snapshot();
      await scene.restore(siphonInitial);scene.mixMode='siphon';scene.interaction=1;scene.step(scene.active.config.recipe,1);const siphon=await scene.snapshot();
      assert(siphon.objects[0].field[center]>siphonApart.objects[0].field[center]+.05 && siphon.objects[1].field[center]<siphonApart.objects[1].field[center]-.05,'Siphon did not fill the selected object and drain its neighbor.');
      await scene.restore(initial);scene.objects.forEach(object=>object.engine.seed(filled(.7)));const carveInitial=await scene.snapshot();
      scene.mixMode='off';scene.step(scene.active.config.recipe,1);const carveApart=await scene.snapshot();
      await scene.restore(carveInitial);scene.mixMode='carve';scene.interaction=1;scene.step(scene.active.config.recipe,1);const carved=await scene.snapshot();
      assert(carved.objects[0].field[center]<carveApart.objects[0].field[center]-.1,'Carve did not erode the overlap.');
      scene.setCut(.4);scene.cutScope='all';const saved=await scene.snapshot();scene.setCut(1);scene.mixMode='off';await scene.restore(saved);
      assert(scene.sceneCut===.4&&String(scene.mixMode)==='carve'&&scene.cutScope==='all','Scene interaction and shared-cut settings were lost.');
      const rect=canvas.getBoundingClientRect();scene.beginObjectDrag(1,rect.left+100,rect.top+40,1);const before=[...scene.position];scene.moveDrag(rect.left+120,rect.top+40,1);scene.endDrag();assert(scene.position.some((value,i)=>Math.abs(value-before[i])>.01),'Object-label dragging failed.');
      scene.beginObjectDrag(1,rect.left+100,rect.top+40,1,true);const depth=[...scene.position];scene.moveDrag(rect.left+100,rect.top+60,1);scene.endDrag();assert(Math.abs(scene.position[2]-depth[2])>.05,'Shift-drag did not move the object in depth.');
      results.push({backend,apartPixels:apart,fusedPixels:fused,cutPixels:clipped,crossbreed:true,siphon:true,carve:true,sharedCut:true,labelDrag:true,depthDrag:true});
    }finally{scene?.destroy();canvas.remove();}
  }
  return results;
}
