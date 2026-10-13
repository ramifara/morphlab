import { SceneVolumeEngine } from '../src/scene3d';
import { makeVolumeSeed } from '../src/volume';
function assert(value:boolean,message:string){if(!value)throw new Error(message);}
/** Run in an isolated 3D preview tab. Exercises input events before blur and real object fields. */
export async function checkObjectSeeding(){
  let scene:SceneVolumeEngine|undefined;
  const original=SceneVolumeEngine.prototype.render;
  SceneVolumeEngine.prototype.render=function(...args){scene=this;return original.apply(this,args);};
  const wait=async(condition:()=>boolean)=>{const since=performance.now();while(!condition()){assert(performance.now()-since<15000,'Scene action timed out.');await new Promise(r=>setTimeout(r,25));}};
  const click=(selector:string)=>document.querySelector<HTMLButtonElement>(selector)!.click();
  const input=(selector:string,value:string,event='input')=>{const element=document.querySelector<HTMLInputElement>(selector)!;element.value=value;element.dispatchEvent(new Event(event,{bubbles:true}));};
  const same=(a:Float32Array,b:Float32Array)=>a.length===b.length&&a.every((value,i)=>value===b[i]);
  try{
    assert(document.querySelector<HTMLElement>('#app-root')!.dataset.dimension==='3d','Start in 3D.');
    click('#scene-fit');await wait(()=>!!scene);
    click('#add-box');await wait(()=>document.querySelectorAll('[data-object]').length===2&&!document.querySelector<HTMLButtonElement>('#add-box')!.disabled);
    input('#start-mode','spot','change');input('#seed-number','222');input('#start-x','.2');input('#start-y','.7');input('#start-radius','9');click('#restart-seed');
    assert(document.querySelector('#play')!.getAttribute('aria-label')==='Play simulation','Restart resumed the scene.');
    const second=await scene!.objects[1].engine.read();
    click('[data-object="0"]');input('#start-mode','ring','change');input('#seed-number','111');input('#start-radius','11');input('#start-x','.6');click('#restart-seed');
    assert(same(second,await scene!.objects[1].engine.read()),'Restarting one object reset or evolved the other.');
    click('[data-object="1"]');assert(document.querySelector<HTMLInputElement>('#seed-number')!.value==='222'&&document.querySelector<HTMLInputElement>('#start-x')!.value==='0.2'&&document.querySelector<HTMLInputElement>('#start-mode')!.value==='spot','Selection forgot the second seed setup.');
    click('[data-object="0"]');assert(document.querySelector<HTMLInputElement>('#seed-number')!.value==='111'&&document.querySelector<HTMLInputElement>('#start-radius')!.value==='11'&&document.querySelector<HTMLInputElement>('#start-mode')!.value==='ring','Selection forgot the first seed setup.');
    click('#restart-scene-seeds');const before=await scene!.snapshot();
    assert(before.objects.every(object=>same(object.field,makeVolumeSeed(scene!.width,object.config.seed,object.config.start,object.config.shape))),'Restart all ignored independent seed settings.');
    await new Promise(r=>setTimeout(r,200));const paused=await scene!.snapshot();assert(before.objects.every((object,i)=>same(object.field,paused.objects[i].field)),'Prepared fields evolved before Play.');
    click('#play');await new Promise(r=>setTimeout(r,200));click('#play');const played=await scene!.snapshot();assert(before.objects.every((object,i)=>!same(object.field,played.objects[i].field)),'Play did not advance every independently seeded object.');
    return {draftsSavedBeforeBlur:true,independentSettings:true,restartIsolated:true,restartAll:true,pausedUntilPlay:true,allObjectsPlay:true};
  }finally{SceneVolumeEngine.prototype.render=original;}
}
