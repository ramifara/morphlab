/// <reference lib="webworker" />
import { fusedSceneMesh,sceneFuses } from './scene-density';
import type { MixMode } from './link';
import { binarySTL, meshStats, objectOBJ, placeMesh, scaleMeshes, volumeMesh } from './mesh3d';
import type { VolumeObjectConfig } from './scene3d';
const worker=self as unknown as DedicatedWorkerGlobalScope;
worker.onmessage = (event:MessageEvent<{objects:{field:Float32Array;config:VolumeObjectConfig}[];size:number;samples:number;millimetres:number;format:'stl'|'obj';cutaway:boolean;mode?:MixMode;strength?:number;merge?:boolean}>) => {
  try {
    const {size,samples,millimetres,format,cutaway}=event.data;
    const objects=event.data.objects.map(object=>({...object,config:{...object.config,cut:cutaway?object.config.cut:1}}));
    const merged=!!event.data.merge&&sceneFuses(event.data.mode??'off',event.data.strength??0,objects.length);
    const meshes=merged?[fusedSceneMesh(objects,size,samples,event.data.strength??0,fraction=>worker.postMessage({kind:'progress',fraction}))]:objects.map((object,index)=>placeMesh(volumeMesh(object.field,{size,samples,threshold:object.config.threshold,shape:object.config.shape,cut:cutaway?object.config.cut:1},fraction=>worker.postMessage({kind:'progress',fraction:(index+fraction)/objects.length})),object.config.position,object.config.size)).filter(mesh=>mesh.triangles.length>0);
    const dimensions=scaleMeshes(meshes,millimetres),stats=meshes.map(meshStats);
    const data=format==='stl'?binarySTL(meshes):objectOBJ(meshes);
    worker.postMessage({kind:'complete',data,dimensions,stats,merged},typeof data==='string'?[]:[data]);
  } catch(error) {worker.postMessage({kind:'error',message:error instanceof Error?error.message:String(error)});}
};
