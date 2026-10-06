import { createStore } from 'zustand/vanilla';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Resolution } from './resolution';
import type { SeedMode, StartSettings } from './model';

/** Saved recipe metadata. New saves reference a full chemical field in IndexedDB. */
export interface SavedPreset {
  id: string; name: string; createdAt: number;
  feed: number; kill: number; diffusionA: number; diffusionB: number;
  background: string; foreground: string; threshold: number; speed: number;
  seed: number; seedMode: SeedMode;
  start?: StartSettings;
  /** Older saves use the original 1× grid. */
  resolution?: Resolution;
  /** Small data URL captured from the field when saved. */
  art?: string;
  snapshotId?: string;
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
    (set, get) => ({
      saved: [],
      hud: true, dockLeft: true, dockRight: true, ...defaults,
      savePreset(draft) {
        const preset: SavedPreset = { ...draft, id: newId(), createdAt: Date.now() };
        const previous = get().saved;
        try { set({ saved: [preset, ...previous] }); }
        catch (error) {
          // Persist writes after updating memory. Roll back a failed write too.
          try { set({ saved: previous }); } catch { /* Memory is already restored. */ }
          throw error;
        }
        return preset;
      },
      updatePreset(id, draft) { set(s => ({ saved: s.saved.map(p => p.id === id ? { ...p, ...draft } : p) })); },
      removePreset(id) {
        const previous = get().saved;
        try { set({ saved: previous.filter(p => p.id !== id) }); }
        catch (error) {
          try { set({ saved: previous }); } catch { /* Memory is already restored. */ }
          throw error;
        }
      },
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
