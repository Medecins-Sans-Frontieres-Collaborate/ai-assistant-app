// @vitest-environment jsdom
import {
  VaultKvStore,
  __setVaultKvForTests,
  getServerSecrets,
  setServerSecrets,
} from '@/client/services/mcp/credentialVault';
import {
  __resetMcpCredentialSyncForTests,
  initMcpCredentialSync,
} from '@/client/services/mcp/mcpCredentialSync';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

function memoryKv(): VaultKvStore {
  const map = new Map<string, unknown>();
  return {
    get: async (k) => map.get(k),
    set: async (k, v) => void map.set(k, v),
    delete: async (k) => void map.delete(k),
    keys: async () => [...map.keys()],
  };
}

function mockVaultKeyFetch() {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: { keyMaterial: btoa('a'.repeat(32)), version: 1 },
        }),
        { status: 200 },
      ),
  ) as never;
}

/**
 * Write-through is fire-and-forget: the store subscriber can't be async, so it
 * kicks off `void setServerSecrets(...)` and returns. There is no promise to
 * await, so these assertions have to poll.
 *
 * This used to be a fixed 10ms sleep, which passed locally and failed on
 * loaded CI runners — the vault write simply hadn't landed yet. Polling keeps
 * the fast path fast (first attempt usually succeeds) while tolerating a slow
 * machine, and still fails properly if the write never happens.
 */
const expectEventually = (assertion: () => Promise<void> | void) =>
  vi.waitFor(assertion, { timeout: 2000, interval: 10 });

const githubRedacted = {
  id: 'github',
  catalogKey: 'github',
  name: 'GitHub',
  url: '',
  authMode: 'bearer' as const,
  enabled: true,
  createdAt: 'now',
};

describe('mcpCredentialSync', () => {
  let unsubscribe: (() => void) | undefined;

  beforeEach(() => {
    vi.restoreAllMocks();
    unsubscribe?.();
    __resetMcpCredentialSyncForTests();
    __setVaultKvForTests(memoryKv());
    mockVaultKeyFetch();
    useSettingsStore.setState({ mcpServers: [] });
  });

  it('merges vaulted secrets into the in-memory store on boot', async () => {
    await setServerSecrets('github', { authToken: 'github_pat_x' });
    useSettingsStore.setState({ mcpServers: [githubRedacted] });

    unsubscribe = await initMcpCredentialSync();

    expect(useSettingsStore.getState().mcpServers[0].authToken).toBe(
      'github_pat_x',
    );
  });

  it('adopts legacy plaintext secrets into the vault on first boot', async () => {
    useSettingsStore.setState({
      mcpServers: [{ ...githubRedacted, authToken: 'legacy_plaintext_pat' }],
    });

    unsubscribe = await initMcpCredentialSync();

    await expectEventually(async () => {
      expect(await getServerSecrets('github')).toEqual({
        authToken: 'legacy_plaintext_pat',
      });
    });
  });

  it('write-through: secret changes and deletions reach the vault', async () => {
    useSettingsStore.setState({ mcpServers: [githubRedacted] });
    unsubscribe = await initMcpCredentialSync();

    // Connect (token appears)
    useSettingsStore.getState().updateMcpServer('github', {
      authToken: 'github_pat_new',
    });
    await flushAsync();
    expect(await getServerSecrets('github')).toEqual({
      authToken: 'github_pat_new',
    });

    // Disconnect (server removed)
    useSettingsStore.getState().deleteMcpServer('github');
    await flushAsync();
    expect(await getServerSecrets('github')).toBeNull();
  });

  it('cleans up vault records for servers that no longer exist', async () => {
    await setServerSecrets('ghost', { authToken: 'orphaned' });
    useSettingsStore.setState({ mcpServers: [] });

    unsubscribe = await initMcpCredentialSync();
    await flushAsync();

    expect(await getServerSecrets('ghost')).toBeNull();
  });

  it('degrades gracefully when the vault key endpoint is unavailable', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('{}', { status: 503 }),
    ) as never;
    useSettingsStore.setState({
      mcpServers: [{ ...githubRedacted, authToken: 'in_memory_only' }],
    });

    unsubscribe = await initMcpCredentialSync();

    // In-memory state untouched; nothing thrown.
    expect(useSettingsStore.getState().mcpServers[0].authToken).toBe(
      'in_memory_only',
    );
  });
});

describe('settingsStore persisted redaction', () => {
  it('partialize strips every MCP secret field from the persisted blob', () => {
    useSettingsStore.setState({
      mcpServers: [
        {
          ...githubRedacted,
          authToken: 'github_pat_secret',
          oauth: {
            clientId: 'dcr-1',
            accessToken: 'at-secret',
            refreshToken: 'rt-secret',
            clientSecret: 'cs-secret',
            expiresAt: 123,
          },
          oauthApp: { clientId: 'own-app', clientSecret: 'own-secret' },
        },
      ],
    });

    const partialize = useSettingsStore.persist.getOptions().partialize!;
    const persisted = JSON.stringify(partialize(useSettingsStore.getState()));

    for (const secret of [
      'github_pat_secret',
      'at-secret',
      'rt-secret',
      'cs-secret',
      'own-secret',
    ]) {
      expect(persisted).not.toContain(secret);
    }
    // Non-secret metadata still persists (reconnect + display need it).
    expect(persisted).toContain('dcr-1');
    expect(persisted).toContain('own-app');
    expect(persisted).toContain('"expiresAt":123');
  });
});
