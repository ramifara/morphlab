import type { WebGPUVolumeEngine } from '../src/engine3d-webgpu';
/** Direct readback avoids headless Vulkan's missing canvas compositor. */
export function configureCapture(engine:WebGPUVolumeEngine) {
  engine['context'].configure({device:engine['device'],format:navigator.gpu.getPreferredCanvasFormat(),usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC,alphaMode:'opaque'});
}
export async function gpuPixels(engine:WebGPUVolumeEngine,canvas:HTMLCanvasElement) {
  const device=engine['device'],row=Math.ceil(canvas.width*4/256)*256;
  const buffer=device.createBuffer({size:row*canvas.height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  try {
    const encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture:engine['context'].getCurrentTexture()},{buffer,bytesPerRow:row},[canvas.width,canvas.height]);device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);const bytes=new Uint8Array(buffer.getMappedRange()),pixels=new Uint8ClampedArray(canvas.width*canvas.height*4);
    for(let y=0;y<canvas.height;y++)pixels.set(bytes.subarray(y*row,y*row+canvas.width*4),y*canvas.width*4);
    if(navigator.gpu.getPreferredCanvasFormat()==='bgra8unorm')for(let i=0;i<pixels.length;i+=4)[pixels[i],pixels[i+2]]=[pixels[i+2],pixels[i]];
    buffer.unmap();return pixels;
  }finally{buffer.destroy();}
}
