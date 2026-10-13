import { SceneVolumeEngine,defaultObject } from '../src/scene3d';
import { voxelIndex } from '../src/volume';
function assert(value:boolean,message:string){if(!value)throw new Error(message);}
export async function checkScenes() {
  const results=[];
  for(const backend of ['webgpu','webgl']) {
    const canvas=document.createElement('canvas');canvas.width=160;canvas.height=100;canvas.style.cssText='position:fixed;left:-200px;top:0;width:160px;height:100px;';document.body.append(canvas);
    let scene:SceneVolumeEngine|undefined;
    try {
      scene=await SceneVolumeEngine.create(canvas,64,backend,defaultObject(),()=>{});await scene.add('box');await scene.add('sphere');
      let rejected=false;try{await scene.add('box');}catch{rejected=true;}assert(rejected,'A fourth object was accepted.');
      const seed=(b:number)=>{const f=new Float32Array(64**3*2);for(let i=0;i<f.length;i+=2){f[i]=.5;f[i+1]=b;}return f;};
      scene.objects[0].engine.seed(seed(.1));scene.objects[1].engine.seed(seed(.8));scene.objects[2].engine.seed(seed(.4));
      scene.objects[0].config.position=[0,0,0];scene.objects[1].config.position=[0,0,0];scene.objects[2].config.position=[4,0,0];scene.selected=0;scene.loadActive();
      const initial=await scene.snapshot();scene.interaction=0;scene.step(scene.active.config.recipe,1);const isolated=await scene.snapshot();
      await scene.restore(initial);scene.interaction=1;scene.step(scene.active.config.recipe,1);const mixed=await scene.snapshot();const center=voxelIndex(32,32,32,64)+1;
      const exchange=mixed.objects[0].field[center]-isolated.objects[0].field[center];assert(exchange>.01,'Overlapping objects did not exchange chemicals.');
      assert(mixed.objects[2].field[center]===isolated.objects[2].field[center],'A distant object received chemicals.');
      scene.render(scene.active.config.palette,.19,1,{x:0,y:0});
      await scene.remove();assert(scene.objects.length===2,'Removal failed.');scene.render(scene.active.config.palette,.19,1,{x:0,y:0});
      const before=await scene.snapshot();await scene.restore(before);const after=await scene.snapshot();
      assert(before.objects.every((object,i)=>object.field.every((v,j)=>v===after.objects[i].field[j])),'Scene restore changed the fields.');
      const rect=canvas.getBoundingClientRect();assert(scene.beginDrag(rect.left+80,rect.top+50,1),'Move tool did not pick a vessel.');
      const position=[...scene.position];scene.moveDrag(rect.left+100,rect.top+50,1);scene.endDrag();assert(scene.position.some((v,i)=>Math.abs(v-position[i])>.01),'Dragging did not move the object.');
      results.push({backend,objects:3,capEnforced:true,exchange,separated:true,restore:true,drag:true});
    }finally{scene?.destroy();canvas.remove();}
  }
  return results;
}
