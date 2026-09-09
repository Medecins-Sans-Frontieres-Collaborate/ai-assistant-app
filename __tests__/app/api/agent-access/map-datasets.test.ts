import { NextRequest } from 'next/server';

import {
  createAgentAccessBlobStorage,
  deleteMapDataset,
  listAllMapDatasetMetas,
  readConfig,
  readMapDataset,
  writeConfig,
  writeMapDataset,
  writeMapDatasetHistoryEntry,
} from '@/lib/services/agentAccess/accessRulesStore';
import {
  AgentAccessConfig,
  MAP_DATASET_SOURCE,
  MapDataset,
  canonicalAgentKey,
  mapDatasetMeta,
  mapDatasetMetaBlobPath,
} from '@/lib/services/agentAccess/types';

import { MAX_DATASET_FEATURES } from '@/lib/utils/shared/geo/mapLimits';

import { parseJsonResponse } from '../helpers';

import {
  DELETE as deleteById,
  GET as getById,
  PUT as putById,
} from '@/app/api/agent-access/map-datasets/[id]/route';
import { GET, POST } from '@/app/api/agent-access/map-datasets/route';
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
      listAllMapDatasetMetas: vi.fn(),
      readMapDataset: vi.fn(),
      writeMapDataset: vi.fn(),
      deleteMapDataset: vi.fn(),
      writeMapDatasetHistoryEntry: vi.fn(),
      readConfig: vi.fn(),
      writeConfig: vi.fn(),
    };
  },
);

const DATASET_ID = 'mapds-abc123def456';
const ETAG = '"etag-1"';

function makeDataset(overrides: Partial<MapDataset> = {}): MapDataset {
  return {
    version: 1,
    id: DATASET_ID,
    name: 'Sahel Presence',
    description: '',
    tags: [],
    features: [
      {
        id: 'f1',
        name: 'Gao',
        description: '',
        lat: 16.27,
        lon: -0.04,
        confidence: 'high',
        confidenceReason: '',
        category: 'office',
      },
    ],
    connections: [],
    sources: [],
    createdBy: 'global@example.com',
    createdAt: '2026-07-23T00:00:00.000Z',
    updatedBy: 'global@example.com',
    updatedAt: '2026-07-23T00:00:00.000Z',
    ...overrides,
  };
}

function feature(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Place ${id}`,
    description: '',
    lat: 10,
    lon: 10,
    confidence: 'high',
    confidenceReason: '',
    category: '',
    ...overrides,
  };
}

const validPutBody = {
  name: 'Sahel Presence',
  description: '',
  tags: [],
  features: [feature('f1')],
  connections: [],
  sources: [],
};

function idContext(id = DATASET_ID) {
  return { params: Promise.resolve({ id }) };
}

function putRequest(body: unknown, ifMatch: string | null = ETAG): NextRequest {
  return new NextRequest(
    `https://app.example.com/api/agent-access/map-datasets/${DATASET_ID}`,
    {
      method: 'PUT',
      body: JSON.stringify(body),
      headers: ifMatch === null ? {} : { 'if-match': ifMatch },
    },
  );
}

function deleteRequest(ifMatch: string | null = ETAG): NextRequest {
  return new NextRequest(
    `https://app.example.com/api/agent-access/map-datasets/${DATASET_ID}`,
    {
      method: 'DELETE',
      headers: ifMatch === null ? {} : { 'if-match': ifMatch },
    },
  );
}

function postRequest(body: unknown): NextRequest {
  return new NextRequest(
    'https://app.example.com/api/agent-access/map-datasets',
    { method: 'POST', body: JSON.stringify(body) },
  );
}

const emptyConfig: AgentAccessConfig = {
  version: 1,
  localAdmins: [],
  updatedBy: 'global@example.com',
  updatedAt: '2026-07-23T00:00:00.000Z',
};

