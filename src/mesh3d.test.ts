import { describe, expect, it } from 'vitest';
import { binarySTL, meshStats, objectOBJ, placeMesh, scaleMeshes, volumeMesh } from './mesh3d';
import { voxelIndex } from './volume';
function filled(n:number) { const field=new Float32Array(n**3*2);for(let i=0;i<field.length;i+=2){field[i]=.5;field[i+1]=.5;}return field; }
describe('3D mesh extraction and export',()=>{
  it('closes a sphere with outward normals and a positive enclosed volume',()=>{
    const mesh=volumeMesh(filled(16),{size:16,samples:16,threshold:.19,shape:'sphere'});const stats=meshStats(mesh);
    expect(stats.closed).toBe(true);expect(stats.components).toBe(1);expect(stats.signedVolume).toBeGreaterThan(3.7);expect(stats.signedVolume).toBeLessThan(4.1);
  });
  it('caps the box boundary and exposed cut plane',()=>{
    const mesh=volumeMesh(filled(16),{size:16,samples:16,threshold:.19,shape:'box',cut:0});const stats=meshStats(mesh);
    expect(stats.closed).toBe(true);expect(stats.components).toBe(1);expect(stats.signedVolume).toBeCloseTo(4,1);
    for(let i=2;i<mesh.vertices.length;i+=3)expect(mesh.vertices[i]).toBeLessThanOrEqual(.00001);
  });
  it('extracts separated chemical shells and reports their count',()=>{
    const n=16,field=new Float32Array(n**3*2);for(let z=0;z<n;z++)for(let y=0;y<n;y++)for(let x=0;x<n;x++)if(Math.hypot(x-4,y-8,z-8)<2||Math.hypot(x-12,y-8,z-8)<2)field[voxelIndex(x,y,z,n)+1]=.5;
    const stats=meshStats(volumeMesh(field,{size:n,samples:24,threshold:.19,shape:'box'}));expect(stats.closed).toBe(true);expect(stats.components).toBe(2);
  });
  it('returns no triangles for an empty volume and refuses an empty export',()=>{
    const mesh=volumeMesh(new Float32Array(8**3*2),{size:8,samples:8,threshold:.19,shape:'box'});
    expect(mesh.triangles.length).toBe(0);expect(()=>scaleMeshes([mesh],100)).toThrow('No solid surface');
  });
  it('keeps world placement, Z-up winding and requested millimetre dimensions',()=>{
    const local=volumeMesh(filled(8),{size:8,samples:8,threshold:.19,shape:'box'}),mesh=placeMesh(local,[2,3,4],2);
    const before=meshStats(mesh);expect(before.signedVolume).toBeGreaterThan(0);
    const dimensions=scaleMeshes([mesh],100);expect(Math.max(...dimensions)).toBeCloseTo(100,4);
    let minZ=Infinity;for(let i=2;i<mesh.vertices.length;i+=3)minZ=Math.min(minZ,mesh.vertices[i]);expect(minZ).toBe(0);
    const buffer=binarySTL([mesh]),view=new DataView(buffer);expect(view.getUint32(80,true)).toBe(mesh.triangles.length/3);expect(buffer.byteLength).toBe(84+mesh.triangles.length/3*50);
    const normal=[0,1,2].map(i=>view.getFloat32(84+i*4,true));expect(Math.hypot(...normal)).toBeCloseTo(1,5);
    expect(objectOBJ([mesh,mesh])).toContain('o Morph_2');
  });
});
