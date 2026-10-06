import { defaultStart, seedModes, type SeedMode, type StartSettings } from './model';
import { decodeImageMask } from './seed-image';

/** Older recipes and links keep their original scatter or center start. */
export function readStart(query: URLSearchParams, fallback: SeedMode): StartSettings {
  const raw = query.get('start');
  const mode = seedModes.includes(raw as SeedMode) ? raw as SeedMode : fallback;
  return normalizeStart({
    ...defaultStart(mode),
    ...Object.fromEntries(['count', 'radius', 'amount', 'x', 'y', 'imageScale'].filter(key => query.has(`init_${key}`)).map(key => [key, Number(query.get(`init_${key}`))])),
    imageMask: query.get('image') ?? undefined,
    grown: query.get('grown') !== '0', paused: query.get('paused') === '1',
  });
}

export function normalizeStart(settings: Partial<StartSettings>, fallback: SeedMode = 'scatter'): StartSettings {
  const mode = seedModes.includes(settings.mode as SeedMode) ? settings.mode! : fallback;
  const defaults = defaultStart(mode);
  const number = (key: keyof typeof bounds) => {
    const [min, max] = bounds[key], value = settings[key];
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : defaults[key];
  };
  const bounds = { count: [1, 1000], radius: [1, 30], amount: [.05, .8], x: [0, 1], y: [0, 1], imageScale: [.1, 1] };
  return { mode, count: Math.round(number('count')), radius: number('radius'), amount: number('amount'), x: number('x'), y: number('y'), imageScale: number('imageScale'), imageMask: decodeImageMask(settings.imageMask) ? settings.imageMask : undefined, grown: settings.grown ?? defaults.grown, paused: settings.paused ?? defaults.paused };
}

export function writeStart(query: URLSearchParams, settings: StartSettings) {
  query.set('start', settings.mode);
  for (const key of ['count', 'radius', 'amount', 'x', 'y', 'imageScale'] as const) {
    if (settings.mode === 'image' && (key === 'count' || key === 'radius')) continue;
    query.set(`init_${key}`, String(settings[key]));
  }
  if (settings.mode === 'image' && settings.imageMask) query.set('image', settings.imageMask);
  query.set('grown', settings.grown ? '1' : '0'); query.set('paused', settings.paused ? '1' : '0');
}
