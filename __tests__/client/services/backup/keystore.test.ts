import {
  type KeystoreKvStore,
  __setKeystoreKvForTests,
  clearMasterKey,
  getBackupKeys,
  loadMasterKey,
  resetBackupKeyCache,
  saveMasterKey,
} from '@/client/services/backup/keystore';

import { deriveBackupKeys } from '@/lib/utils/shared/backupCrypto/keyDerivation';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// The keystore's job is KV handling + single-flight memoization; the real
// derivation is covered by the backupCrypto tests. Mocking it also keeps this
// file environment-agnostic (no WebCrypto dependency).
vi.mock('@/lib/utils/shared/backupCrypto/keyDerivation', () => ({
  deriveBackupKeys: vi.fn(async (master: Uint8Array) => ({
    encKey: { type: 'secret' } as unknown as CryptoKey,
    keyId: `keyid-${master[0]}`,
  })),
}));

const deriveMock = vi.mocked(deriveBackupKeys);

function memoryKv(): KeystoreKvStore & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map,
    get: async (key) => map.get(key),
    set: async (key, value) => {
      map.set(key, value);
    },
    delete: async (key) => {
      map.delete(key);
    },
  };
}

function masterKey(firstByte = 7): Uint8Array {
  const key = new Uint8Array(32);
  key.fill(1);
  key[0] = firstByte;
  return key;
}

describe('backup keystore', () => {
  let kv: ReturnType<typeof memoryKv>;

  beforeEach(() => {
    kv = memoryKv();
    __setKeystoreKvForTests(kv);
    deriveMock.mockClear();
  });

  describe('saveMasterKey / loadMasterKey / clearMasterKey', () => {
    it('roundtrips the raw 32 bytes', async () => {
      const key = masterKey();
      await saveMasterKey(key);

      const loaded = await loadMasterKey();
      expect(loaded).toEqual(key);
    });

    it('stores and returns defensive copies, not the caller buffer', async () => {
      const key = masterKey();
      await saveMasterKey(key);
      key.fill(0); // caller zeroes its buffer after saving

      const loaded = await loadMasterKey();
      expect(loaded).toEqual(masterKey());

      // Mutating the loaded copy must not corrupt the stored record.
      loaded!.fill(0);
      expect(await loadMasterKey()).toEqual(masterKey());
    });

    it('rejects keys that are not exactly 32 bytes', async () => {
      await expect(saveMasterKey(new Uint8Array(31))).rejects.toThrow(
        /32 bytes/,
      );
      await expect(saveMasterKey(new Uint8Array(0))).rejects.toThrow(
        /32 bytes/,
      );
      expect(kv.map.size).toBe(0);
    });

    it('returns null when no key is stored', async () => {
      expect(await loadMasterKey()).toBeNull();
    });

    it('returns null for a corrupt record (wrong type or length)', async () => {
      kv.map.set('master-key-v1', 'not-bytes');
      expect(await loadMasterKey()).toBeNull();

      kv.map.set('master-key-v1', new Uint8Array(16));
      expect(await loadMasterKey()).toBeNull();
    });

    it('clearMasterKey removes the key', async () => {
      await saveMasterKey(masterKey());
      await clearMasterKey();
      expect(await loadMasterKey()).toBeNull();
    });
  });

  describe('getBackupKeys memoization', () => {
    it('resolves null when no key is stored, without caching the absence', async () => {
      expect(await getBackupKeys()).toBeNull();
      expect(deriveMock).not.toHaveBeenCalled();

      // Key appears out-of-band (e.g. enrollment in another tab path) — the
      // next call must pick it up rather than return a cached null.
      kv.map.set('master-key-v1', masterKey(9));
      const keys = await getBackupKeys();
      expect(keys?.keyId).toBe('keyid-9');
    });

    it('derives once for concurrent callers (single-flight)', async () => {
      await saveMasterKey(masterKey());

      const [a, b] = await Promise.all([getBackupKeys(), getBackupKeys()]);
      expect(a).toBe(b);
      expect(deriveMock).toHaveBeenCalledTimes(1);
    });

    it('memoizes across sequential calls', async () => {
      await saveMasterKey(masterKey());
      const first = await getBackupKeys();
      const second = await getBackupKeys();
      expect(second).toBe(first);
      expect(deriveMock).toHaveBeenCalledTimes(1);
    });

    it('saveMasterKey invalidates the memo so the new key is derived', async () => {
      await saveMasterKey(masterKey(1));
      expect((await getBackupKeys())?.keyId).toBe('keyid-1');

      await saveMasterKey(masterKey(2));
      expect((await getBackupKeys())?.keyId).toBe('keyid-2');
      expect(deriveMock).toHaveBeenCalledTimes(2);
    });

    it('clearMasterKey invalidates the memo', async () => {
      await saveMasterKey(masterKey());
      await getBackupKeys();

      await clearMasterKey();
      expect(await getBackupKeys()).toBeNull();
    });

    it('resetBackupKeyCache forces a re-derivation', async () => {
      await saveMasterKey(masterKey());
      await getBackupKeys();

      resetBackupKeyCache();
      await getBackupKeys();
      expect(deriveMock).toHaveBeenCalledTimes(2);
    });

    it('does not cache a failed derivation', async () => {
      await saveMasterKey(masterKey());
      deriveMock.mockRejectedValueOnce(new Error('boom'));

      await expect(getBackupKeys()).rejects.toThrow('boom');
      const keys = await getBackupKeys();
      expect(keys?.keyId).toBe('keyid-7');
    });
  });
});
