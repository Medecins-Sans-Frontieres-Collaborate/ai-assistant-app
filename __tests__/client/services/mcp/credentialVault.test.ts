// @vitest-environment jsdom
import {
  VaultKvStore,
  __setVaultKvForTests,
  deleteServerSecrets,
  getServerSecrets,
  listVaultedServerIds,
  setServerSecrets,
} from '@/client/services/mcp/credentialVault';

import { beforeEach, describe, expect, it, vi } from 'vitest';

function memoryKv(): VaultKvStore & { dump(): Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    get: async (k) => map.get(k),
    set: async (k, v) => void map.set(k, v),
    delete: async (k) => void map.delete(k),
    keys: async () => [...map.keys()],
    dump: () => map,
  };
}

function mockVaultKeyFetch(material = 'a'.repeat(32)) {
  globalThis.fetch = vi.fn(async (input: string | URL) => {
    if (String(input) === '/api/mcp/vault-key') {
      return new Response(
        JSON.stringify({
          success: true,
          data: { keyMaterial: btoa(material), version: 1 },
        }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch: ${input}`);
  }) as never;
}

const secrets = {
  authToken: 'github_pat_supersecret',
  oauth: { accessToken: 'at-1', refreshToken: 'rt-1', clientSecret: 'cs-1' },
};

describe('credentialVault', () => {
  let kv: ReturnType<typeof memoryKv>;

  beforeEach(() => {
    vi.restoreAllMocks();
    kv = memoryKv();
    __setVaultKvForTests(kv);
    mockVaultKeyFetch();
  });

  it('round-trips secrets and stores ONLY ciphertext at rest', async () => {
    await setServerSecrets('github', secrets);

    const readBack = await getServerSecrets('github');
    expect(readBack).toEqual(secrets);

    // At-rest artifact is ciphertext: no secret substring appears anywhere.
    const atRest = JSON.stringify([...kv.dump().entries()], (_, v) =>
      v instanceof Uint8Array ? Array.from(v) : v,
    );
    expect(atRest).not.toContain('github_pat_supersecret');
    expect(atRest).not.toContain('rt-1');
    const stored = kv.dump().get('server:github') as string;
    expect(stored.startsWith('enc1:')).toBe(true);
  });

  it('fetches the vault key ONCE for many operations (single-flight)', async () => {
    await Promise.all([
      setServerSecrets('a', { authToken: 'x' }),
      setServerSecrets('b', { authToken: 'y' }),
    ]);
    await getServerSecrets('a');

    expect(vi.mocked(globalThis.fetch).mock.calls).toHaveLength(1);
  });

  it('returns null (never throws) when the key material changed', async () => {
    await setServerSecrets('github', secrets);

    // New session with ROTATED server material (e.g. AUTH_SECRET rotation).
    __setVaultKvForTests(kv);
    mockVaultKeyFetch('b'.repeat(32));

    expect(await getServerSecrets('github')).toBeNull();
  });

  it('deletes records and lists vaulted ids', async () => {
    await setServerSecrets('github', secrets);
    await setServerSecrets('asana', { oauth: { accessToken: 'at' } });

    expect((await listVaultedServerIds()).sort()).toEqual(['asana', 'github']);

    await deleteServerSecrets('github');
    expect(await listVaultedServerIds()).toEqual(['asana']);
  });

  it('setServerSecrets with no secret material clears the record', async () => {
    await setServerSecrets('github', secrets);
    await setServerSecrets('github', { oauth: {} });

    expect(await getServerSecrets('github')).toBeNull();
    expect(await listVaultedServerIds()).toEqual([]);
  });

  it('vault key fetch failure rejects but allows a later retry', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('{}', { status: 503 }),
    ) as never;

    await expect(setServerSecrets('github', secrets)).rejects.toThrow(
      /vault key unavailable/,
    );

    mockVaultKeyFetch();
    await setServerSecrets('github', secrets);
    expect(await getServerSecrets('github')).toEqual(secrets);
  });
});
