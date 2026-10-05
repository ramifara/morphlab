import type { View } from './model';

export interface MorphSnapshot {
  version: 1;
  width: number;
  height: number;
  field: Float32Array;
  iterations: number;
  zoom: number;
  pan: View;
}

// Keep full-precision fields out of localStorage's small string-only quota.
function transact<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let blocked = false;
    const open = indexedDB.open('morphlab-fields', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('snapshots');
    open.onerror = () => reject(open.error);
    open.onblocked = () => { blocked = true; reject(new Error('Snapshot storage is blocked. Close other Morph Lab tabs and retry.')); };
    open.onsuccess = () => {
      const db = open.result;
      if (blocked) { db.close(); return; }
      try {
        const tx = db.transaction('snapshots', mode);
        const request = operation(tx.objectStore('snapshots'));
        tx.oncomplete = () => { db.close(); resolve(request.result); };
        tx.onabort = () => { db.close(); reject(tx.error ?? request.error ?? new Error('Snapshot storage failed.')); };
      } catch (error) { db.close(); reject(error); }
    };
  });
}

export async function saveSnapshot(snapshot: MorphSnapshot): Promise<string> {
  const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  await transact('readwrite', store => store.add(snapshot, id));
  return id;
}

export async function loadSnapshot(id: string, width: number, height: number): Promise<MorphSnapshot> {
  const snapshot: MorphSnapshot | undefined = await transact('readonly', store => store.get(id));
  if (!snapshot || snapshot.version !== 1 || snapshot.width !== width || snapshot.height !== height
    || !(snapshot.field instanceof Float32Array) || snapshot.field.length !== width * height * 2
    || !snapshot.field.every(value => Number.isFinite(value) && value >= 0 && value <= 1)
    || !Number.isSafeInteger(snapshot.iterations) || snapshot.iterations < 0
    || !Number.isFinite(snapshot.zoom) || snapshot.zoom <= 0
    || !Number.isFinite(snapshot.pan?.x) || !Number.isFinite(snapshot.pan?.y)) {
    throw new Error('The saved morph state is missing or incompatible.');
  }
  return snapshot;
}

export async function removeSnapshot(id: string): Promise<void> {
  await transact('readwrite', store => store.delete(id));
}
