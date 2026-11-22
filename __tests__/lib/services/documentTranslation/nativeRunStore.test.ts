import {
  NativeRunFileMissingError,
  NativeRunLockedError,
  NativeRunStore,
  isNativeFileId,
  runFileContentType,
} from '@/lib/services/documentTranslation/native/nativePdfStorage';
import type {
  RunFolder,
  RunFolderEntry,
} from '@/lib/services/documentTranslation/native/nativeRunBackends';

import {
  RUN_RECORD_ID,
  RUN_RETENTION_DAYS,
  RUN_TOUCH_INTERVAL_HOURS,
  RunFileIntegrityError,
  deriveRunKey,
  isEncryptedRunFile,
  parseRunFileUrl,
} from '@/lib/utils/shared/translation/nativeRunStorage';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real backends reach blob storage and Graph; a folder in memory
// stands in for both here.
vi.mock('@/lib/services/documentTranslation/native/nativeRunBackends', () => ({
  BlobRunFolder: {},
  DriveRunFolder: {},
}));

const RUN = '11111111-2222-4333-8444-555555555555';
const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-11-18T12:00:00Z');

/** A folder in memory, with the write times a test gives it. */
class MemoryFolder implements RunFolder {
  readonly files = new Map<string, { data: Buffer; written: number }>();
  readonly touched: string[] = [];
  constructor(readonly expires: boolean) {}
  async write(name: string, data: Buffer) {
    this.files.set(name, { data, written: Date.now() });
  }
  async read(name: string) {
    return this.files.get(name)?.data ?? null;
  }
  async list(): Promise<RunFolderEntry[]> {
    return [...this.files].map(([name, file]) => ({
      name,
      ...(this.expires ? { lastModified: new Date(file.written) } : {}),
    }));
  }
  async remove(name: string) {
    this.files.delete(name);
  }
  async touch(name: string) {
    this.touched.push(name);
    const file = this.files.get(name);
    if (file) file.written = Date.now();
  }
  async removeAll() {
    this.files.clear();
  }
  /** Sets how long ago a file was written. */
  age(name: string, hours: number) {
    const file = this.files.get(name);
    if (file) file.written = Date.now() - hours * HOUR;
  }
}

const pdf = Buffer.from('%PDF-1.7 the document');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('NativeRunStore: files', () => {
  it('stores a plain file under its hash and serves it by a run path', async () => {
    const folder = new MemoryFolder(true);
    const store = new NativeRunStore({ runId: RUN, backend: 'app' }, folder);
    const stored = await store.put(pdf, 'pdf');
    expect(isNativeFileId(stored.id, 'pdf')).toBe(true);
    expect(isNativeFileId(stored.id, 'json')).toBe(false);
    expect(parseRunFileUrl(stored.url)).toEqual({
      runId: RUN,
      backend: 'app',
      fileId: stored.id,
    });
    expect(await store.get(stored.id)).toEqual(pdf);
    expect(runFileContentType(stored.id, pdf)).toBe('application/pdf');
  });

  it('encrypts everything it writes when the run has a key', async () => {
    const folder = new MemoryFolder(true);
    const key = await deriveRunKey(new Uint8Array(32).fill(3), RUN);
    const store = new NativeRunStore(
      { runId: RUN, backend: 'app', key },
      folder,
    );
    const stored = await store.put(pdf, 'pdf');
    const atRest = folder.files.get(stored.id)!.data;
    expect(isEncryptedRunFile(atRest)).toBe(true);
    expect(atRest.toString('latin1')).not.toContain('the document');
    expect(runFileContentType(stored.id, atRest)).toBe(
      'application/octet-stream',
    );
    // Read back for laying out, and handed to the browser still encrypted.
    expect(await store.get(stored.id)).toEqual(pdf);
    expect(await store.getStored(stored.id)).toEqual(atRest);
  });

  it('refuses to read an encrypted file without the key, or with another', async () => {
    const folder = new MemoryFolder(true);
    const key = await deriveRunKey(new Uint8Array(32).fill(3), RUN);
    const stored = await new NativeRunStore(
      { runId: RUN, backend: 'app', key },
      folder,
    ).put(pdf, 'pdf');
    await expect(
      new NativeRunStore({ runId: RUN, backend: 'app' }, folder).get(stored.id),
    ).rejects.toThrow(NativeRunLockedError);
    const wrong = await deriveRunKey(new Uint8Array(32).fill(4), RUN);
    await expect(
      new NativeRunStore(
        { runId: RUN, backend: 'app', key: wrong },
        folder,
      ).get(stored.id),
    ).rejects.toThrow(RunFileIntegrityError);
  });

  it('says a file is missing rather than failing obscurely', async () => {
    const store = new NativeRunStore(
      { runId: RUN, backend: 'app' },
      new MemoryFolder(true),
    );
    await expect(store.get(`${'b'.repeat(64)}.pdf`)).rejects.toThrow(
      NativeRunFileMissingError,
    );
  });
});

describe('NativeRunStore: keeping a run alive', () => {
  async function seeded(expires = true) {
    const folder = new MemoryFolder(expires);
    const store = new NativeRunStore({ runId: RUN, backend: 'app' }, folder);
    const source = await store.put(pdf, 'pdf');
    const old = await store.put(Buffer.from('old render'), 'pdf');
    await store.putRecord(Buffer.from('{}'));
    return { folder, store, source: source.id, old: old.id };
  }

  it('touches files not written for a while and leaves fresh ones', async () => {
    const { folder, store, source, old } = await seeded();
    folder.age(source, RUN_TOUCH_INTERVAL_HOURS + 1);
    folder.age(old, RUN_TOUCH_INTERVAL_HOURS - 1);
    const result = await store.sync();
    expect(folder.touched).toEqual([source]);
    expect(result.files).toBe(3);
    // The run now expires a retention period after its oldest write.
    expect(Date.parse(result.expiresAt!)).toBe(
      NOW -
        (RUN_TOUCH_INTERVAL_HOURS - 1) * HOUR +
        RUN_RETENTION_DAYS * 24 * HOUR,
    );
  });

  it('only reports the expiry when asked not to touch', async () => {
    const { folder, store, source } = await seeded();
    folder.age(source, 4 * 24);
    const result = await store.sync(undefined, false);
    expect(folder.touched).toEqual([]);
    expect(Date.parse(result.expiresAt!)).toBe(NOW + 24 * HOUR);
  });

  it('deletes files the run no longer uses, never the record', async () => {
    const { folder, store, source, old } = await seeded();
    const result = await store.sync([source]);
    expect([...folder.files.keys()].sort()).toEqual(
      [source, RUN_RECORD_ID].sort(),
    );
    expect(folder.files.has(old)).toBe(false);
    expect(result.files).toBe(2);
  });

  it('reports a run whose files are gone, in whole or in part', async () => {
    const { folder, store, source } = await seeded();
    folder.files.delete(source);
    await expect(store.sync([source])).rejects.toThrow(
      NativeRunFileMissingError,
    );
    folder.files.clear();
    await expect(store.sync()).rejects.toThrow(NativeRunFileMissingError);
  });

  it('has no expiry where files are kept for good', async () => {
    const { folder, store } = await seeded(false);
    expect(await store.sync()).toEqual({ expiresAt: null, files: 3 });
    expect(folder.touched).toEqual([]);
  });
});
