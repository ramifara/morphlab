import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { loadSnapshot, removeSnapshot, saveSnapshot, type MorphSnapshot } from './snapshots';

const snapshot = (): MorphSnapshot => ({
  version: 1, width: 2, height: 2,
  field: new Float32Array([1, 0, .51234567, .25123456, .7, .12, .43, .32]),
  iterations: 4321, zoom: 1.75, pan: { x: 12, y: -34 },
});

describe('saved morph fields', () => {
  beforeEach(() => { globalThis.indexedDB = new IDBFactory(); });

  it('round-trips both chemical channels without losing float precision or view state', async () => {
    const original = snapshot();
    const id = await saveSnapshot(original);
    // Subsequent simulation changes must not change the saved field.
    original.field.fill(0);
    const loaded = await loadSnapshot(id, 2, 2);
    expect(loaded).toEqual(snapshot());
    expect(new Uint8Array(loaded.field.buffer)).toEqual(new Uint8Array(snapshot().field.buffer));
  });

  it('keeps different versions with identical recipes independent and deletes only the chosen field', async () => {
    const first = await saveSnapshot(snapshot());
    const changed = snapshot(); changed.field[3] = .42;
    const second = await saveSnapshot(changed);
    await removeSnapshot(first);
    await expect(loadSnapshot(first, 2, 2)).rejects.toThrow('missing or incompatible');
    expect(await loadSnapshot(second, 2, 2)).toEqual(changed);
  });

  it('rejects missing fields, incompatible dimensions, and corrupt data', async () => {
    await expect(loadSnapshot('missing', 2, 2)).rejects.toThrow();
    const id = await saveSnapshot(snapshot());
    await expect(loadSnapshot(id, 4, 1)).rejects.toThrow();
    const corrupt = snapshot(); corrupt.field[0] = NaN;
    await expect(loadSnapshot(await saveSnapshot(corrupt), 2, 2)).rejects.toThrow();
  });

  it('reports unavailable storage instead of producing a snapshot reference', async () => {
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, writable: true, value: undefined });
    await expect(saveSnapshot(snapshot())).rejects.toThrow();
  });
});
