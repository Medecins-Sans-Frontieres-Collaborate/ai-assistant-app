import {
  AgentAccessConflictError,
  deleteRule,
  listAllRules,
  readConfig,
  readRule,
  writeConfig,
  writeHistoryEntry,
  writeRule,
} from '@/lib/services/agentAccess/accessRulesStore';
import {
  AGENT_ACCESS_CONFIG_PATH,
  AGENT_ACCESS_RULES_PREFIX,
  AgentAccessConfig,
  AgentAccessHistoryEntry,
  AgentAccessRule,
  canonicalAgentKey,
  historyBlobPath,
  ruleBlobPath,
} from '@/lib/services/agentAccess/types';

import { BlobStorage } from '@/lib/utils/server/blob/blob';

import { Readable } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/environment', () => ({
  env: {
    AZURE_BLOB_STORAGE_NAME: 'testaccount',
    AZURE_BLOB_STORAGE_CONTAINER: 'testcontainer',
  },
}));

const SOURCE = '/subscriptions/sub/resourceGroups/rg/projects/Proj-X';

const sampleRule: AgentAccessRule = {
  version: 1,
  source: SOURCE,
  agentName: 'Finance-Bot',
  access: {
    type: 'restricted',
    allowDomains: ['example.com'],
    allowUsers: ['a@example.com'],
    allowGroups: [],
  },
  updatedBy: 'admin@example.com',
  updatedAt: '2026-07-17T00:00:00.000Z',
};
const sampleKey = canonicalAgentKey(sampleRule.source, sampleRule.agentName);
const samplePath = ruleBlobPath(sampleKey);

const sampleConfig: AgentAccessConfig = {
  version: 1,
  localAdmins: [{ email: 'lead@example.com', agentKeys: [sampleKey] }],
  updatedBy: 'admin@example.com',
  updatedAt: '2026-07-17T00:00:00.000Z',
};

const sampleHistoryEntry: AgentAccessHistoryEntry = {
  version: 1,
  canonicalKey: sampleKey,
  action: 'upsert',
  rule: sampleRule,
  updatedBy: 'admin@example.com',
  updatedAt: '2026-07-17T00:00:00.000Z',
};

function createMockClient() {
  return {
    upload: vi.fn(),
    download: vi.fn(),
    delete: vi.fn(),
  };
}
type MockClient = ReturnType<typeof createMockClient>;

/**
 * `upload` is stubbed on the storage itself so the tests prove writes go
 * through `getBlockBlobClient().upload` and NEVER `AzureBlobStorage.upload()`
 * (whose same-byte-length dedupe silently drops writes).
 */
function createMockStorage(clientForPath: (path: string) => MockClient) {
  return {
    getBlockBlobClient: vi.fn(clientForPath),
    listBlobs: vi.fn(),
    upload: vi.fn(),
  } as unknown as BlobStorage & { upload: ReturnType<typeof vi.fn> };
}

function downloadResponseFor(content: string, etag = '"etag-1"') {
  return {
    etag,
    readableStreamBody: Readable.from([Buffer.from(content, 'utf8')]),
  };
}

