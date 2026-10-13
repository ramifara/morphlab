/** Scene density is sampled in world space so overlap is one surface, not stacked vessels. */
export const glSceneField = `
uniform sampler2D foreign1,foreign2;
uniform vec4 peerTransform[2],peerColors[2],peerBackgrounds[2],peerInfo,sceneMix;
bool fused() { return peerInfo.w>0. && peerInfo.z>0. && sceneMix.x<1.5; }
float sampleRaw(sampler2D source,vec3 p,bool smoothSample) {
 vec3 q=(p+1.)*(float(size)*.5)-.5;ivec3 i=ivec3(floor(q));vec3 f=fract(q);
 ivec3 a=clamp(ivec3(floor(q+.5)),ivec3(0),ivec3(size-1));
 if(!smoothSample)return texelFetch(source,ivec2((a.z%8)*size+a.x,(a.z/8)*size+a.y),0).y;
 float resultValue=0.;
 for(int z=0;z<2;z++)for(int y=0;y<2;y++)for(int x=0;x<2;x++) {
  a=clamp(i+ivec3(x,y,z),ivec3(0),ivec3(size-1));
  resultValue+=texelFetch(source,ivec2((a.z%8)*size+a.x,(a.z/8)*size+a.y),0).y*(x==1?f.x:1.-f.x)*(y==1?f.y:1.-f.y)*(z==1?f.z:1.-f.z);
 }
 return resultValue;
}
bool peerInside(vec3 p,int i) { return all(lessThanEqual(abs(p),vec3(1.))) && (peerInfo[i]==1. || length(p)<.98) && p.z<sceneMix[i+1]; }
vec3 concentrations(vec3 p,bool smoothSample) {
 vec3 values=vec3(0.);if(inside(p)&&p.z<cut)values.x=sampleRaw(cells,p,smoothSample)/threshold;
 vec3 world=p*objectSize+placement.xyz;
 for(int i=0;i<2;i++) {
  if(float(i)>=peerInfo.w)break;
  vec3 local=(world-peerTransform[i].xyz)/peerTransform[i].w;
  if(peerInside(local,i))values[i+1]=(i==0?sampleRaw(foreign1,local,smoothSample):sampleRaw(foreign2,local,smoothSample))/peerColors[i].w;
 }
 return values;
}
float density(vec3 p,bool smoothSample) {
 if(!fused())return inside(p)&&p.z<cut?sampleRaw(cells,p,smoothSample):0.;
 vec3 c=concentrations(p,smoothSample);return mix(max(max(c.x,c.y),c.z),c.x+c.y+c.z,peerInfo.z)*threshold;
}
float field(vec3 p) { return density(p,true); }
void materialColors(vec3 p,out vec3 background,out vec3 foreground) {
 background=bg;foreground=fg;
 if(peerInfo.w==0. || peerInfo.z==0. || sceneMix.x>3.5)return;
 vec3 c=concentrations(p,true);if(!fused()){c.yz*=peerInfo.z*.4;}
 float sum=c.x+c.y+c.z;if(sum<.00001)return;
 background=(bg*c.x+peerBackgrounds[0].xyz*c.y+peerBackgrounds[1].xyz*c.z)/sum;
 foreground=(fg*c.x+peerColors[0].xyz*c.y+peerColors[1].xyz*c.z)/sum;
}
void bounds(out vec3 lower,out vec3 upper) {
 lower=vec3(-1.);upper=vec3(1.);if(!fused())return;
 for(int i=0;i<2;i++){if(float(i)>=peerInfo.w)break;vec3 c=(peerTransform[i].xyz-placement.xyz)/objectSize;vec3 r=vec3(peerTransform[i].w/objectSize);lower=min(lower,c-r);upper=max(upper,c+r);}
}
float vesselDistance(vec3 p,float shapeValue) {return shapeValue==0.?length(p)-.98:length(max(abs(p)-1.,0.));}
float marchStride(vec3 p) {
 if(!fused())return 1.15/float(size);
 vec3 world=p*objectSize+placement.xyz;float nearDistance=max(0.,vesselDistance(p,float(shape)))*objectSize;
 float cell=inside(p)?objectSize:1000.;
 for(int i=0;i<2;i++) {
  if(float(i)>=peerInfo.w)break;vec3 local=(world-peerTransform[i].xyz)/peerTransform[i].w;
  nearDistance=min(nearDistance,max(0.,vesselDistance(local,peerInfo[i]))*peerTransform[i].w);
  if(all(lessThanEqual(abs(local),vec3(1.)))&&(peerInfo[i]==1.||length(local)<.98))cell=min(cell,peerTransform[i].w);
 }
 if(cell>999.)cell=min(objectSize,min(peerTransform[0].w,peerInfo.w>1.?peerTransform[1].w:objectSize));
 return max(cell*1.15/float(size),nearDistance*.8)/objectSize;
}
`;

