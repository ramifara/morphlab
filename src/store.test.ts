import { beforeEach, describe, expect, it, vi } from 'vitest';

// A tiny localStorage for Node so the persist middleware has somewhere to write.
const memory = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { value: {
  getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v),
  removeItem: (k: string) => void memory.delete(k), clear: () => memory.clear(), key: () => null, length: 0,
}, configurable: true });
const { createAppStore } = await import('./store');

const draft = { feed: .0329, kill: .0556, diffusionA: 1, diffusionB: .5, background: '#20221d', foreground: '#e3e5cc', threshold: .3, speed: 24, seed: 52208484, seedMode: 'scatter' as const };

describe('preset library', () => {
  beforeEach(() => memory.clear());
  it('saves, updates, and removes presets', () => {
    const store = createAppStore();
    const saved = store.getState().savePreset({ ...draft, name: 'Pulse II' });
    expect(saved.id).toBeTruthy();
    expect(store.getState().saved).toHaveLength(1);
    store.getState().updatePreset(saved.id, { name: 'Pulse III' });
    expect(store.getState().saved[0].name).toBe('Pulse III');
    store.getState().removePreset(saved.id);
    expect(store.getState().saved).toHaveLength(0);
  });
  it('persists presets and interface preferences to localStorage and rehydrates them', () => {
    const first = createAppStore();
    first.getState().savePreset({ ...draft, name: 'Kept' });
    first.getState().setUI({ hud: false, dockLeft: false });
    expect(memory.get('morphlab')).toContain('Kept');
    const second = createAppStore();
    expect(second.getState().saved.map(p => p.name)).toEqual(['Kept']);
    expect(second.getState().hud).toBe(false);
    expect(second.getState().dockLeft).toBe(false);
    expect(second.getState().dockRight).toBe(true);
  });
  it('lists the newest preset first', () => {
    const store = createAppStore();
    store.getState().savePreset({ ...draft, name: 'A' }); store.getState().savePreset({ ...draft, name: 'B' });
    expect(store.getState().saved.map(p => p.name)).toEqual(['B', 'A']);
  });
  it('rehydrates snapshot references alongside legacy recipe-only saves', () => {
    const store = createAppStore();
    store.getState().savePreset({ ...draft, name: 'Legacy' });
    store.getState().savePreset({ ...draft, name: 'Live morph', snapshotId: 'field-1' });
    expect(createAppStore().getState().saved.map(p => p.snapshotId)).toEqual(['field-1', undefined]);
    expect(memory.get('morphlab')).not.toContain('Float32Array');
  });
  it('does not leave a phantom save in memory when localStorage is full', () => {
    const store = createAppStore();
    const saved = store.getState().savePreset({ ...draft, name: 'Existing' });
    const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('Quota exceeded'); });
    try {
      expect(() => store.getState().savePreset({ ...draft, name: 'Failed', snapshotId: 'field-2' })).toThrow('Quota exceeded');
      expect(store.getState().saved).toEqual([saved]);
      expect(() => store.getState().removePreset(saved.id)).toThrow('Quota exceeded');
      expect(store.getState().saved).toEqual([saved]);
    } finally { write.mockRestore(); }
    expect(createAppStore().getState().saved).toEqual([saved]);
  });
});
