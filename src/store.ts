import { createStore } from 'zustand/vanilla';
import { persist, createJSONStorage } from 'zustand/middleware';

/** A recipe the user saved. Chemistry, look, and seed replay deterministically; paintings are not stored. */
export interface SavedPreset {
  id: string; name: string; createdAt: number;
  feed: number; kill: number; diffusionA: number; diffusionB: number;
  background: string; foreground: string; threshold: number; speed: number;
  seed: number; seedMode: 'scatter' | 'center';
  /** Small data URL captured from the field when saved. */
  art?: string;
}
export type PresetDraft = Omit<SavedPreset, 'id' | 'createdAt'>;

export interface State {
  saved: SavedPreset[];
  hud: boolean; dockLeft: boolean; dockRight: boolean;
  savePreset(draft: PresetDraft): SavedPreset;
  updatePreset(id: string, draft: Partial<PresetDraft>): void;
  removePreset(id: string): void;
  setUI(ui: Partial<Pick<State, 'hud' | 'dockLeft' | 'dockRight'>>): void;
}

const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);

export function createAppStore(defaults: Partial<Pick<State, 'hud' | 'dockLeft' | 'dockRight'>> = {}) {
  return createStore<State>()(persist(
    set => ({
      saved: [],
      hud: true, dockLeft: true, dockRight: true, ...defaults,
      savePreset(draft) {
        const preset: SavedPreset = { ...draft, id: newId(), createdAt: Date.now() };
        set(s => ({ saved: [preset, ...s.saved] })); return preset;
      },
      updatePreset(id, draft) { set(s => ({ saved: s.saved.map(p => p.id === id ? { ...p, ...draft } : p) })); },
      removePreset(id) { set(s => ({ saved: s.saved.filter(p => p.id !== id) })); },
      setUI(ui) { set(ui); },
    }),
    {
      name: 'morphlab',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: s => ({ saved: s.saved, hud: s.hud, dockLeft: s.dockLeft, dockRight: s.dockRight }),
    },
  ));
}
export type AppStore = ReturnType<typeof createAppStore>;
