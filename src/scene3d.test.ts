import { describe,expect,it } from 'vitest';
import { defaultObject,parseSceneRecipe } from './scene3d';
describe('scene recipes',()=>{
  it('round-trips all three independent objects and their positions',()=>{
    const scene={selected:2,interaction:.6,objects:[defaultObject(0),defaultObject(1),defaultObject(2)]};
    scene.objects[1].recipe.feed=.03;scene.objects[2].position=[-2,1,.5];
    expect(parseSceneRecipe(JSON.stringify(scene))).toEqual(scene);
  });
  it('rejects excessive counts, invalid transforms and malformed recipes',()=>{
    expect(parseSceneRecipe({selected:0,interaction:.5,objects:Array.from({length:4},(_,i)=>defaultObject(i))})).toBeUndefined();
    const object=defaultObject();object.position[0]=Infinity;expect(parseSceneRecipe({selected:0,interaction:.5,objects:[object]})).toBeUndefined();
    expect(parseSceneRecipe('{broken')).toBeUndefined();
    expect(parseSceneRecipe({selected:1,interaction:.5,objects:[defaultObject()]})).toBeUndefined();
  });
});
