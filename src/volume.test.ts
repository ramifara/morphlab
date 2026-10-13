import { describe, expect, it } from 'vitest';
import { defaultStart } from './model';
import { insideVolume, makeVolumeSeed, voxelIndex, volumeGridSize, parseVolumeResolution, resizeVolume } from './volume';

describe('3D field layout and seeding', () => {
  it('addresses every voxel once, including transitions between atlas rows', () => {
    const indices = new Set<number>();
    for (let z=0;z<64;z++) for (let y=0;y<64;y++) for (let x=0;x<64;x++) indices.add(voxelIndex(x,y,z,64));
    expect(indices.size).toBe(64**3);
    expect(voxelIndex(0,0,8,64)).toBe(512*64*2);
    expect(voxelIndex(63,63,63,64)).toBe(512*512*2-2);
  });
  it('reproduces a seed and distributes deposits in depth', () => {
    const settings = defaultStart();
    const field = makeVolumeSeed(512,42,settings,'sphere');
    const same = makeVolumeSeed(512,42,settings,'sphere'), different = makeVolumeSeed(512,43,settings,'sphere');
    expect(field.every((v,i)=>v===same[i])).toBe(true);
    expect(field.some((v,i)=>v!==different[i])).toBe(true);
    const slices = new Set<number>(); let outside = 0;
    for (let z=0;z<64;z++) for (let y=0;y<64;y++) for (let x=0;x<64;x++) {
      if(field[voxelIndex(x,y,z,64)+1]>0) { if (!insideVolume(x,y,z,64,'sphere')) outside++; slices.add(z); }
    }
    expect(outside).toBe(0);
    expect(slices.size).toBeGreaterThan(50);
  });
  it('makes a localized 3D spot and a truly empty field', () => {
    const spot = makeVolumeSeed(512,42,defaultStart('spot'),'box');
    expect(spot[voxelIndex(32,32,32,64)+1]).toBeGreaterThan(0);
    expect(spot[voxelIndex(32,32,34,64)+1]).toBeGreaterThan(0);
    expect(spot[voxelIndex(32,32,40,64)+1]).toBe(0);
    const empty = makeVolumeSeed(512,42,defaultStart('empty'),'sphere');
    expect(empty.every((v,i)=>v===(i%2 ? 0 : 1))).toBe(true);
  });
});

describe('larger volumes', () => {
  it.each([1,2,3,4])('allocates the complete XYZ atlas at resolution %i', r => {
    const {width,height} = volumeGridSize(r), n = 64*r;
    expect(width*height).toBe(n**3);
    expect(voxelIndex(n-1,n-1,n-1,n)).toBe(width*height*2-2);
    expect(parseVolumeResolution(r)).toBe(r);
  });
  it('places high-resolution seeds beyond slice 64', () => {
    const field = makeVolumeSeed(1024,42,defaultStart('spot'),'box');
    expect(field.length).toBe(128**3*2);
    expect(field[voxelIndex(64,64,68,128)+1]).toBeGreaterThan(0);
    expect(field[voxelIndex(64,64,80,128)+1]).toBe(0);
  });
  it('interpolates all axes independently across atlas rows', () => {
    const n = 16, next = 32, field = new Float32Array(n**3*2);
    for (let z=0;z<n;z++) for (let y=0;y<n;y++) for (let x=0;x<n;x++) {
      const i=voxelIndex(x,y,z,n); field[i]=(x+2*y+3*z)/100; field[i+1]=z/20;
    }
    const grown=resizeVolume(field,n,next);
    for (const [x,y,z] of [[3,6,15],[22,17,16],[13,9,20]]) {
      const sx=(x+.5)*n/next-.5, sy=(y+.5)*n/next-.5, sz=(z+.5)*n/next-.5;
      expect(grown[voxelIndex(x,y,z,next)]).toBeCloseTo((sx+2*sy+3*sz)/100,6);
      expect(grown[voxelIndex(x,y,z,next)+1]).toBeCloseTo(sz/20,6);
    }
    expect(grown[0]).toBe(field[0]);
    expect(grown[grown.length-1]).toBe(field[field.length-1]);
    const restored=resizeVolume(grown,next,n);
    expect(restored[voxelIndex(8,8,8,n)]).toBeCloseTo(field[voxelIndex(8,8,8,n)],6);
  });
  it('rejects incompatible fields and defaults unsupported resolutions', () => {
    expect(()=>resizeVolume(new Float32Array(10),16,32)).toThrow();
    expect(parseVolumeResolution(8)).toBe(1);
    expect(parseVolumeResolution('invalid')).toBe(1);
  });
});
