import { contours } from 'd3-contour';
import { rgb, type Palette } from './model';

type Point = [number, number];
export interface SVGOptions { smooth?: boolean; title?: string }

const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

/** Drop the closing duplicate and any point that sits on a straight line between its neighbours. */
function simplify(ring: Point[]): Point[] {
  const pts = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring.slice();
  if (pts.length < 4) return pts;
  return pts.filter((p, i) => {
    const a = pts[(i - 1 + pts.length) % pts.length], b = pts[(i + 1) % pts.length];
    return Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) > 1e-6;
  });
}
function polyline(pts: Point[]): string {
  return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${fmt(x)},${fmt(y)}`).join('') + 'Z';
}
/** Closed Catmull–Rom spline through the ring, written as cubic Béziers. */
function spline(pts: Point[]): string {
  const n = pts.length; if (n < 3) return polyline(pts);
  let d = `M${fmt(pts[0][0])},${fmt(pts[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    const c1: Point = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Point = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${fmt(c1[0])},${fmt(c1[1])} ${fmt(c2[0])},${fmt(c2[1])} ${fmt(p2[0])},${fmt(p2[1])}`;
  }
  return d + 'Z';
}

/** Each blob becomes its own <path> (outer ring plus holes) so shapes stay selectable in vector editors. */
export function fieldToSVG(data: Float32Array, width: number, height: number, threshold: number, palette: Palette, options: SVGOptions = {}): string {
  const { smooth = true, title = 'Morph Lab reaction–diffusion pattern' } = options;
  const values = Array.from({ length: width * height }, (_, i) => data[i * 2 + 1]);
  const shape = contours().size([width, height]).thresholds([threshold])(values)[0];
  const trace = smooth ? spline : polyline;
  const paths = shape.coordinates
    .map(polygon => polygon.map(ring => simplify(ring as Point[])).filter(ring => ring.length >= 3))
    .filter(polygon => polygon.length > 0)
    .map((polygon, i) => `<path id="shape-${i + 1}" d="${polygon.map(trace).join('')}"/>`);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width * 4}" height="${height * 4}" viewBox="0 0 ${width} ${height}">`,
    `<title>${title}</title>`,
    `<g id="background"><rect width="${width}" height="${height}" fill="${palette.background}"/></g>`,
    `<g id="pattern" fill="${palette.foreground}" fill-rule="evenodd">${paths.join('')}</g>`,
    `</svg>`,
  ].join('\n');
}

export async function fieldToPNG(data: Float32Array, width: number, height: number, threshold: number, palette: Palette, scale = 4): Promise<Blob> {
  const canvas = document.createElement('canvas'); canvas.width = width * scale; canvas.height = height * scale;
  const context = canvas.getContext('2d')!;
  const small = document.createElement('canvas'); small.width = width; small.height = height;
  const source = small.getContext('2d')!; const pixels = source.createImageData(width, height);
  const bg = rgb(palette.background); const fg = rgb(palette.foreground);
  for (let i = 0; i < width * height; i++) {
    const x = Math.max(0, Math.min(1, (data[i * 2 + 1] - threshold + .045) / .09)); const t = x * x * (3 - 2 * x);
    for (let c = 0; c < 3; c++) pixels.data[i * 4 + c] = Math.round((bg[c] + (fg[c] - bg[c]) * t) * 255);
    pixels.data[i * 4 + 3] = 255;
  }
  source.putImageData(pixels, 0, 0); context.imageSmoothingQuality = 'high'; context.drawImage(small, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG export failed.')), 'image/png'));
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
