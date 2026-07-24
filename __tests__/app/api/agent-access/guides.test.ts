import { NextRequest } from 'next/server';

import {
  StoredGuide,
  createAgentAccessBlobStorage,
  deleteGuide,
  listAllGuides,
  readConfig,
  readGuide,
  writeConfig,
  writeGuide,
  writeGuideHistoryEntry,
} from '@/lib/services/agentAccess/accessRulesStore';
import {
  AgentAccessConfig,
  GUIDE_SOURCE,
  Guide,
  canonicalAgentKey,
  guideBlobPath,
} from '@/lib/services/agentAccess/types';

import { MAX_GUIDE_BODY_CHARS } from '@/lib/utils/shared/review/guideCriteria';

import { parseJsonResponse } from '../helpers';

import { DELETE, GET, POST, PUT } from '@/app/api/agent-access/guides/route';
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
// the blob accessors — same pattern as the connectors route tests.
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
      listAllGuides: vi.fn(),
      readGuide: vi.fn(),
      writeGuide: vi.fn(),
      deleteGuide: vi.fn(),
      writeGuideHistoryEntry: vi.fn(),
      readConfig: vi.fn(),
      writeConfig: vi.fn(),
    };
  },
);

const GUIDE_ID = 'guide-abc123def456';
const ETAG = '"etag-1"';

function makeGuide(overrides: Partial<Guide> = {}): Guide {
  return {
    version: 1,
    id: GUIDE_ID,
    kind: 'style',
    name: 'Nairobi French Style Guide',
    description: '',
    languages: ['French'],
    body: '# Style rules\n\nUse the imperative.',
    workflows: ['document', 'translation'],
    createdBy: 'global@example.com',
    createdAt: '2026-07-23T00:00:00.000Z',
    updatedBy: 'global@example.com',
    updatedAt: '2026-07-23T00:00:00.000Z',
    ...overrides,
  };
}

function stored(guide: Guide): StoredGuide {
  return {
    canonicalKey: canonicalAgentKey(GUIDE_SOURCE, guide.id),
    blobPath: guideBlobPath(guide.id),
    guide,
    etag: ETAG,
  };
}

