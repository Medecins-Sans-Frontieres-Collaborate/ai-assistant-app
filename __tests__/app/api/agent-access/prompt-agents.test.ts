import { NextRequest } from 'next/server';

import {
  StoredPromptAgent,
  createAgentAccessBlobStorage,
  deletePromptAgent,
  listAllPromptAgents,
  readConfig,
  readPromptAgent,
  writeConfig,
  writePromptAgent,
  writePromptAgentHistoryEntry,
} from '@/lib/services/agentAccess/accessRulesStore';
// Real error class for instanceof checks in the route.
import { AgentAccessConflictError } from '@/lib/services/agentAccess/accessRulesStore';
import {
  AgentAccessConfig,
  PROMPT_AGENT_SOURCE,
  PromptAgent,
  canonicalAgentKey,
  promptAgentBlobPath,
} from '@/lib/services/agentAccess/types';

import { OpenAIModelID } from '@/types/openai';

import { parseJsonResponse } from '../helpers';

import {
  DELETE,
  GET,
  POST,
  PUT,
} from '@/app/api/agent-access/prompt-agents/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const serviceIsEnabled = vi.hoisted(() => vi.fn());
const serviceEnsureFresh = vi.hoisted(() => vi.fn());
const serviceGetSnapshot = vi.hoisted(() => vi.fn());
const serviceInvalidate = vi.hoisted(() => vi.fn());
const mockEnv = vi.hoisted(() => ({
  AGENT_ACCESS_CONTROL_ENABLED: true,
  AGENT_ACCESS_ADMINS: 'global@example.com',
}));

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/config/environment', () => ({ env: mockEnv }));
vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: {
    getInstance: () => ({
      isEnabled: serviceIsEnabled,
      ensureFresh: serviceEnsureFresh,
      getSnapshot: serviceGetSnapshot,
      invalidate: serviceInvalidate,
    }),
  },
}));

// Keep AgentAccessConflictError (instanceof mapping to 409) real; mock only
// the blob accessors — same pattern as the rules route tests.
vi.mock(
  '@/lib/services/agentAccess/accessRulesStore',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@/lib/services/agentAccess/accessRulesStore')
      >();
    return {
      ...actual,
      createAgentAccessBlobStorage: vi.fn(),
      listAllPromptAgents: vi.fn(),
      readPromptAgent: vi.fn(),
      writePromptAgent: vi.fn(),
      deletePromptAgent: vi.fn(),
      writePromptAgentHistoryEntry: vi.fn(),
      readConfig: vi.fn(),
      writeConfig: vi.fn(),
    };
  },
);

const MODEL_ID = OpenAIModelID.GPT_5_2_CHAT;

const AGENT_ID_A = 'prompt-aaaa11112222';
const AGENT_ID_B = 'prompt-bbbb33334444';
const KEY_A = canonicalAgentKey(PROMPT_AGENT_SOURCE, AGENT_ID_A);
const KEY_B = canonicalAgentKey(PROMPT_AGENT_SOURCE, AGENT_ID_B);

const GLOBAL_SESSION = { user: { id: 'u-global', mail: 'global@example.com' } };
const LOCAL_SESSION = { user: { id: 'u-local', mail: 'local@example.com' } };
// Local admin with NO delegated keys — must still be able to create.
const ZERO_KEY_SESSION = {
  user: { id: 'u-zero', mail: 'zerokey@example.com' },
};
const USER_SESSION = { user: { id: 'u-plain', mail: 'user@example.com' } };

function makeAgent(overrides: Partial<PromptAgent> = {}): PromptAgent {
  return {
    version: 1,
    id: AGENT_ID_A,
    name: 'Legal Advisor',
    description: 'Reviews contracts',
    systemPrompt: 'You are a meticulous legal advisor.',
    modelId: MODEL_ID,
    createdBy: 'global@example.com',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedBy: 'global@example.com',
    updatedAt: '2026-07-17T00:00:00.000Z',
    ...overrides,
  };
}

