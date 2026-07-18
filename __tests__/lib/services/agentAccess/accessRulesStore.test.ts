import {
  AgentAccessConflictError,
  deletePromptAgent,
  deleteRule,
  listAllPromptAgents,
  listAllRules,
  readConfig,
  readPromptAgent,
  readRule,
  writeConfig,
  writeHistoryEntry,
  writePromptAgent,
  writePromptAgentHistoryEntry,
  writeRule,
} from '@/lib/services/agentAccess/accessRulesStore';
import {
  AGENT_ACCESS_CONFIG_PATH,
  AGENT_ACCESS_PROMPT_AGENTS_PREFIX,
  AGENT_ACCESS_RULES_PREFIX,
  AgentAccessConfig,
  AgentAccessHistoryEntry,
  AgentAccessRule,
  PROMPT_AGENT_SOURCE,
  PromptAgent,
  PromptAgentHistoryEntry,
  canonicalAgentKey,
  historyBlobPath,
  promptAgentBlobPath,
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

const samplePromptAgent: PromptAgent = {
  version: 1,
  id: 'prompt-abc123def456',
  name: 'Finance Helper',
  description: 'Answers finance questions',
  systemPrompt: 'You are a finance helper.',
  modelId: 'gpt-5.2-chat',
  createdBy: 'admin@example.com',
  createdAt: '2026-07-17T00:00:00.000Z',
  updatedBy: 'admin@example.com',
  updatedAt: '2026-07-17T00:00:00.000Z',
};
const samplePromptAgentKey = canonicalAgentKey(
  PROMPT_AGENT_SOURCE,
  samplePromptAgent.id,
);
const samplePromptAgentPath = promptAgentBlobPath(samplePromptAgent.id);

const samplePromptAgentHistoryEntry: PromptAgentHistoryEntry = {
  version: 1,
  canonicalKey: samplePromptAgentKey,
  action: 'upsert',
  promptAgent: samplePromptAgent,
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

  describe('writePromptAgent', () => {
    it('creates with If-None-Match:* when no etag is given, at the id-derived path', async () => {
      client.upload.mockResolvedValue({ etag: '"etag-new"' });

      const etag = await writePromptAgent(storage, samplePromptAgent, null);

      expect(etag).toBe('"etag-new"');
      // Path is derived from the record's own id; callers cannot choose it.
      expect(storage.getBlockBlobClient).toHaveBeenCalledWith(
        samplePromptAgentPath,
      );
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

    it('updates with If-Match when an etag is given', async () => {
      client.upload.mockResolvedValue({ etag: '"etag-new"' });

      await writePromptAgent(storage, samplePromptAgent, '"etag-old"');

      const [, , options] = client.upload.mock.calls[0];
      expect(options.conditions).toEqual({ ifMatch: '"etag-old"' });
    });

    it('translates 412 to AgentAccessConflictError without retrying', async () => {
      client.upload.mockRejectedValue({ statusCode: 412 });

      await expect(
        writePromptAgent(storage, samplePromptAgent, '"stale"'),
      ).rejects.toBeInstanceOf(AgentAccessConflictError);
      // 412 is a 4xx — withAzureRetry must not retry it.
      expect(client.upload).toHaveBeenCalledTimes(1);
    });

    it('rethrows non-412 errors untranslated', async () => {
      client.upload.mockRejectedValue({ statusCode: 403 });

      await expect(
        writePromptAgent(storage, samplePromptAgent, '"e"'),
      ).rejects.toEqual({ statusCode: 403 });
    });
  });

  describe('deletePromptAgent', () => {
    it('deletes with an If-Match condition and returns true', async () => {
      client.delete.mockResolvedValue({});

      await expect(
        deletePromptAgent(storage, samplePromptAgent.id, '"etag-1"'),
      ).resolves.toBe(true);
      expect(storage.getBlockBlobClient).toHaveBeenCalledWith(
        samplePromptAgentPath,
      );
      expect(client.delete).toHaveBeenCalledWith({
        conditions: { ifMatch: '"etag-1"' },
      });
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it('returns false when the blob is already absent (404)', async () => {
      client.delete.mockRejectedValue({ statusCode: 404 });

      await expect(
        deletePromptAgent(storage, samplePromptAgent.id, '"etag-1"'),
      ).resolves.toBe(false);
    });

    it('translates 412 to AgentAccessConflictError without retrying', async () => {
      client.delete.mockRejectedValue({ statusCode: 412 });

      await expect(
        deletePromptAgent(storage, samplePromptAgent.id, '"stale"'),
      ).rejects.toBeInstanceOf(AgentAccessConflictError);
      expect(client.delete).toHaveBeenCalledTimes(1);
    });
  });

  describe('writePromptAgentHistoryEntry', () => {
    it('writes immutably (If-None-Match:*) at the key-hash + timestamp path', async () => {
      client.upload.mockResolvedValue({ etag: '"e"' });

      await writePromptAgentHistoryEntry(
        storage,
        samplePromptAgentHistoryEntry,
      );

      expect(storage.getBlockBlobClient).toHaveBeenCalledWith(
        historyBlobPath(
          samplePromptAgentKey,
          samplePromptAgentHistoryEntry.updatedAt,
        ),
      );
      const [, , options] = client.upload.mock.calls[0];
      expect(options.conditions).toEqual({ ifNoneMatch: '*' });
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it('treats 412 (entry already landed) as idempotent success', async () => {
      client.upload.mockRejectedValue({ statusCode: 412 });

      await expect(
        writePromptAgentHistoryEntry(storage, samplePromptAgentHistoryEntry),
      ).resolves.toBeUndefined();
      expect(client.upload).toHaveBeenCalledTimes(1);
    });

    it('rethrows non-412 errors', async () => {
      client.upload.mockRejectedValue({ statusCode: 403 });

      await expect(
        writePromptAgentHistoryEntry(storage, samplePromptAgentHistoryEntry),
      ).rejects.toEqual({ statusCode: 403 });
    });
  });

  describe('readPromptAgent', () => {
    it('returns the parsed record with its etag', async () => {
      client.download.mockResolvedValue(
        downloadResponseFor(JSON.stringify(samplePromptAgent), '"etag-7"'),
      );

      const result = await readPromptAgent(storage, samplePromptAgent.id);

      expect(storage.getBlockBlobClient).toHaveBeenCalledWith(
        samplePromptAgentPath,
      );
      expect(result).toEqual({ agent: samplePromptAgent, etag: '"etag-7"' });
    });

    it('returns null on 404', async () => {
      client.download.mockRejectedValue({ statusCode: 404 });

      await expect(
        readPromptAgent(storage, samplePromptAgent.id),
      ).resolves.toBeNull();
    });

    it('throws on a malformed prompt-agent blob', async () => {
      client.download.mockResolvedValue(
        downloadResponseFor(JSON.stringify({ version: 1 })),
      );

      await expect(
        readPromptAgent(storage, samplePromptAgent.id),
      ).rejects.toThrow(/Malformed prompt agent blob/);
    });
  });

  describe('listAllPromptAgents', () => {
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

    it('lists by the prompt-agents prefix and returns records keyed canonically', async () => {
      const otherAgent: PromptAgent = {
        ...samplePromptAgent,
        id: 'prompt-fed654cba321',
        name: 'HR Helper',
      };
      const listStorage = storageWithBlobs({
        [samplePromptAgentPath]: {
          content: JSON.stringify(samplePromptAgent),
          etag: '"e1"',
        },
        [promptAgentBlobPath(otherAgent.id)]: {
          content: JSON.stringify(otherAgent),
          etag: '"e2"',
        },
      });

      const agents = await listAllPromptAgents(listStorage);

      expect(listStorage.listBlobs).toHaveBeenCalledWith(
        AGENT_ACCESS_PROMPT_AGENTS_PREFIX,
      );
      expect(agents).toHaveLength(2);
      expect(agents).toContainEqual({
        canonicalKey: samplePromptAgentKey,
        blobPath: samplePromptAgentPath,
        agent: samplePromptAgent,
        etag: '"e1"',
      });
      expect(agents).toContainEqual({
        canonicalKey: canonicalAgentKey(PROMPT_AGENT_SOURCE, otherAgent.id),
        blobPath: promptAgentBlobPath(otherAgent.id),
        agent: otherAgent,
        etag: '"e2"',
      });
    });

    // Fail closed like listAllRules: a silently-skipped persona would let a
    // stale/corrupt record vanish without any operator signal, and refresh()
    // relies on the throw to keep the last-known-good snapshot.
    it('throws (after logging) on a blob with invalid JSON', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const listStorage = storageWithBlobs({
        [`${AGENT_ACCESS_PROMPT_AGENTS_PREFIX}garbage.json`]: {
          content: 'not-json{',
        },
        [samplePromptAgentPath]: { content: JSON.stringify(samplePromptAgent) },
      });

      await expect(listAllPromptAgents(listStorage)).rejects.toThrow(
        /invalid JSON/,
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('invalid JSON'),
      );
    });

    it('throws (after logging) on a schema-invalid blob', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const listStorage = storageWithBlobs({
        [`${AGENT_ACCESS_PROMPT_AGENTS_PREFIX}bad.json`]: {
          content: JSON.stringify({ version: 1, id: 'prompt-x' }),
        },
        [samplePromptAgentPath]: { content: JSON.stringify(samplePromptAgent) },
      });

      await expect(listAllPromptAgents(listStorage)).rejects.toThrow(
        /Malformed prompt agent blob/,
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('malformed prompt-agent blob'),
      );
    });

    it("throws (after logging) when the blob name does not match its content's id", async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      // Valid record content, but hand-placed at another id's path.
      const listStorage = storageWithBlobs({
        [promptAgentBlobPath('prompt-other000000')]: {
          content: JSON.stringify(samplePromptAgent),
        },
      });

      await expect(listAllPromptAgents(listStorage)).rejects.toThrow(
        /does not match its content's id/,
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('does not match'),
      );
    });

    it('silently skips ONLY blobs deleted between list and get (404)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const listStorage = storageWithBlobs({
        [`${AGENT_ACCESS_PROMPT_AGENTS_PREFIX}gone.json`]: 404,
        [samplePromptAgentPath]: { content: JSON.stringify(samplePromptAgent) },
      });

      const agents = await listAllPromptAgents(listStorage);

      expect(agents).toHaveLength(1);
      expect(agents[0].canonicalKey).toBe(samplePromptAgentKey);
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });
});