function postRequest(body: unknown): NextRequest {
  return new NextRequest('https://app.example.com/api/agent-access/guides', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function putRequest(body: unknown, ifMatch: string | null = ETAG): NextRequest {
  return new NextRequest('https://app.example.com/api/agent-access/guides', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: ifMatch === null ? {} : { 'if-match': ifMatch },
  });
}

function deleteRequest(id: string, ifMatch: string | null = ETAG): NextRequest {
  return new NextRequest(
    `https://app.example.com/api/agent-access/guides?id=${encodeURIComponent(id)}`,
    {
      method: 'DELETE',
      headers: ifMatch === null ? {} : { 'if-match': ifMatch },
    },
  );
}

const validBody = {
  name: 'Nairobi French Style Guide',
  kind: 'style',
  body: '# Style rules\n\nUse the imperative.',
  workflows: ['document'],
};

const emptyConfig: AgentAccessConfig = {
  version: 1,
  localAdmins: [],
  updatedBy: 'global@example.com',
  updatedAt: '2026-07-23T00:00:00.000Z',
};

describe('/api/agent-access/guides', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.AGENT_ACCESS_CONTROL_ENABLED = true;
    serviceIsEnabled.mockReturnValue(true);
    serviceGetSnapshot.mockReturnValue({ config: emptyConfig });
    mockAuth.mockResolvedValue({
      user: { id: 'u1', mail: 'global@example.com' },
    });
    vi.mocked(createAgentAccessBlobStorage).mockReturnValue({} as never);
    vi.mocked(listAllGuides).mockResolvedValue([]);
    vi.mocked(readConfig).mockResolvedValue({
      config: emptyConfig,
      etag: '"cfg"',
    });
    vi.mocked(writeGuide).mockResolvedValue(ETAG);
    vi.mocked(deleteGuide).mockResolvedValue(true);
    vi.mocked(writeGuideHistoryEntry).mockResolvedValue(undefined);
  });

  describe('gating', () => {
    it('404s for everyone while the feature is disabled', async () => {
      serviceIsEnabled.mockReturnValue(false);

      expect((await GET()).status).toBe(404);
      expect((await POST(postRequest(validBody))).status).toBe(404);
      expect(
        (await PUT(putRequest({ ...validBody, id: GUIDE_ID }))).status,
      ).toBe(404);
      expect((await DELETE(deleteRequest(GUIDE_ID))).status).toBe(404);
    });

    it('401s an unauthenticated caller', async () => {
      mockAuth.mockResolvedValue(null);

      expect((await GET()).status).toBe(401);
      expect((await POST(postRequest(validBody))).status).toBe(401);
    });

    it('403s an authenticated non-admin', async () => {
      mockAuth.mockResolvedValue({
        user: { id: 'u2', mail: 'nobody@example.com' },
      });

      expect((await GET()).status).toBe(403);
      expect((await POST(postRequest(validBody))).status).toBe(403);
    });

    it('403s a session without a mail claim', async () => {
      mockAuth.mockResolvedValue({ user: { id: 'u3' } });

      expect((await POST(postRequest(validBody))).status).toBe(403);
    });
  });

  describe('validation', () => {
    it('rejects a body over the storage cap', async () => {
      const response = await POST(
        postRequest({
          ...validBody,
          body: 'x'.repeat(MAX_GUIDE_BODY_CHARS + 1),
        }),
      );
      expect(response.status).toBe(400);
    });

    it('accepts a body exactly at the cap', async () => {
      const response = await POST(
        postRequest({ ...validBody, body: 'x'.repeat(MAX_GUIDE_BODY_CHARS) }),
      );
      expect(response.status).toBe(200);
    });

    it('rejects an unknown kind and an empty workflows list', async () => {
      expect(
        (await POST(postRequest({ ...validBody, kind: 'grammar' }))).status,
      ).toBe(400);
      expect(
        (await POST(postRequest({ ...validBody, workflows: [] }))).status,
      ).toBe(400);
    });

    it.each(['structure', 'tone'])(
      'rejects a %s guide offered to the translation workflow',
      async (kind) => {
        const response = await POST(
          postRequest({
            ...validBody,
            kind,
            workflows: ['document', 'translation'],
          }),
        );
        const parsed = await parseJsonResponse(response);
        expect(response.status).toBe(400);
        expect(parsed.error).toContain('document workflow');
      },
    );

    it.each(['structure', 'tone'])(
      'accepts a document-only %s guide',
      async (kind) => {
        const response = await POST(
          postRequest({ ...validBody, kind, workflows: ['document'] }),
        );
        expect(response.status).toBe(200);
      },
    );
  });

  describe('POST', () => {
    it('creates with a server-generated guide-<hex> id and CAS create condition', async () => {
      const response = await POST(postRequest(validBody));
      const parsed = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(parsed.data.guide.id).toMatch(/^guide-[a-f0-9]{12}$/);
      // null ifMatch = If-None-Match:* creation-only write.
      expect(vi.mocked(writeGuide)).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ version: 1, kind: 'style' }),
        null,
      );
      expect(serviceInvalidate).toHaveBeenCalled();
    });

    it('rolls back the blob when a local admin create cannot record delegation', async () => {
      mockAuth.mockResolvedValue({
        user: { id: 'u4', mail: 'local@example.com' },
      });
      serviceGetSnapshot.mockReturnValue({
        config: {
          ...emptyConfig,
          localAdmins: [{ email: 'local@example.com', agentKeys: [] }],
        },
      });
      // Delegation CAS loop reads config then writes; make the write fail
      // persistently so delegateToCreator gives up.
      vi.mocked(writeConfig).mockRejectedValue(new Error('storage down'));

      const response = await POST(postRequest(validBody));

      expect(response.status).toBe(503);
      expect(vi.mocked(deleteGuide)).toHaveBeenCalled();
    });
  });

  describe('PUT', () => {
    beforeEach(() => {
      vi.mocked(readGuide).mockResolvedValue({
        guide: makeGuide(),
        etag: ETAG,
      });
    });

    it('requires a quoted strong If-Match etag', async () => {
      const response = await PUT(
        putRequest({ ...validBody, id: GUIDE_ID }, null),
      );
      expect(response.status).toBe(400);
    });

    it('rejects an id that is not a server-generated guide id', async () => {
      const response = await PUT(
        putRequest({ ...validBody, id: '../rules/x' }),
      );
      expect(response.status).toBe(400);
    });

    it('404s when the guide no longer exists', async () => {
      vi.mocked(readGuide).mockResolvedValue(null);
      const response = await PUT(putRequest({ ...validBody, id: GUIDE_ID }));
      expect(response.status).toBe(404);
    });

    it('preserves id/createdBy/createdAt and maps CAS conflicts to 409', async () => {
      const response = await PUT(
        putRequest({ ...validBody, name: 'Renamed', id: GUIDE_ID }),
      );
      const parsed = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(parsed.data.guide.id).toBe(GUIDE_ID);
      expect(parsed.data.guide.createdBy).toBe('global@example.com');
      expect(parsed.data.guide.name).toBe('Renamed');

      const { AgentAccessConflictError } = await vi.importActual<
        typeof import('@/lib/services/agentAccess/accessRulesStore')
      >('@/lib/services/agentAccess/accessRulesStore');
      vi.mocked(writeGuide).mockRejectedValue(new AgentAccessConflictError());
      const conflict = await PUT(putRequest({ ...validBody, id: GUIDE_ID }));
      expect(conflict.status).toBe(409);
    });

    it('403s a local admin without this guide key', async () => {
      mockAuth.mockResolvedValue({
        user: { id: 'u4', mail: 'local@example.com' },
      });
      serviceGetSnapshot.mockReturnValue({
        config: {
          ...emptyConfig,
          localAdmins: [
            { email: 'local@example.com', agentKeys: ['guide::guide-other'] },
          ],
        },
      });

      const response = await PUT(putRequest({ ...validBody, id: GUIDE_ID }));
      expect(response.status).toBe(403);
    });
  });

  describe('DELETE', () => {
    it('404s when already gone (idempotent end state)', async () => {
      vi.mocked(deleteGuide).mockResolvedValue(false);
      const response = await DELETE(deleteRequest(GUIDE_ID));
      expect(response.status).toBe(404);
    });

    it('deletes with If-Match and writes a tombstone history entry', async () => {
      const response = await DELETE(deleteRequest(GUIDE_ID));
      expect(response.status).toBe(200);
      expect(vi.mocked(deleteGuide)).toHaveBeenCalledWith(
        expect.anything(),
        GUIDE_ID,
        ETAG,
      );
      expect(vi.mocked(writeGuideHistoryEntry)).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'delete', guide: null }),
      );
    });
  });

  describe('GET', () => {
    it('lists full records with etags for admins', async () => {
      vi.mocked(listAllGuides).mockResolvedValue([stored(makeGuide())]);

      const body = await parseJsonResponse(await GET());
      expect(body.data.guides).toHaveLength(1);
      expect(body.data.guides[0].etag).toBe(ETAG);
      expect(body.data.guides[0].guide.body).toContain('Style rules');
      expect(body.data.guidesUnavailable).toBe(false);
    });

    it('filters to delegated keys for local admins', async () => {
      mockAuth.mockResolvedValue({
        user: { id: 'u4', mail: 'local@example.com' },
      });
      const mine = makeGuide();
      const other = makeGuide({ id: 'guide-fff000fff000', name: 'Other' });
      vi.mocked(listAllGuides).mockResolvedValue([stored(mine), stored(other)]);
      vi.mocked(readConfig).mockResolvedValue({
        config: {
          ...emptyConfig,
          localAdmins: [
            {
              email: 'local@example.com',
              agentKeys: [canonicalAgentKey(GUIDE_SOURCE, mine.id)],
            },
          ],
        },
        etag: '"cfg"',
      });

      const body = await parseJsonResponse(await GET());
      expect(body.data.guides).toHaveLength(1);
      expect(body.data.guides[0].guide.id).toBe(mine.id);
    });

    it('flags an outage instead of serving an empty list as truth', async () => {
      vi.mocked(listAllGuides).mockRejectedValue(new Error('storage down'));
      vi.mocked(readConfig).mockRejectedValue(new Error('storage down'));

      const response = await GET();
      const body = await parseJsonResponse(response);
      expect(response.status).toBe(200);
      expect(body.data.guides).toEqual([]);
      expect(body.data.guidesUnavailable).toBe(true);
    });
  });
});