describe('accessRulesStore', () => {
  let client: MockClient;
  let storage: ReturnType<typeof createMockStorage>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    client = createMockClient();
    storage = createMockStorage(() => client);
  });

  describe('writeRule', () => {
    it('creates with If-None-Match:* when no etag is given, at the canonical-key path', async () => {
      client.upload.mockResolvedValue({ etag: '"etag-new"' });

      const etag = await writeRule(storage, sampleRule, null);

      expect(etag).toBe('"etag-new"');
      // Path is derived from the rule's own source+agentName (canonicalized);
      // callers cannot choose the path.
      expect(storage.getBlockBlobClient).toHaveBeenCalledWith(samplePath);
      const [content, length, options] = client.upload.mock.calls[0];
      expect(Buffer.isBuffer(content)).toBe(true);
      expect(length).toBe((content as Buffer).length);
      expect(options.conditions).toEqual({ ifNoneMatch: '*' });
      expect(options.blobHTTPHeaders).toEqual({
        blobContentType: 'application/json',
      });
      // CRITICAL: never the dedupe-prone AzureBlobStorage.upload().
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it('lands case-variant source/agentName at the same canonical path', async () => {
      client.upload.mockResolvedValue({ etag: '"e"' });

      await writeRule(
        storage,
        {
          ...sampleRule,
          source: sampleRule.source.toUpperCase(),
          agentName: ' FINANCE-BOT ',
        },
        null,
      );

      expect(storage.getBlockBlobClient).toHaveBeenCalledWith(samplePath);
    });

    it('updates with If-Match when an etag is given', async () => {
      client.upload.mockResolvedValue({ etag: '"etag-new"' });

      await writeRule(storage, sampleRule, '"etag-old"');

      const [, , options] = client.upload.mock.calls[0];
      expect(options.conditions).toEqual({ ifMatch: '"etag-old"' });
    });

    it('translates 412 to AgentAccessConflictError without retrying', async () => {
      client.upload.mockRejectedValue({ statusCode: 412 });

      await expect(
        writeRule(storage, sampleRule, '"stale"'),
      ).rejects.toBeInstanceOf(AgentAccessConflictError);
      // 412 is a 4xx — withAzureRetry must not retry it.
      expect(client.upload).toHaveBeenCalledTimes(1);
    });

    it('rethrows non-412 errors untranslated', async () => {
      client.upload.mockRejectedValue({ statusCode: 403 });

      await expect(writeRule(storage, sampleRule, '"e"')).rejects.toEqual({
        statusCode: 403,
      });
    });
  });

  describe('writeConfig', () => {
    it('creates config.json with If-None-Match:* when no etag is given', async () => {
      client.upload.mockResolvedValue({ etag: '"etag-cfg"' });

      const etag = await writeConfig(storage, sampleConfig, null);

      expect(etag).toBe('"etag-cfg"');
      expect(storage.getBlockBlobClient).toHaveBeenCalledWith(
        AGENT_ACCESS_CONFIG_PATH,
      );
      const [, , options] = client.upload.mock.calls[0];
      expect(options.conditions).toEqual({ ifNoneMatch: '*' });
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it('updates with If-Match and maps 412 to AgentAccessConflictError', async () => {
      client.upload.mockRejectedValueOnce({ statusCode: 412 });

      await expect(
        writeConfig(storage, sampleConfig, '"stale"'),
      ).rejects.toBeInstanceOf(AgentAccessConflictError);
      const [, , options] = client.upload.mock.calls[0];
      expect(options.conditions).toEqual({ ifMatch: '"stale"' });
      expect(client.upload).toHaveBeenCalledTimes(1);
    });
  });

  describe('deleteRule', () => {
    it('deletes with an If-Match condition and returns true', async () => {
      client.delete.mockResolvedValue({});

      await expect(deleteRule(storage, sampleKey, '"etag-1"')).resolves.toBe(
        true,
      );
      expect(storage.getBlockBlobClient).toHaveBeenCalledWith(samplePath);
      expect(client.delete).toHaveBeenCalledWith({
        conditions: { ifMatch: '"etag-1"' },
      });
    });

    it('returns false when the blob is already absent (404)', async () => {
      client.delete.mockRejectedValue({ statusCode: 404 });

      await expect(deleteRule(storage, sampleKey, '"etag-1"')).resolves.toBe(
        false,
      );
    });

    it('translates 412 to AgentAccessConflictError', async () => {
      client.delete.mockRejectedValue({ statusCode: 412 });

      await expect(
        deleteRule(storage, sampleKey, '"stale"'),
      ).rejects.toBeInstanceOf(AgentAccessConflictError);
      expect(client.delete).toHaveBeenCalledTimes(1);
    });
  });

  describe('writeHistoryEntry', () => {
    it('writes immutably (If-None-Match:*) at the key-hash + timestamp path', async () => {
      client.upload.mockResolvedValue({ etag: '"e"' });

      await writeHistoryEntry(storage, sampleHistoryEntry);

      expect(storage.getBlockBlobClient).toHaveBeenCalledWith(
        historyBlobPath(sampleKey, sampleHistoryEntry.updatedAt),
      );
      const [, , options] = client.upload.mock.calls[0];
      expect(options.conditions).toEqual({ ifNoneMatch: '*' });
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it('treats 412 (entry already landed) as idempotent success', async () => {
      client.upload.mockRejectedValue({ statusCode: 412 });

      await expect(
        writeHistoryEntry(storage, sampleHistoryEntry),
      ).resolves.toBeUndefined();
      expect(client.upload).toHaveBeenCalledTimes(1);
    });

    it('rethrows non-412 errors', async () => {
      client.upload.mockRejectedValue({ statusCode: 403 });

      await expect(
        writeHistoryEntry(storage, sampleHistoryEntry),
      ).rejects.toEqual({ statusCode: 403 });
    });
  });

  describe('readRule', () => {
    it('returns the parsed rule with its etag', async () => {
      client.download.mockResolvedValue(
        downloadResponseFor(JSON.stringify(sampleRule), '"etag-7"'),
      );

      const result = await readRule(storage, sampleKey);

      expect(storage.getBlockBlobClient).toHaveBeenCalledWith(samplePath);
      expect(result).toEqual({ rule: sampleRule, etag: '"etag-7"' });
    });

    it('returns null on 404', async () => {
      client.download.mockRejectedValue({ statusCode: 404 });

      await expect(readRule(storage, sampleKey)).resolves.toBeNull();
    });

    it('throws on a malformed rule blob', async () => {
      client.download.mockResolvedValue(
        downloadResponseFor(JSON.stringify({ version: 1 })),
      );

      await expect(readRule(storage, sampleKey)).rejects.toThrow(
        /Malformed agent access rule blob/,
      );
    });
  });

  describe('readConfig', () => {
    it('returns the parsed config with its etag', async () => {
      client.download.mockResolvedValue(
        downloadResponseFor(JSON.stringify(sampleConfig), '"etag-cfg"'),
      );

      await expect(readConfig(storage)).resolves.toEqual({
        config: sampleConfig,
        etag: '"etag-cfg"',
      });
      expect(storage.getBlockBlobClient).toHaveBeenCalledWith(
        AGENT_ACCESS_CONFIG_PATH,
      );
    });

    it('returns null when no config.json exists', async () => {
      client.download.mockRejectedValue({ statusCode: 404 });

      await expect(readConfig(storage)).resolves.toBeNull();
    });
  });

  describe('listAllRules', () => {
    function storageWithBlobs(
      blobs: Record<string, { content: string; etag?: string } | 404>,
    ) {
      const perPathStorage = createMockStorage((path) => {
        const entry = blobs[path];
        const pathClient = createMockClient();
        if (entry === 404 || entry === undefined) {
          pathClient.download.mockRejectedValue({ statusCode: 404 });
        } else {
          pathClient.download.mockResolvedValue(
            downloadResponseFor(entry.content, entry.etag ?? '"etag-1"'),
          );
        }
        return pathClient;
      });
      vi.mocked(perPathStorage.listBlobs).mockResolvedValue(Object.keys(blobs));
      return perPathStorage;
    }

    it('lists by prefix and returns parsed rules keyed canonically', async () => {
      const otherRule: AgentAccessRule = {
        ...sampleRule,
        agentName: 'hr-bot',
        access: {
          type: 'public',
          allowDomains: [],
          allowUsers: [],
          allowGroups: [],
        },
      };
      const otherKey = canonicalAgentKey(otherRule.source, otherRule.agentName);
      const listStorage = storageWithBlobs({
        [samplePath]: { content: JSON.stringify(sampleRule), etag: '"e1"' },
        [ruleBlobPath(otherKey)]: {
          content: JSON.stringify(otherRule),
          etag: '"e2"',
        },
      });

      const rules = await listAllRules(listStorage);

      expect(listStorage.listBlobs).toHaveBeenCalledWith(
        AGENT_ACCESS_RULES_PREFIX,
      );
      expect(rules).toHaveLength(2);
      expect(rules).toContainEqual({
        canonicalKey: sampleKey,
        blobPath: samplePath,
        rule: sampleRule,
        etag: '"e1"',
      });
      expect(rules).toContainEqual({
        canonicalKey: otherKey,
        blobPath: ruleBlobPath(otherKey),
        rule: otherRule,
        etag: '"e2"',
      });
    });

    // SECURITY (fail closed): a malformed blob must fail the whole listing.
    // A silent skip would make a corrupted restricted rule vanish and — under
    // deny-list semantics — open the agent to everyone. Throwing lets
    // refresh() keep the last-known-good ruleset (or fail closed on cold
    // start) instead.
    it('throws (after logging) on a blob with invalid JSON — never fails open', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const listStorage = storageWithBlobs({
        [`${AGENT_ACCESS_RULES_PREFIX}garbage.json`]: { content: 'not-json{' },
        [samplePath]: { content: JSON.stringify(sampleRule) },
      });

      await expect(listAllRules(listStorage)).rejects.toThrow(/invalid JSON/);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('invalid JSON'),
      );
    });

    it('throws (after logging) on a schema-invalid blob — never fails open', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const listStorage = storageWithBlobs({
        [`${AGENT_ACCESS_RULES_PREFIX}bad.json`]: {
          content: JSON.stringify({ version: 1, source: 'x' }),
        },
        [samplePath]: { content: JSON.stringify(sampleRule) },
      });

      await expect(listAllRules(listStorage)).rejects.toThrow(
        /Malformed agent access rule blob/,
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('malformed rule blob'),
      );
    });

    it('throws (after logging) when the blob name does not match its content-derived key hash', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      // Valid rule content, but hand-placed at another key's path.
      const listStorage = storageWithBlobs({
        [ruleBlobPath(canonicalAgentKey(SOURCE, 'some-other-agent'))]: {
          content: JSON.stringify(sampleRule),
        },
      });

      await expect(listAllRules(listStorage)).rejects.toThrow(
        /does not match its content's canonical key/,
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('does not match'),
      );
    });

    it('silently skips ONLY blobs deleted between list and get (404)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const listStorage = storageWithBlobs({
        [`${AGENT_ACCESS_RULES_PREFIX}gone.json`]: 404,
        [samplePath]: { content: JSON.stringify(sampleRule) },
      });

      const rules = await listAllRules(listStorage);

      expect(rules).toHaveLength(1);
      expect(rules[0].canonicalKey).toBe(sampleKey);
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });
});
