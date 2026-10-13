import { describe,expect,it } from 'vitest';
import { VolumeEngine } from './engine3d';
import { defaultObject,objectsOverlap } from './scene3d';
import { fusionDensity,fusedSceneMesh,objectDensity } from './scene-density';
import { meshStats } from './mesh3d';
class PickProbe extends VolumeEngine {
  readonly backend='WebGL 2' as const;
  seed(){}step(){}render(){}async read(){return new Float32Array();}destroy(){}
  get point(){return this.paintPoint;}
}
const canvas={getBoundingClientRect:()=>({left:0,top:0,width:200,height:200})} as unknown as HTMLCanvasElement;
function filled(n:number,b:number){const field=new Float32Array(n**3*2);for(let i=0;i<field.length;i+=2){field[i]=.5;field[i+1]=b;}return field;}
describe('interactive 3D mixing',()=>{
  it('picks a vessel and its exposed cut without sampling through the volume',()=>{
    const engine=new PickProbe(canvas,64);engine.orbit={x:0,y:0};expect(engine.pick(100,100,1)).toBe(true);expect(engine.pickDistance).toBeCloseTo(4.2-.98,5);
    engine.cut=0;expect(engine.pick(100,100,1)).toBe(true);expect(engine.point![2]).toBeLessThan(0);expect(engine.pickDistance).toBeCloseTo(4.2,5);
    engine.cut=-1;expect(engine.pick(100,100,1)).toBe(false);engine.cut=1;expect(engine.pick(0,0,1)).toBe(false);
  });
  it('accounts for world positions and object sizes in picking',()=>{
    const engine=new PickProbe(canvas,64);engine.orbit={x:0,y:0};engine.objectSize=2;engine.sceneDistance=8;
    expect(engine.pick(100,100,1)).toBe(true);expect(engine.pickDistance).toBeCloseTo(8-.98*2,5);
    engine.position=[4,0,0];expect(engine.pick(100,100,1)).toBe(false);
  });
  it('detects sphere/box overlap and ignores separated vessels',()=>{
    const a=defaultObject(),b=defaultObject(1);expect(objectsOverlap(a,b)).toBe(true);b.position=[4,0,0];expect(objectsOverlap(a,b)).toBe(false);
    a.shape='box';b.position=[1.5,0,0];expect(objectsOverlap(a,b)).toBe(true);
  });
  it('fuses concentrations below the individual surface threshold into a real mesh',()=>{
    expect(fusionDensity([.65,.65],.85)).toBeGreaterThan(1);
    const a=defaultObject(),b=defaultObject(1);b.shape='sphere';b.position=[.8,0,0];const objects=[{config:a,field:filled(16,.12)},{config:b,field:filled(16,.12)}];
    expect(objectDensity(objects[0].field,16,a,[0,0,0])).toBeLessThan(1);
    expect(fusionDensity(objects.map(object=>objectDensity(object.field,16,object.config,[.4,0,0])),.85)).toBeGreaterThan(1);
    const mesh=fusedSceneMesh(objects,16,24,.85);const stats=meshStats(mesh);expect(stats.triangles).toBeGreaterThan(0);expect(stats.closed).toBe(true);expect(stats.components).toBe(1);
    b.position=[4,0,0];expect(fusedSceneMesh(objects,16,24,.85).triangles.length).toBe(0);
  });
});
