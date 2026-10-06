export const BASE_WIDTH = 512, BASE_HEIGHT = 320;
export const resolutions = [1, 2, 3, 4] as const;
export type Resolution = typeof resolutions[number];

export function parseResolution(value: unknown): Resolution {
  const number = Number(value);
  return resolutions.includes(number as Resolution) ? number as Resolution : 1;
}

export function gridSize(resolution: Resolution) {
  return { width: BASE_WIDTH * resolution, height: BASE_HEIGHT * resolution };
}

/** Interpolate both chemicals, sampling across the periodic field's edges. */
export function resizeField(data: Float32Array, width: number, height: number, nextWidth: number, nextHeight: number): Float32Array {
  if (width === nextWidth && height === nextHeight) return data;
  const result = new Float32Array(nextWidth * nextHeight * 2);
  for (let y = 0; y < nextHeight; y++) {
    const sy = (y + .5) * height / nextHeight - .5, iy = Math.floor(sy), fy = sy - iy;
    const y0 = (iy + height) % height, y1 = (y0 + 1) % height;
    for (let x = 0; x < nextWidth; x++) {
      const sx = (x + .5) * width / nextWidth - .5, ix = Math.floor(sx), fx = sx - ix;
      const x0 = (ix + width) % width, x1 = (x0 + 1) % width;
      for (let c = 0; c < 2; c++) {
        const top = data[(y0 * width + x0) * 2 + c] * (1 - fx) + data[(y0 * width + x1) * 2 + c] * fx;
        const bottom = data[(y1 * width + x0) * 2 + c] * (1 - fx) + data[(y1 * width + x1) * 2 + c] * fx;
        result[(y * nextWidth + x) * 2 + c] = top * (1 - fy) + bottom * fy;
      }
    }
  }
  return result;
}
