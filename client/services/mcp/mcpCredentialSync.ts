'use client';

import {
  McpServerSecrets,
  deleteServerSecrets,
  getServerSecrets,
  listVaultedServerIds,
  setServerSecrets,
} from './credentialVault';

import {
  McpServerConfig,
  useSettingsStore,
} from '@/client/stores/settingsStore';

/**
 * Keeps MCP credentials flowing between the in-memory settings store and the
 * encrypted credential vault:
 *
 * - BOOT (authenticated): read vault records and merge secret fields into
 *   the in-memory `mcpServers` (the persisted localStorage blob is REDACTED
 *   — see settingsStore partialize — so this is where secrets re-enter).
 *   Legacy plaintext secrets still present from pre-vault blobs are adopted
 *   as-is and get scrubbed from localStorage by the very next persist write.
 * - AFTERWARDS: a store subscription write-through: any change to a server's
 *   secret fields re-encrypts its vault record; removed servers get their
 *   vault records deleted (covers disconnect, undo, resetSettings).
 *
 * Consumers (chatStore send path, useMcpTools, Connectors UI) keep reading
 * plaintext synchronously from the in-memory store — the vault is purely an
 * at-rest boundary. If the vault key is unavailable (offline, unconfigured),
 * sync degrades: in-memory state still works for the session; nothing is
 * lost or wiped.
 */

function extractSecrets(server: McpServerConfig): McpServerSecrets {
  return {
    ...(server.authToken ? { authToken: server.authToken } : {}),
    ...(server.oauth?.accessToken ||
    server.oauth?.refreshToken ||
    server.oauth?.clientSecret
      ? {
          oauth: {
            ...(server.oauth.accessToken
              ? { accessToken: server.oauth.accessToken }
              : {}),
            ...(server.oauth.refreshToken
              ? { refreshToken: server.oauth.refreshToken }
              : {}),
            ...(server.oauth.clientSecret
              ? { clientSecret: server.oauth.clientSecret }
              : {}),
          },
        }
      : {}),
    ...(server.oauthApp?.clientSecret
      ? { oauthApp: { clientSecret: server.oauthApp.clientSecret } }
      : {}),
  };
}

function mergeSecrets(
  server: McpServerConfig,
  secrets: McpServerSecrets,
): McpServerConfig {
  return {
    ...server,
    authToken: server.authToken ?? secrets.authToken,
    oauth: server.oauth
      ? {
          ...server.oauth,
          accessToken: server.oauth.accessToken ?? secrets.oauth?.accessToken,
          refreshToken:
            server.oauth.refreshToken ?? secrets.oauth?.refreshToken,
          clientSecret:
            server.oauth.clientSecret ?? secrets.oauth?.clientSecret,
        }
      : secrets.oauth
        ? // Redacted config lost its oauth block entirely only when it held
          // nothing but secrets; clientId is non-secret and persisted, so a
          // missing block means a legacy/partial record — rebuild defensively.
          {
            clientId: '',
            accessToken: secrets.oauth.accessToken,
            refreshToken: secrets.oauth.refreshToken,
            clientSecret: secrets.oauth.clientSecret,
          }
        : undefined,
    oauthApp: server.oauthApp
      ? {
          ...server.oauthApp,
          clientSecret:
            server.oauthApp.clientSecret ?? secrets.oauthApp?.clientSecret,
        }
      : server.oauthApp,
  };
}

/** Serialized fingerprint of the secret fields, for cheap change detection. */
function secretsFingerprint(server: McpServerConfig): string {
  return JSON.stringify(extractSecrets(server));
}

let started = false;

/**
 * Idempotent init, called from AppInitializer once a session exists. Returns
 * the unsubscribe for tests.
 */
export async function initMcpCredentialSync(): Promise<() => void> {
  if (started) return () => {};
  started = true;

  const lastSynced = new Map<string, string>();

  // ── BOOT MERGE
  try {
    const state = useSettingsStore.getState();
    const vaultedIds = await listVaultedServerIds();
    if (vaultedIds.length > 0) {
      const secretsById = new Map<string, McpServerSecrets | null>();
      for (const id of vaultedIds) {
        secretsById.set(id, await getServerSecrets(id));
      }
      const merged = state.mcpServers.map((server) => {
        const secrets = secretsById.get(server.id);
        return secrets ? mergeSecrets(server, secrets) : server;
      });
      // Setting mcpServers triggers a persist write, whose partialize
      // redaction also scrubs any legacy plaintext from localStorage.
      useSettingsStore.setState({ mcpServers: merged });
      // Vault records for servers that no longer exist: clean up.
      const liveIds = new Set(merged.map((s) => s.id));
      for (const id of vaultedIds) {
        if (!liveIds.has(id)) await deleteServerSecrets(id);
      }
    } else if (state.mcpServers.length > 0) {
      // First vault-enabled boot with legacy plaintext state: force one
      // persist write so the redacting partialize scrubs localStorage.
      useSettingsStore.setState({ mcpServers: [...state.mcpServers] });
    }
    for (const server of useSettingsStore.getState().mcpServers) {
      lastSynced.set(server.id, secretsFingerprint(server));
      // Ensure every current secret is vaulted (covers legacy plaintext).
      void setServerSecrets(server.id, extractSecrets(server)).catch(() => {});
    }
  } catch (error) {
    console.warn(
      '[mcpCredentialSync] Vault unavailable; MCP credentials stay in-memory for this session:',
      error instanceof Error ? error.message : error,
    );
    // Do not subscribe writes either — without a key nothing can be vaulted,
    // and the persisted blob stays redacted regardless.
    started = true;
    return () => {};
  }

  // ── WRITE-THROUGH SUBSCRIPTION
  const unsubscribe = useSettingsStore.subscribe((state, previousState) => {
    if (state.mcpServers === previousState.mcpServers) return;

    const currentIds = new Set(state.mcpServers.map((s) => s.id));
    for (const id of lastSynced.keys()) {
      if (!currentIds.has(id)) {
        lastSynced.delete(id);
        void deleteServerSecrets(id).catch(() => {});
      }
    }
    for (const server of state.mcpServers) {
      const fingerprint = secretsFingerprint(server);
      if (lastSynced.get(server.id) === fingerprint) continue;
      lastSynced.set(server.id, fingerprint);
      void setServerSecrets(server.id, extractSecrets(server)).catch(
        (error) => {
          console.warn(
            '[mcpCredentialSync] Failed to vault credentials for a connector:',
            error instanceof Error ? error.message : error,
          );
        },
      );
    }
  });

  return unsubscribe;
}

/** Test hook. */
export function __resetMcpCredentialSyncForTests(): void {
  started = false;
}
