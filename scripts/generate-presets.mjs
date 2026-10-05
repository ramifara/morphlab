// Offline specimen thumbnails. The interactive canvas always simulates on the GPU.
import { contours } from 'd3-contour';
import { writeFileSync } from 'node:fs';
// name, feed, kill, and optionally the contour threshold and colors that specimen carries.
const recipes = [['coral',.0545,.062],['fingerprint',.037,.060],['mitosis',.0367,.0649],['spots',.03,.062],['worms',.062,.0609],['bloom',.025,.055],['pulse',.0329,.0556,.19,'#29191a','#ff936d']];
const w = 112, h = 64;
for (const [name,feed,kill,threshold=.19,bg='#20221d',fg='#d6dbbe'] of recipes) {
  let a = new Float32Array(w*h).fill(1), b = new Float32Array(w*h), na = a.slice(), nb = b.slice();
  let state = 42;
  const rand = () => { state = (Math.imul(state,1664525)+1013904223)>>>0; return state/4294967296; };
  for (let j = 0; j < 45; j++) {
    const cx = rand()*w, cy = rand()*h, r = 2+rand()*3;
    for (let y = Math.floor(cy-r); y < cy+r; y++) for (let x = Math.floor(cx-r); x < cx+r; x++) {
      if ((x-cx)**2+(y-cy)**2>r*r) continue;
      const i = ((y+h)%h)*w+(x+w)%w; a[i]=.5; b[i]=.25;
    }
  }
  const neighbors = Array.from({length:w*h},(_,i)=>{
    const x = i%w,y = Math.floor(i/w);
    return [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]].map(([dx,dy])=>((y+dy+h)%h)*w+(x+dx+w)%w);
  });
  for (let t = 0; t < 1800; t++) {
    for (let i = 0; i < w*h; i++) {
      let la = -a[i], lb = -b[i];
      for (let j = 0; j < 8; j++) { const n = neighbors[i][j], weight = j<4?.2:.05; la+=a[n]*weight; lb+=b[n]*weight; }
      const reaction = a[i]*b[i]*b[i];
      na[i] = Math.max(0,Math.min(1,a[i]+la-reaction+feed*(1-a[i])));
      nb[i] = Math.max(0,Math.min(1,b[i]+.5*lb+reaction-(feed+kill)*b[i]));
    }
    [a,na] = [na,a]; [b,nb] = [nb,b];
  }
  const geometry = contours().size([w,h]).thresholds([threshold])(b)[0];
  const d = geometry.coordinates.map(p=>p.map(r=>r.map(([x,y],i)=>`${i?'L':'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('')+'Z').join('')).join('');
  writeFileSync(`public/presets/${name}.svg`,`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="${bg}"/><path d="${d}" fill="${fg}" fill-rule="evenodd"/></svg>`);
}