function storedAgent(agent: PromptAgent, etag: string): StoredPromptAgent {
  return {
    canonicalKey: canonicalAgentKey(PROMPT_AGENT_SOURCE, agent.id),
    blobPath: promptAgentBlobPath(agent.id),
    agent,
    etag,
  };
}

// Local admin is delegated KEY_A only (entry deliberately un-normalized to
// exercise the canonicalized comparison); the zero-key admin has membership
// but no delegated keys.
const CONFIG: AgentAccessConfig = {
  version: 1,
  localAdmins: [
    { email: ' Local@Example.com ', agentKeys: [` ${KEY_A.toUpperCase()} `] },
    { email: 'zerokey@example.com', agentKeys: [] },
  ],
  updatedBy: 'global@example.com',
  updatedAt: '2026-07-17T00:00:00.000Z',
};

function makeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    rules: [],
    config: CONFIG,
    configEtag: '"cfg-e1"',
    promptAgents: [makeAgent(), makeAgent({ id: AGENT_ID_B, name: 'Other' })],
    rulesUnavailable: false,
    fetchedAt: 1,
    ...overrides,
  };
}

const URL_BASE = 'http://localhost:3000/api/agent-access/prompt-agents';

function postRequest(
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(URL_BASE, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers,
  });
}

function putRequest(
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(URL_BASE, {
    method: 'PUT',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers,
  });
}

function deleteRequest(
  params: Record<string, string>,
  headers: Record<string, string> = {},
): NextRequest {
  const search = new URLSearchParams(params).toString();
  return new NextRequest(`${URL_BASE}?${search}`, {
    method: 'DELETE',
    headers,
  });
}

const postBody = {
  name: 'Legal Advisor',
  description: 'Reviews contracts',
  systemPrompt: 'You are a meticulous legal advisor.',
  modelId: MODEL_ID,
};

const putBody = { ...postBody, id: AGENT_ID_A };