export const gpuSceneField = `
fn fused() -> bool {return display.peerInfo.w>0. && display.peerInfo.z>0. && display.mixing.x<1.5;}
fn sourceAt(p:vec3i,which:u32) -> f32 {
 let index=address(p,i32(display.volume.x));if(which==0u){return cells[index].y;}if(which==1u){return foreign1[index].y;}return foreign2[index].y;
}
fn sampleRaw(p:vec3f,which:u32,smoothSample:bool) -> f32 {
 let q=(p+1.)*(display.volume.x*.5)-.5;let i=vec3i(floor(q));let f=fract(q);
 if(!smoothSample){return sourceAt(vec3i(floor(q+.5)),which);}
 var value=0.;
 for(var z=0;z<2;z++){for(var y=0;y<2;y++){for(var x=0;x<2;x++){
  value+=sourceAt(i+vec3i(x,y,z),which)*select(1.-f.x,f.x,x==1)*select(1.-f.y,f.y,y==1)*select(1.-f.z,f.z,z==1);
 }}}
 return value;
}
fn peerTransform(i:u32) -> vec4f {if(i==0u){return display.peer1;}return display.peer2;}
fn peerColor(i:u32) -> vec4f {if(i==0u){return display.color1;}return display.color2;}
fn peerInside(p:vec3f,i:u32) -> bool {return inside(p,display.peerInfo[i])&&p.z<display.mixing[i+1u];}
fn concentrations(p:vec3f,smoothSample:bool) -> vec3f {
 var values=vec3f(0.);if(inside(p,display.volume.y)&&p.z<display.camera.w){values.x=sampleRaw(p,0u,smoothSample)/display.background.w;}
 let world=p*display.volume.z+display.placement.xyz;
 for(var i=0u;i<2u;i++) {if(f32(i)>=display.peerInfo.w){break;}let transform=peerTransform(i);let local=(world-transform.xyz)/transform.w;
  if(peerInside(local,i)){values[i+1u]=sampleRaw(local,i+1u,smoothSample)/peerColor(i).w;}
 }
 return values;
}
fn density(p:vec3f,smoothSample:bool) -> f32 {
 if(!fused()){if(inside(p,display.volume.y)&&p.z<display.camera.w){return sampleRaw(p,0u,smoothSample);}return 0.;}
 let c=concentrations(p,smoothSample);return mix(max(max(c.x,c.y),c.z),c.x+c.y+c.z,display.peerInfo.z)*display.background.w;
}
fn field(p:vec3f) -> f32 {return density(p,true);}
struct MaterialColors {background:vec3f,foreground:vec3f}
fn materialColors(p:vec3f) -> MaterialColors {
 if(display.peerInfo.w==0.||display.peerInfo.z==0.||display.mixing.x>3.5){return MaterialColors(display.background.xyz,display.foreground.xyz);}
 var c=concentrations(p,true);if(!fused()){c.y*=display.peerInfo.z*.4;c.z*=display.peerInfo.z*.4;}
 let sum=c.x+c.y+c.z;if(sum<.00001){return MaterialColors(display.background.xyz,display.foreground.xyz);}
 return MaterialColors((display.background.xyz*c.x+display.background1.xyz*c.y+display.background2.xyz*c.z)/sum,
  (display.foreground.xyz*c.x+display.color1.xyz*c.y+display.color2.xyz*c.z)/sum);
}
struct Bounds {lower:vec3f,upper:vec3f}
fn sceneBounds() -> Bounds {
 var lower=vec3f(-1.);var upper=vec3f(1.);if(!fused()){return Bounds(lower,upper);}
 for(var i=0u;i<2u;i++){if(f32(i)>=display.peerInfo.w){break;}let transform=peerTransform(i);let c=(transform.xyz-display.placement.xyz)/display.volume.z;let r=vec3f(transform.w/display.volume.z);lower=min(lower,c-r);upper=max(upper,c+r);}
 return Bounds(lower,upper);
}
fn vesselDistance(p:vec3f,shape:f32) -> f32 {if(shape==0.){return length(p)-.98;}return length(max(abs(p)-1.,vec3f(0.)));}
fn marchStride(p:vec3f) -> f32 {
 if(!fused()){return 1.15/display.volume.x;}
 let world=p*display.volume.z+display.placement.xyz;
 var nearDistance=max(0.,vesselDistance(p,display.volume.y))*display.volume.z;
 var cell=1000.;if(inside(p,display.volume.y)){cell=display.volume.z;}
 for(var i=0u;i<2u;i++){
  if(f32(i)>=display.peerInfo.w){break;}let transform=peerTransform(i);let local=(world-transform.xyz)/transform.w;
  nearDistance=min(nearDistance,max(0.,vesselDistance(local,display.peerInfo[i]))*transform.w);
  if(inside(local,display.peerInfo[i])){cell=min(cell,transform.w);}
 }
 if(cell>999.){cell=min(display.volume.z,display.peer1.w);if(display.peerInfo.w>1.){cell=min(cell,display.peer2.w);}}
 return max(cell*1.15/display.volume.x,nearDistance*.8)/display.volume.z;
}
`;
