import type { MixMode } from './link';
import type { VolumeObjectConfig } from './scene3d';
import { voxelIndex } from './volume';
import { placeMesh,volumeMesh,type Mesh } from './mesh3d';
export const fusionDensity=(values:number[],strength:number)=>{
  const maximum=Math.max(0,...values),sum=values.reduce((total,value)=>total+value,0);
  return maximum+(sum-maximum)*strength;
};
export function objectDensity(field:Float32Array,size:number,config:VolumeObjectConfig,world:number[]) {
  const local=world.map((value,i)=>(value-config.position[i])/config.size);
  if(local.some(value=>Math.abs(value)>1)||local[2]>config.cut||(config.shape==='sphere'&&Math.hypot(...local)>=.98))return 0;
  const q=local.map(value=>(value+1)*size*.5-.5),i=q.map(Math.floor),f=q.map((value,axis)=>value-i[axis]);
  const clamp=(value:number)=>Math.max(0,Math.min(size-1,value));let b=0;
  for(let z=0;z<2;z++)for(let y=0;y<2;y++)for(let x=0;x<2;x++)b+=field[voxelIndex(clamp(i[0]+x),clamp(i[1]+y),clamp(i[2]+z),size)+1]*(x?f[0]:1-f[0])*(y?f[1]:1-f[1])*(z?f[2]:1-f[2]);
  return b/config.threshold;
}
export function fusedSceneMesh(objects:{config:VolumeObjectConfig;field:Float32Array}[],size:number,samples:number,strength:number,progress:(fraction:number)=>void=()=>{}):Mesh {
  const lower=[0,1,2].map(axis=>Math.min(...objects.map(object=>object.config.position[axis]-object.config.size)));
  const upper=[0,1,2].map(axis=>Math.max(...objects.map(object=>object.config.position[axis]+object.config.size)));
  const center=lower.map((value,i)=>(value+upper[i])*.5),half=lower.map((value,i)=>(upper[i]-value)*.5);
  const mesh=volumeMesh(objects[0].field,{size,samples,threshold:1,shape:'box',scalar:(x,y,z)=>{
    const world=[x,y,z].map((value,i)=>center[i]+value*half[i]);return fusionDensity(objects.map(object=>objectDensity(object.field,size,object.config,world)),strength)-1;
  }},progress);
  for(let i=0;i<mesh.vertices.length;i++)mesh.vertices[i]=center[i%3]+mesh.vertices[i]*half[i%3];
  return placeMesh(mesh,[0,0,0],1);
}
export function sceneFuses(mode:MixMode,strength:number,count:number){return count>1&&strength>0&&(mode==='melt'||mode==='cross');}
