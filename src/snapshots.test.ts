import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { loadSnapshot, removeSnapshot, saveSnapshot, type MorphSnapshot } from './snapshots';

const snapshot = (): MorphSnapshot => ({
  version: 1, width: 2, height: 2,
  field: new Float32Array([1, 0, .51234567, .25123456, .7, .12, .43, .32]),
  iterations: 4321, zoom: 1.75, pan: { x: 12, y: -34 },
});

describe('saved morph fields', () => {
  beforeEach(() => { globalThis.indexedDB = new IDBFactory(); });

  it('round-trips both chemical channels without losing float precision or view state', async () => {
    const original = snapshot();
    const id = await saveSnapshot(original);
    // Subsequent simulation changes must not change the saved field.
    original.field.fill(0);
    const loaded = await loadSnapshot(id, 2, 2);
    expect(loaded).toEqual(snapshot());
    expect(new Uint8Array(loaded.field.buffer)).toEqual(new Uint8Array(snapshot().field.buffer));
  });

  it('keeps different versions with identical recipes independent and deletes only the chosen field', async () => {
    const first = await saveSnapshot(snapshot());
    const changed = snapshot(); changed.field[3] = .42;
    const second = await saveSnapshot(changed);
    await removeSnapshot(first);
    await expect(loadSnapshot(first, 2, 2)).rejects.toThrow('missing or incompatible');
    expect(await loadSnapshot(second, 2, 2)).toEqual(changed);
  });

  it('rejects missing fields, incompatible dimensions, and corrupt data', async () => {
    await expect(loadSnapshot('missing', 2, 2)).rejects.toThrow();
    const id = await saveSnapshot(snapshot());
    await expect(loadSnapshot(id, 4, 1)).rejects.toThrow();
    const corrupt = snapshot(); corrupt.field[0] = NaN;
    await expect(loadSnapshot(await saveSnapshot(corrupt), 2, 2)).rejects.toThrow();
  });

  it('reports unavailable storage instead of producing a snapshot reference', async () => {
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, writable: true, value: undefined });
    await expect(saveSnapshot(snapshot())).rejects.toThrow();
  });
});

describe('saved 3D scenes',()=>{
  beforeEach(()=>{globalThis.indexedDB=new IDBFactory();});
  it('keeps every object field and transform and rejects corrupt scene fields',async()=>{
    const {defaultObject}=await import('./scene3d');
    const n=64,width=n*8,height=n*n/8,field=new Float32Array(n**3*2);
    const scene={selected:1,interaction:.7,objects:[{config:defaultObject(0),field:field.slice()},{config:defaultObject(1),field:field.slice()}]};
    scene.objects[1].config.position=[1,.2,-1];scene.objects[1].field[37]=.63;
    const save={version:1 as const,width,height,field:scene.objects[1].field,scene,iterations:23,zoom:1,pan:{x:0,y:0}};
    const id=await saveSnapshot(save);const restored=await loadSnapshot(id,width,height);
    expect(restored.scene?.objects[1].field[37]).toBeCloseTo(.63,6);expect(restored.scene?.objects[1].config.position).toEqual([1,.2,-1]);
    scene.objects[0].field=new Float32Array(2);
    const bad=await saveSnapshot(save);await expect(loadSnapshot(bad,width,height)).rejects.toThrow('incompatible');
  });
});
