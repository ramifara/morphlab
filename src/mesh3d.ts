import { voxelIndex, type VolumeShape } from './volume';
export interface Mesh { vertices: Float32Array; triangles: Uint32Array }
export interface MeshOptions { size:number; samples:number; threshold:number; shape:VolumeShape; cut?:number; scalar?:(x:number,y:number,z:number)=>number }
const corners=[[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
const tetrahedra=[[0,5,1,6],[0,1,2,6],[0,2,3,6],[0,3,7,6],[0,7,4,6],[0,4,5,6]];
/** Marching tetrahedra over a padded scalar grid. The vessel boundary closes the solid. */
export function volumeMesh(field:Float32Array,options:MeshOptions,progress:(fraction:number)=>void=()=>{}):Mesh {
  const {size:n,samples:m,threshold,shape}=options;
  if(!Number.isInteger(n)||n<8||n%8!==0||!Number.isInteger(m)||m<2||m>256||field.length!==n**3*2||!Number.isFinite(threshold))throw new Error('Invalid mesh dimensions.');
  const side=m+2,values=new Float32Array(side**3),vertices:number[]=[],triangles:number[]=[],edges=new Map<string,number>();
  const position=(x:number)=> (x-.5)/m*2-1;
  const sample=(x:number,y:number,z:number)=>{
    if(options.scalar)return options.scalar(x,y,z);
    const q=[x,y,z].map(v=>(v+1)*n*.5-.5),lo=q.map(v=>Math.floor(v)),f=q.map((v,i)=>v-lo[i]);
    let b=0;
    for(let dz=0;dz<2;dz++)for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++) {
      const clamp=(v:number)=>Math.max(0,Math.min(n-1,v));
      b+=field[voxelIndex(clamp(lo[0]+dx),clamp(lo[1]+dy),clamp(lo[2]+dz),n)+1]*(dx?f[0]:1-f[0])*(dy?f[1]:1-f[1])*(dz?f[2]:1-f[2]);
    }
    return Math.min(b-threshold,1-Math.max(Math.abs(x),Math.abs(y),Math.abs(z)),shape==='sphere'?.98-Math.hypot(x,y,z):Infinity,(options.cut??1)-z);
  };
  for(let z=0;z<side;z++)for(let y=0;y<side;y++)for(let x=0;x<side;x++)values[(z*side+y)*side+x]=sample(position(x),position(y),position(z));
  const edge=(a:number,b:number,pa:number[],pb:number[])=>{
    const key=a<b?`${a}:${b}`:`${b}:${a}`;const existing=edges.get(key);if(existing!==undefined)return existing;
    const t=values[a]/(values[a]-values[b]),index=vertices.length/3;
    vertices.push(...pa.map((v,i)=>v+(pb[i]-v)*t));edges.set(key,index);return index;
  };
  const triangle=(a:number,b:number,c:number,outward:number[])=>{
    const p=(i:number)=>vertices.slice(i*3,i*3+3),pa=p(a),pb=p(b),pc=p(c);
    const u=pb.map((v,i)=>v-pa[i]),v=pc.map((v,i)=>v-pa[i]);
    const normal=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    if(Math.hypot(...normal)<1e-12)return;
    if(normal.reduce((sum,v,i)=>sum+v*outward[i],0)<0)[b,c]=[c,b];
    triangles.push(a,b,c);
    if(triangles.length>4500000)throw new Error('This mesh exceeds 1.5 million triangles. Choose a lower mesh resolution.');
  };
  for(let z=0;z<side-1;z++) {
    for(let y=0;y<side-1;y++)for(let x=0;x<side-1;x++) {
      const ids=corners.map(c=>((z+c[2])*side+y+c[1])*side+x+c[0]);
      if(ids.every(i=>values[i]<=0)||ids.every(i=>values[i]>0))continue;
      const points=corners.map(c=>[position(x+c[0]),position(y+c[1]),position(z+c[2])]);
      for(const tet of tetrahedra) {
        const inside=tet.filter(i=>values[ids[i]]>0),outside=tet.filter(i=>values[ids[i]]<=0);if(!inside.length||!outside.length)continue;
        const mean=(set:number[])=>[0,1,2].map(axis=>set.reduce((sum,i)=>sum+points[i][axis],0)/set.length);
        const inCenter=mean(inside),outward=mean(outside).map((v,i)=>v-inCenter[i]);
        const cross=(i:number,o:number)=>edge(ids[i],ids[o],points[i],points[o]);
        if(inside.length===1)triangle(cross(inside[0],outside[0]),cross(inside[0],outside[1]),cross(inside[0],outside[2]),outward);
        else if(outside.length===1)triangle(cross(inside[0],outside[0]),cross(inside[1],outside[0]),cross(inside[2],outside[0]),outward);
        else {
          const a=cross(inside[0],outside[0]),b=cross(inside[0],outside[1]),c=cross(inside[1],outside[1]),d=cross(inside[1],outside[0]);
          triangle(a,b,c,outward);triangle(a,c,d,outward);
        }
      }
    }
    if(z%4===0)progress(z/(side-1));
  }
  progress(1);return {vertices:new Float32Array(vertices),triangles:new Uint32Array(triangles)};
}
export function meshStats(mesh:Mesh) {
  const {vertices:v,triangles:t}=mesh,count=v.length/3,parent=new Int32Array(count),used=new Set<number>(),edges=new Map<number,number>();
  for(let i=0;i<count;i++)parent[i]=i;
  const root=(i:number):number=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
  let signedVolume=0;
  for(let i=0;i<t.length;i+=3) {
    const a=t[i],b=t[i+1],c=t[i+2];parent[root(b)]=root(a);parent[root(c)]=root(a);used.add(a);used.add(b);used.add(c);
    for(const [p,q] of [[a,b],[b,c],[c,a]]){const key=Math.min(p,q)*count+Math.max(p,q);edges.set(key,(edges.get(key)??0)+1);}
    signedVolume+=(v[a*3]*(v[b*3+1]*v[c*3+2]-v[b*3+2]*v[c*3+1])+v[a*3+1]*(v[b*3+2]*v[c*3]-v[b*3]*v[c*3+2])+v[a*3+2]*(v[b*3]*v[c*3+1]-v[b*3+1]*v[c*3]))/6;
  }
  let openEdges=0,nonManifoldEdges=0;for(const n of edges.values()){if(n===1)openEdges++;if(n>2)nonManifoldEdges++;}
  const components=new Set([...used].map(root)).size;
  return {triangles:t.length/3,vertices:used.size,openEdges,nonManifoldEdges,components,signedVolume,closed:t.length>0&&openEdges===0&&nonManifoldEdges===0};
}
/** Put Y-up scene geometry into Z-up millimetres; preserve outward winding. */
export function placeMesh(mesh:Mesh,position:number[],size:number):Mesh {
  const vertices=new Float32Array(mesh.vertices.length),triangles=mesh.triangles.slice();
  for(let i=0;i<vertices.length;i+=3){vertices[i]=mesh.vertices[i]*size+position[0];vertices[i+1]=mesh.vertices[i+2]*size+position[2];vertices[i+2]=mesh.vertices[i+1]*size+position[1];}
  for(let i=0;i<triangles.length;i+=3)[triangles[i+1],triangles[i+2]]=[triangles[i+2],triangles[i+1]];
  return {vertices,triangles};
}
export function scaleMeshes(meshes:Mesh[],millimetres:number) {
  if(!meshes.some(mesh=>mesh.triangles.length))throw new Error('No solid surface at this pattern weight. Grow or paint the field first.');
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  for(const mesh of meshes)for(let i=0;i<mesh.vertices.length;i++) {const axis=i%3;min[axis]=Math.min(min[axis],mesh.vertices[i]);max[axis]=Math.max(max[axis],mesh.vertices[i]);}
  const extent=Math.max(...max.map((v,i)=>v-min[i]));if(!Number.isFinite(extent)||extent<=0)throw new Error('No solid surface at this pattern weight. Grow or paint the field first.');
  const scale=millimetres/extent;
  for(const mesh of meshes)for(let i=0;i<mesh.vertices.length;i++){const axis=i%3;mesh.vertices[i]=(mesh.vertices[i]-(axis===2?min[2]:(min[axis]+max[axis])/2))*scale;}
  return max.map((v,i)=>(v-min[i])*scale);
}
export function binarySTL(meshes:Mesh[]):ArrayBuffer {
  const count=meshes.reduce((n,m)=>n+m.triangles.length/3,0),buffer=new ArrayBuffer(84+count*50),view=new DataView(buffer);
  new Uint8Array(buffer,0,80).set(new TextEncoder().encode('Morph Lab | millimetres | Z up'));view.setUint32(80,count,true);let offset=84;
  for(const mesh of meshes)for(let i=0;i<mesh.triangles.length;i+=3) {
    const p=[0,1,2].map(j=>Array.from(mesh.vertices.subarray(mesh.triangles[i+j]*3,mesh.triangles[i+j]*3+3)));
    const a=p[1].map((v,j)=>v-p[0][j]),b=p[2].map((v,j)=>v-p[0][j]);
    const normal=[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],length=Math.hypot(...normal)||1;
    const values=[...normal.map(v=>v/length),...p.flat()];values.forEach((v,j)=>view.setFloat32(offset+j*4,v,true));offset+=50;
  }
  return buffer;
}
export function objectOBJ(meshes:Mesh[]):string {
  const lines=['# Morph Lab | millimetres | Z up'];let offset=1;
  meshes.forEach((mesh,index)=>{lines.push(`o Morph_${index+1}`);for(let i=0;i<mesh.vertices.length;i+=3)lines.push(`v ${mesh.vertices[i]} ${mesh.vertices[i+1]} ${mesh.vertices[i+2]}`);for(let i=0;i<mesh.triangles.length;i+=3)lines.push(`f ${mesh.triangles[i]+offset} ${mesh.triangles[i+1]+offset} ${mesh.triangles[i+2]+offset}`);offset+=mesh.vertices.length/3;});return lines.join('\n');
}
