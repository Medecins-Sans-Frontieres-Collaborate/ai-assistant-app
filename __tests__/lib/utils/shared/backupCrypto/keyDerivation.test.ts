import {
  computeKeyId,
  deriveBackupKeys,
} from '@/lib/utils/shared/backupCrypto/keyDerivation';

import { describe, expect, it } from 'vitest';

/** Deterministic key 0x00..0x1f for pinned vectors. */
function fixedKey(): Uint8Array {
  return new Uint8Array(Array.from({ length: 32 }, (_, i) => i));
}

// Pinned regression vectors — a change here would orphan every stored
// backup's keyId and break key-mismatch detection across devices.
const FIXED_KEY_ID = '42d388eed7a82827';
const FIXED_KEY_ID_AB = '8e6a967898e5f189';

describe('computeKeyId', () => {
  it('matches the pinned fixed vectors', async () => {
    await expect(computeKeyId(fixedKey())).resolves.toBe(FIXED_KEY_ID);
    await expect(computeKeyId(new Uint8Array(32).fill(0xab))).resolves.toBe(
      FIXED_KEY_ID_AB,
    );
  });

  it('is 16 lowercase hex chars and stable across calls', async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const first = await computeKeyId(key);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    await expect(computeKeyId(key)).resolves.toBe(first);
  });

  it('is distinct for distinct master keys', async () => {
    const a = await computeKeyId(crypto.getRandomValues(new Uint8Array(32)));
    const b = await computeKeyId(crypto.getRandomValues(new Uint8Array(32)));
    expect(a).not.toBe(b);
  });

  it('rejects master keys that are not 32 bytes', async () => {
    await expect(computeKeyId(new Uint8Array(31))).rejects.toThrow(/32 bytes/);
  });
});

describe('deriveBackupKeys', () => {
  it('returns a non-extractable AES-GCM-256 encryption key', async () => {
    const { encKey } = await deriveBackupKeys(fixedKey());
    expect(encKey.extractable).toBe(false);
    expect(encKey.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect([...encKey.usages].sort()).toEqual(['decrypt', 'encrypt']);
  });

  it('returns the same keyId as computeKeyId', async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const { keyId } = await deriveBackupKeys(key);
    await expect(computeKeyId(key)).resolves.toBe(keyId);
  });

  it('derives encryption keys deterministically (same master → same ciphertext key)', async () => {
    // The CryptoKey handle is non-extractable, so prove determinism by
    // encrypting with one derivation and decrypting with a fresh one.
    const master = crypto.getRandomValues(new Uint8Array(32));
    const first = await deriveBackupKeys(master);
    const second = await deriveBackupKeys(master);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      first.encKey,
      new TextEncoder().encode('probe'),
    );
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      second.encKey,
      ciphertext,
    );
    expect(new TextDecoder().decode(plain)).toBe('probe');
  });

  it('derives distinct encryption keys for distinct masters', async () => {
    const first = await deriveBackupKeys(fixedKey());
    const second = await deriveBackupKeys(new Uint8Array(32).fill(0xab));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      first.encKey,
      new TextEncoder().encode('probe'),
    );
    await expect(
      crypto.subtle.decrypt({ name: 'AES-GCM', iv }, second.encKey, ciphertext),
    ).rejects.toThrow();
  });

  it('rejects master keys that are not 32 bytes', async () => {
    await expect(deriveBackupKeys(new Uint8Array(33))).rejects.toThrow(
      /32 bytes/,
    );
  });
});