describe('/api/agent-access/prompt-agents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.AGENT_ACCESS_CONTROL_ENABLED = true;
    mockEnv.AGENT_ACCESS_ADMINS = 'global@example.com';
    serviceIsEnabled.mockReturnValue(true);
    serviceEnsureFresh.mockResolvedValue(undefined);
    serviceGetSnapshot.mockReturnValue(makeSnapshot());
    mockAuth.mockResolvedValue(GLOBAL_SESSION);
    vi.mocked(createAgentAccessBlobStorage).mockReturnValue({} as any);
    // GET reads storage directly — give it fresher etags than the snapshot
    // so tests can prove which source the response came from.
    vi.mocked(listAllPromptAgents).mockResolvedValue([
      storedAgent(makeAgent(), '"fresh-a"'),
      storedAgent(makeAgent({ id: AGENT_ID_B, name: 'Other' }), '"fresh-b"'),
    ]);
    vi.mocked(readConfig).mockResolvedValue({
      config: CONFIG,
      etag: '"cfg-fresh"',
    });
    vi.mocked(readPromptAgent).mockResolvedValue({
      agent: makeAgent(),
      etag: '"e-a"',
    });
    vi.mocked(writePromptAgent).mockResolvedValue('"e-new"');
    vi.mocked(deletePromptAgent).mockResolvedValue(true);
    vi.mocked(writePromptAgentHistoryEntry).mockResolvedValue(undefined);
    vi.mocked(writeConfig).mockResolvedValue('"cfg-e2"');
  });

  describe('GET', () => {
    it('returns 401 when unauthenticated', async () => {
      mockAuth.mockResolvedValue(null);

      const response = await GET();

      expect(response.status).toBe(401);
      expect(listAllPromptAgents).not.toHaveBeenCalled();
    });

    it('returns 404 when disabled — before auth, so nothing leaks to unauthenticated probes', async () => {
      serviceIsEnabled.mockReturnValue(false);
      mockAuth.mockResolvedValue(null);

      const response = await GET();

      expect(response.status).toBe(404);
      expect(mockAuth).not.toHaveBeenCalled();
      expect(listAllPromptAgents).not.toHaveBeenCalled();
    });

    it('returns 403 for a non-admin', async () => {
      mockAuth.mockResolvedValue(USER_SESSION);

      const response = await GET();

      expect(response.status).toBe(403);
    });

    it('reads storage directly and returns FRESH etags, not the stale snapshot', async () => {
      const response = await GET();
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.data.promptAgents).toEqual([
        { canonicalKey: KEY_A, agent: makeAgent(), etag: '"fresh-a"' },
        {
          canonicalKey: KEY_B,
          agent: makeAgent({ id: AGENT_ID_B, name: 'Other' }),
          etag: '"fresh-b"',
        },
      ]);
      expect(data.data.promptAgentsUnavailable).toBe(false);
      expect(typeof data.data.fetchedAt).toBe('number');
      expect(listAllPromptAgents).toHaveBeenCalled();
      expect(readConfig).toHaveBeenCalled();
      // Never consults the cached snapshot for the listing.
      expect(serviceGetSnapshot).not.toHaveBeenCalled();
    });

    it('filters the listing to delegated keys for a local admin (config from storage)', async () => {
      mockAuth.mockResolvedValue(LOCAL_SESSION);

      const response = await GET();
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.data.promptAgents).toHaveLength(1);
      expect(data.data.promptAgents[0].canonicalKey).toBe(KEY_A);
      expect(data.data.promptAgents[0].etag).toBe('"fresh-a"');
    });

    it('returns an empty listing (200, not 403) for a zero-key local admin', async () => {
      mockAuth.mockResolvedValue(ZERO_KEY_SESSION);

      const response = await GET();
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.data.promptAgents).toEqual([]);
    });

    it('reports promptAgentsUnavailable on storage failure instead of a 500', async () => {
      vi.mocked(listAllPromptAgents).mockRejectedValue(new Error('blob down'));

      const response = await GET();
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.data.promptAgents).toEqual([]);
      expect(data.data.promptAgentsUnavailable).toBe(true);
      expect(data.data.fetchedAt).toBeNull();
    });

    it('returns 403 for a local admin when the config could not be read', async () => {
      // Without config there is no proof of delegation — fail closed.
      mockAuth.mockResolvedValue(LOCAL_SESSION);
      vi.mocked(readConfig).mockRejectedValue(new Error('blob down'));

      const response = await GET();

      expect(response.status).toBe(403);
    });
  });

  describe('POST', () => {
    it('returns 401 when unauthenticated', async () => {
      mockAuth.mockResolvedValue(null);

      const response = await POST(postRequest(postBody));

      expect(response.status).toBe(401);
      expect(writePromptAgent).not.toHaveBeenCalled();
    });

    it('returns 404 when disabled — before auth, so nothing leaks to unauthenticated probes', async () => {
      serviceIsEnabled.mockReturnValue(false);
      mockAuth.mockResolvedValue(null);

      const response = await POST(postRequest(postBody));

      expect(response.status).toBe(404);
      expect(mockAuth).not.toHaveBeenCalled();
      expect(writePromptAgent).not.toHaveBeenCalled();
    });

    it('returns 403 when the session has no Graph mail', async () => {
      mockAuth.mockResolvedValue({ user: { id: 'u-x', mail: undefined } });

      const response = await POST(postRequest(postBody));

      expect(response.status).toBe(403);
      expect(writePromptAgent).not.toHaveBeenCalled();
    });

    it('returns 400 on invalid JSON', async () => {
      const response = await POST(postRequest('{not json'));

      expect(response.status).toBe(400);
      expect(writePromptAgent).not.toHaveBeenCalled();
    });

    it.each([
      ['missing name', { ...postBody, name: undefined }],
      ['empty name', { ...postBody, name: '' }],
      ['whitespace-only name', { ...postBody, name: '   ' }],
      ['name over 100 chars', { ...postBody, name: 'x'.repeat(101) }],
      [
        'description over 300 chars',
        { ...postBody, description: 'x'.repeat(301) },
      ],
      ['missing systemPrompt', { ...postBody, systemPrompt: undefined }],
      ['whitespace-only systemPrompt', { ...postBody, systemPrompt: ' \t ' }],
      [
        'systemPrompt over 10000 chars',
        { ...postBody, systemPrompt: 'x'.repeat(10001) },
      ],
      ['missing modelId', { ...postBody, modelId: undefined }],
      ['modelId over 100 chars', { ...postBody, modelId: 'x'.repeat(101) }],
    ])('returns 400 for shape violation: %s', async (_label, body) => {
      const response = await POST(postRequest(body));

      expect(response.status).toBe(400);
      expect(writePromptAgent).not.toHaveBeenCalled();
    });

    it.each([
      ['unknown model id', 'not-a-real-model'],
      ['foundry- agent id', 'foundry-abc123-my-agent'],
      ['org- agent id', 'org-msf_communications'],
      ['custom- agent id', 'custom-123'],
      ['byom- model id', 'byom-1:gpt'],
    ])('returns 400 for invalid modelId: %s', async (_label, modelId) => {
      const response = await POST(postRequest({ ...postBody, modelId }));

      expect(response.status).toBe(400);
      expect(writePromptAgent).not.toHaveBeenCalled();
    });

    it('returns 403 for a non-admin', async () => {
      mockAuth.mockResolvedValue(USER_SESSION);

      const response = await POST(postRequest(postBody));

      expect(response.status).toBe(403);
      expect(writePromptAgent).not.toHaveBeenCalled();
    });

    it('lets a global admin create without any delegation write', async () => {
      const response = await POST(postRequest(postBody));
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      const id = data.data.promptAgent.id;
      expect(id).toMatch(/^prompt-[0-9a-f]{12}$/);
      expect(data.data.canonicalKey).toBe(`prompt-agent::${id}`);
      expect(data.data.etag).toBe('"e-new"');
      expect(data.data.promptAgent).toEqual(
        expect.objectContaining({
          version: 1,
          name: 'Legal Advisor',
          description: 'Reviews contracts',
          systemPrompt: 'You are a meticulous legal advisor.',
          modelId: MODEL_ID,
          createdBy: 'global@example.com',
          updatedBy: 'global@example.com',
        }),
      );
      // Create-only write (null etag → If-None-Match: * in the store).
      expect(writePromptAgent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id, createdBy: 'global@example.com' }),
        null,
      );
      expect(serviceInvalidate).toHaveBeenCalled();
      // Global admins can already edit every key — no delegation write.
      expect(readConfig).not.toHaveBeenCalled();
      expect(writeConfig).not.toHaveBeenCalled();
      expect(writePromptAgentHistoryEntry).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          version: 1,
          canonicalKey: `prompt-agent::${id}`,
          action: 'upsert',
          promptAgent: expect.objectContaining({ id }),
          updatedBy: 'global@example.com',
        }),
      );
    });

    it('lets a ZERO-KEY local admin create and auto-delegates the new key to them', async () => {
      mockAuth.mockResolvedValue(ZERO_KEY_SESSION);

      const response = await POST(postRequest(postBody));
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      const id = data.data.promptAgent.id;
      const key = `prompt-agent::${id}`;
      expect(data.data.canonicalKey).toBe(key);
      expect(writePromptAgent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id, createdBy: 'zerokey@example.com' }),
        null,
      );
      // Delegation is CAS-written against the directly-read config etag, and
      // only the creator's entry gains the key.
      expect(writeConfig).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          version: 1,
          localAdmins: [
            CONFIG.localAdmins[0],
            { email: 'zerokey@example.com', agentKeys: [key] },
          ],
          updatedBy: 'zerokey@example.com',
        }),
        '"cfg-fresh"',
      );
      expect(deletePromptAgent).not.toHaveBeenCalled();
    });

    it('retries the delegation write after a lost CAS race (re-read, then succeed)', async () => {
      mockAuth.mockResolvedValue(ZERO_KEY_SESSION);
      vi.mocked(writeConfig)
        .mockRejectedValueOnce(new AgentAccessConflictError())
        .mockResolvedValueOnce('"cfg-e3"');

      const response = await POST(postRequest(postBody));

      expect(response.status).toBe(200);
      expect(readConfig).toHaveBeenCalledTimes(2);
      expect(writeConfig).toHaveBeenCalledTimes(2);
      expect(deletePromptAgent).not.toHaveBeenCalled();
    });

    it('rolls back the create and returns 503 when delegation keeps losing the CAS', async () => {
      mockAuth.mockResolvedValue(ZERO_KEY_SESSION);
      vi.mocked(writeConfig).mockRejectedValue(new AgentAccessConflictError());

      const response = await POST(postRequest(postBody));
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(503);
      expect(data.error).toContain('rolled back');
      expect(writeConfig).toHaveBeenCalledTimes(3);
      // The just-created blob is deleted with the etag the create returned —
      // a local admin must never own an agent they cannot edit.
      expect(deletePromptAgent).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringMatching(/^prompt-[0-9a-f]{12}$/),
        '"e-new"',
      );
      expect(writePromptAgentHistoryEntry).not.toHaveBeenCalled();
    });

    it('rolls back and returns 503 when the direct config no longer lists the creator', async () => {
      mockAuth.mockResolvedValue(ZERO_KEY_SESSION);
      vi.mocked(readConfig).mockResolvedValue({
        config: { ...CONFIG, localAdmins: [] },
        etag: '"cfg-fresh"',
      });

      const response = await POST(postRequest(postBody));

      expect(response.status).toBe(503);
      expect(writeConfig).not.toHaveBeenCalled();
      expect(deletePromptAgent).toHaveBeenCalled();
    });

    it('maps a lost create CAS race to 409 AGENT_ACCESS_CONFLICT and invalidates the cache', async () => {
      vi.mocked(writePromptAgent).mockRejectedValue(
        new AgentAccessConflictError(),
      );

      const response = await POST(postRequest(postBody));
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(409);
      expect(data.code).toBe('AGENT_ACCESS_CONFLICT');
      expect(serviceInvalidate).toHaveBeenCalled();
    });

    it('does not fail the response when the history append fails', async () => {
      vi.mocked(writePromptAgentHistoryEntry).mockRejectedValue(
        new Error('blob down'),
      );

      const response = await POST(postRequest(postBody));

      expect(response.status).toBe(200);
      expect(serviceInvalidate).toHaveBeenCalled();
    });
  });

  describe('PUT', () => {
    it('returns 401 when unauthenticated', async () => {
      mockAuth.mockResolvedValue(null);

      const response = await PUT(putRequest(putBody, { 'if-match': '"e-a"' }));

      expect(response.status).toBe(401);
      expect(writePromptAgent).not.toHaveBeenCalled();
    });

    it('returns 404 when disabled — before auth, so nothing leaks to unauthenticated probes', async () => {
      serviceIsEnabled.mockReturnValue(false);
      mockAuth.mockResolvedValue(null);

      const response = await PUT(putRequest(putBody, { 'if-match': '"e-a"' }));

      expect(response.status).toBe(404);
      expect(mockAuth).not.toHaveBeenCalled();
      expect(writePromptAgent).not.toHaveBeenCalled();
    });

    it('returns 403 when the session has no Graph mail', async () => {
      mockAuth.mockResolvedValue({ user: { id: 'u-x', mail: undefined } });

      const response = await PUT(putRequest(putBody, { 'if-match': '"e-a"' }));

      expect(response.status).toBe(403);
      expect(writePromptAgent).not.toHaveBeenCalled();
    });

    it('returns 400 on invalid JSON', async () => {
      const response = await PUT(
        putRequest('{not json', { 'if-match': '"e-a"' }),
      );

      expect(response.status).toBe(400);
      expect(writePromptAgent).not.toHaveBeenCalled();
    });

    it('returns 400 when the body has no id', async () => {
      const response = await PUT(putRequest(postBody, { 'if-match': '"e-a"' }));

      expect(response.status).toBe(400);
      expect(writePromptAgent).not.toHaveBeenCalled();
    });

    it('returns 400 for an agent-backed modelId', async () => {
      const response = await PUT(
        putRequest(
          { ...putBody, modelId: 'org-msf_communications' },
          { 'if-match': '"e-a"' },
        ),
      );

      expect(response.status).toBe(400);
      expect(writePromptAgent).not.toHaveBeenCalled();
    });

    it.each([[undefined], ['*'], ['W/"weak"'], ['unquoted']])(
      'requires a quoted strong-ETag If-Match (%s)',
      async (ifMatch) => {
        const response = await PUT(
          putRequest(putBody, ifMatch ? { 'if-match': ifMatch } : {}),
        );

        expect(response.status).toBe(400);
        expect(writePromptAgent).not.toHaveBeenCalled();
      },
    );

    it('returns 403 for a non-admin', async () => {
      mockAuth.mockResolvedValue(USER_SESSION);

      const response = await PUT(putRequest(putBody, { 'if-match': '"e-a"' }));

      expect(response.status).toBe(403);
      expect(writePromptAgent).not.toHaveBeenCalled();
    });

    it('returns 403 for a local admin updating a non-delegated agent', async () => {
      mockAuth.mockResolvedValue(LOCAL_SESSION);

      const response = await PUT(
        putRequest({ ...putBody, id: AGENT_ID_B }, { 'if-match': '"e-b"' }),
      );

      expect(response.status).toBe(403);
      expect(writePromptAgent).not.toHaveBeenCalled();
    });

    it('returns 403 for a zero-key local admin (create-only until delegated)', async () => {
      mockAuth.mockResolvedValue(ZERO_KEY_SESSION);

      const response = await PUT(putRequest(putBody, { 'if-match': '"e-a"' }));

      expect(response.status).toBe(403);
      expect(writePromptAgent).not.toHaveBeenCalled();
    });

    it('lets a local admin update a delegated agent, preserving createdBy/createdAt', async () => {
      mockAuth.mockResolvedValue(LOCAL_SESSION);

      const response = await PUT(
        putRequest(
          { ...putBody, name: 'Updated name', systemPrompt: 'New prompt' },
          { 'if-match': '"e-a"' },
        ),
      );
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.data.canonicalKey).toBe(KEY_A);
      expect(data.data.etag).toBe('"e-new"');
      expect(readPromptAgent).toHaveBeenCalledWith(
        expect.anything(),
        AGENT_ID_A,
      );
      // Immutable fields come from the stored record, not the request.
      expect(writePromptAgent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          version: 1,
          id: AGENT_ID_A,
          name: 'Updated name',
          systemPrompt: 'New prompt',
          createdBy: 'global@example.com',
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedBy: 'local@example.com',
        }),
        '"e-a"',
      );
      expect(serviceInvalidate).toHaveBeenCalled();
      expect(writePromptAgentHistoryEntry).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          canonicalKey: KEY_A,
          action: 'upsert',
          updatedBy: 'local@example.com',
        }),
      );
    });

    it('returns 404 for an unknown id (ids are immutable — PUT never mints)', async () => {
      vi.mocked(readPromptAgent).mockResolvedValue(null);

      const response = await PUT(putRequest(putBody, { 'if-match': '"e-a"' }));

      expect(response.status).toBe(404);
      expect(writePromptAgent).not.toHaveBeenCalled();
    });

    it('maps a lost CAS race to 409 AGENT_ACCESS_CONFLICT and invalidates the cache', async () => {
      vi.mocked(writePromptAgent).mockRejectedValue(
        new AgentAccessConflictError(),
      );

      const response = await PUT(putRequest(putBody, { 'if-match': '"e-a"' }));
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(409);
      expect(data.code).toBe('AGENT_ACCESS_CONFLICT');
      expect(serviceInvalidate).toHaveBeenCalled();
    });
  });

  describe('DELETE', () => {
    const params = { id: AGENT_ID_A };

    it('returns 401 when unauthenticated', async () => {
      mockAuth.mockResolvedValue(null);

      const response = await DELETE(
        deleteRequest(params, { 'if-match': '"e-a"' }),
      );

      expect(response.status).toBe(401);
      expect(deletePromptAgent).not.toHaveBeenCalled();
    });

    it('returns 404 when disabled — before auth, so nothing leaks to unauthenticated probes', async () => {
      serviceIsEnabled.mockReturnValue(false);
      mockAuth.mockResolvedValue(null);

      const response = await DELETE(
        deleteRequest(params, { 'if-match': '"e-a"' }),
      );

      expect(response.status).toBe(404);
      expect(mockAuth).not.toHaveBeenCalled();
      expect(deletePromptAgent).not.toHaveBeenCalled();
    });

    it('returns 400 when the id query param is missing', async () => {
      const response = await DELETE(deleteRequest({}, { 'if-match': '"e-a"' }));

      expect(response.status).toBe(400);
      expect(deletePromptAgent).not.toHaveBeenCalled();
    });

    it.each([[undefined], ['*'], ['W/"weak"'], ['unquoted']])(
      'requires a quoted strong-ETag If-Match (%s)',
      async (ifMatch) => {
        const response = await DELETE(
          deleteRequest(params, ifMatch ? { 'if-match': ifMatch } : {}),
        );

        expect(response.status).toBe(400);
        expect(deletePromptAgent).not.toHaveBeenCalled();
      },
    );

    it('returns 403 for a non-admin', async () => {
      mockAuth.mockResolvedValue(USER_SESSION);

      const response = await DELETE(
        deleteRequest(params, { 'if-match': '"e-a"' }),
      );

      expect(response.status).toBe(403);
      expect(deletePromptAgent).not.toHaveBeenCalled();
    });

    it('returns 403 for a local admin deleting a non-delegated agent', async () => {
      mockAuth.mockResolvedValue(LOCAL_SESSION);

      const response = await DELETE(
        deleteRequest({ id: AGENT_ID_B }, { 'if-match': '"e-b"' }),
      );

      expect(response.status).toBe(403);
      expect(deletePromptAgent).not.toHaveBeenCalled();
    });

    it('lets a local admin delete a delegated agent and writes a tombstone', async () => {
      mockAuth.mockResolvedValue(LOCAL_SESSION);

      const response = await DELETE(
        deleteRequest(params, { 'if-match': '"e-a"' }),
      );
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.data).toEqual({ canonicalKey: KEY_A, deleted: true });
      expect(deletePromptAgent).toHaveBeenCalledWith(
        expect.anything(),
        AGENT_ID_A,
        '"e-a"',
      );
      expect(serviceInvalidate).toHaveBeenCalled();
      expect(writePromptAgentHistoryEntry).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          canonicalKey: KEY_A,
          action: 'delete',
          promptAgent: null,
          updatedBy: 'local@example.com',
        }),
      );
    });

    it('returns 404 when the agent is already absent', async () => {
      vi.mocked(deletePromptAgent).mockResolvedValue(false);

      const response = await DELETE(
        deleteRequest(params, { 'if-match': '"e-a"' }),
      );

      expect(response.status).toBe(404);
      expect(serviceInvalidate).not.toHaveBeenCalled();
      expect(writePromptAgentHistoryEntry).not.toHaveBeenCalled();
    });

    it('maps a lost CAS race to 409 AGENT_ACCESS_CONFLICT and invalidates the cache', async () => {
      vi.mocked(deletePromptAgent).mockRejectedValue(
        new AgentAccessConflictError(),
      );

      const response = await DELETE(
        deleteRequest(params, { 'if-match': '"e-a"' }),
      );
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(409);
      expect(data.code).toBe('AGENT_ACCESS_CONFLICT');
      expect(serviceInvalidate).toHaveBeenCalled();
    });
  });
});