describe('/api/agent-access/map-datasets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.AGENT_ACCESS_CONTROL_ENABLED = true;
    serviceIsEnabled.mockReturnValue(true);
    serviceGetSnapshot.mockReturnValue({ config: emptyConfig });
    mockAuth.mockResolvedValue({
      user: { id: 'u1', mail: 'global@example.com' },
    });
    vi.mocked(createAgentAccessBlobStorage).mockReturnValue({} as never);
    vi.mocked(listAllMapDatasetMetas).mockResolvedValue([]);
    vi.mocked(readConfig).mockResolvedValue({
      config: emptyConfig,
      etag: '"cfg"',
    });
    vi.mocked(readMapDataset).mockResolvedValue({
      dataset: makeDataset(),
      etag: ETAG,
    });
    vi.mocked(writeMapDataset).mockResolvedValue(ETAG);
    vi.mocked(deleteMapDataset).mockResolvedValue(true);
    vi.mocked(writeMapDatasetHistoryEntry).mockResolvedValue(undefined);
  });

  describe('gating', () => {
    it('404s everything while the feature is disabled', async () => {
      serviceIsEnabled.mockReturnValue(false);

      expect((await GET()).status).toBe(404);
      expect((await POST(postRequest({ name: 'X' }))).status).toBe(404);
      expect((await getById(putRequest({}), idContext())).status).toBe(404);
      expect(
        (await putById(putRequest(validPutBody), idContext())).status,
      ).toBe(404);
      expect((await deleteById(deleteRequest(), idContext())).status).toBe(404);
    });

    it('401s unauthenticated and 403s non-admin callers', async () => {
      mockAuth.mockResolvedValue(null);
      expect((await GET()).status).toBe(401);

      mockAuth.mockResolvedValue({
        user: { id: 'u2', mail: 'nobody@example.com' },
      });
      expect((await GET()).status).toBe(403);
      expect((await POST(postRequest({ name: 'X' }))).status).toBe(403);
      expect(
        (await putById(putRequest(validPutBody), idContext())).status,
      ).toBe(403);
    });

    it('403s a local admin without this dataset key', async () => {
      mockAuth.mockResolvedValue({
        user: { id: 'u3', mail: 'local@example.com' },
      });
      serviceGetSnapshot.mockReturnValue({
        config: {
          ...emptyConfig,
          localAdmins: [
            { email: 'local@example.com', agentKeys: ['map-dataset::other'] },
          ],
        },
      });

      expect(
        (await putById(putRequest(validPutBody), idContext())).status,
      ).toBe(403);
      expect((await getById(putRequest({}), idContext())).status).toBe(403);
    });

    it('400s a malformed dataset id before any storage read', async () => {
      const response = await getById(putRequest({}), idContext('../rules/x'));
      expect(response.status).toBe(400);
      expect(vi.mocked(readMapDataset)).not.toHaveBeenCalled();
    });
  });

  describe('POST (create)', () => {
    it('creates an empty dataset with a server-generated mapds id', async () => {
      const response = await POST(
        postRequest({ name: 'New dataset', description: 'desc' }),
      );
      const parsed = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(parsed.data.dataset.id).toMatch(/^mapds-[a-f0-9]{12}$/);
      expect(parsed.data.dataset.features).toEqual([]);
      expect(vi.mocked(writeMapDataset)).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ features: [] }),
        null,
      );
    });

    it('rolls back when a local-admin create cannot record delegation', async () => {
      mockAuth.mockResolvedValue({
        user: { id: 'u3', mail: 'local@example.com' },
      });
      serviceGetSnapshot.mockReturnValue({
        config: {
          ...emptyConfig,
          localAdmins: [{ email: 'local@example.com', agentKeys: [] }],
        },
      });
      vi.mocked(writeConfig).mockRejectedValue(new Error('storage down'));

      const response = await POST(postRequest({ name: 'New dataset' }));

      expect(response.status).toBe(503);
      expect(vi.mocked(deleteMapDataset)).toHaveBeenCalled();
    });
  });

  describe('PUT (save)', () => {
    it('requires a quoted strong If-Match etag', async () => {
      expect(
        (await putById(putRequest(validPutBody, null), idContext())).status,
      ).toBe(400);
    });

    it('rejects payloads over the feature cap', async () => {
      const response = await putById(
        putRequest({
          ...validPutBody,
          features: Array.from({ length: MAX_DATASET_FEATURES + 1 }, (_, i) =>
            feature(`f${i}`),
          ),
        }),
        idContext(),
      );
      expect(response.status).toBe(400);
    });

    it('rejects duplicate feature ids and dangling connection endpoints', async () => {
      const dupes = await putById(
        putRequest({
          ...validPutBody,
          features: [feature('f1'), feature('f1')],
        }),
        idContext(),
      );
      const dupesParsed = await parseJsonResponse(dupes);
      expect(dupes.status).toBe(400);
      expect(dupesParsed.error).toContain('Duplicate feature id');

      const dangling = await putById(
        putRequest({
          ...validPutBody,
          connections: [
            {
              id: 'c1',
              fromId: 'f1',
              toId: 'missing',
              kind: '',
              description: '',
            },
          ],
        }),
        idContext(),
      );
      const danglingParsed = await parseJsonResponse(dangling);
      expect(dangling.status).toBe(400);
      expect(danglingParsed.error).toContain('does not exist');
    });

    it('rejects invalid coordinates', async () => {
      const response = await putById(
        putRequest({
          ...validPutBody,
          features: [feature('f1', { lat: 123, lon: 500 })],
        }),
        idContext(),
      );
      expect(response.status).toBe(400);
    });

    it('preserves id/createdBy/createdAt and writes meta-only history', async () => {
      const response = await putById(
        putRequest({ ...validPutBody, name: 'Renamed' }),
        idContext(),
      );
      const parsed = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(parsed.data.dataset.id).toBe(DATASET_ID);
      expect(parsed.data.dataset.createdBy).toBe('global@example.com');
      expect(parsed.data.dataset.name).toBe('Renamed');
      expect(vi.mocked(writeMapDatasetHistoryEntry)).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'upsert',
          meta: expect.objectContaining({ name: 'Renamed', featureCount: 1 }),
        }),
      );
    });

    it('maps CAS conflicts to 409', async () => {
      const { AgentAccessConflictError } = await vi.importActual<
        typeof import('@/lib/services/agentAccess/accessRulesStore')
      >('@/lib/services/agentAccess/accessRulesStore');
      vi.mocked(writeMapDataset).mockRejectedValue(
        new AgentAccessConflictError(),
      );

      const response = await putById(putRequest(validPutBody), idContext());
      expect(response.status).toBe(409);
    });
  });

  describe('DELETE', () => {
    it('404s when already gone, deletes with If-Match otherwise', async () => {
      vi.mocked(deleteMapDataset).mockResolvedValue(false);
      expect((await deleteById(deleteRequest(), idContext())).status).toBe(404);

      vi.mocked(deleteMapDataset).mockResolvedValue(true);
      const response = await deleteById(deleteRequest(), idContext());
      expect(response.status).toBe(200);
      expect(vi.mocked(deleteMapDataset)).toHaveBeenLastCalledWith(
        expect.anything(),
        DATASET_ID,
        ETAG,
      );
    });
  });

  describe('GET (list)', () => {
    it('lists metas and filters to delegated keys for local admins', async () => {
      const mine = makeDataset();
      const other = makeDataset({ id: 'mapds-fff000fff000', name: 'Other' });
      vi.mocked(listAllMapDatasetMetas).mockResolvedValue([
        {
          canonicalKey: canonicalAgentKey(MAP_DATASET_SOURCE, mine.id),
          blobPath: mapDatasetMetaBlobPath(mine.id),
          meta: mapDatasetMeta(mine),
        },
        {
          canonicalKey: canonicalAgentKey(MAP_DATASET_SOURCE, other.id),
          blobPath: mapDatasetMetaBlobPath(other.id),
          meta: mapDatasetMeta(other),
        },
      ]);
      mockAuth.mockResolvedValue({
        user: { id: 'u3', mail: 'local@example.com' },
      });
      vi.mocked(readConfig).mockResolvedValue({
        config: {
          ...emptyConfig,
          localAdmins: [
            {
              email: 'local@example.com',
              agentKeys: [canonicalAgentKey(MAP_DATASET_SOURCE, mine.id)],
            },
          ],
        },
        etag: '"cfg"',
      });

      const body = await parseJsonResponse(await GET());
      expect(body.data.datasets).toHaveLength(1);
      expect(body.data.datasets[0].meta.id).toBe(mine.id);
    });

    it('flags an outage instead of serving an empty list as truth', async () => {
      vi.mocked(listAllMapDatasetMetas).mockRejectedValue(
        new Error('storage down'),
      );
      vi.mocked(readConfig).mockRejectedValue(new Error('storage down'));

      const response = await GET();
      const body = await parseJsonResponse(response);
      expect(response.status).toBe(200);
      expect(body.data.datasets).toEqual([]);
      expect(body.data.datasetsUnavailable).toBe(true);
    });
  });
});
