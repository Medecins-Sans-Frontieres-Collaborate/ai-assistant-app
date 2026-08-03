import { NextRequest } from 'next/server';

import {
  createAgentAccessBlobStorage,
  listAllMapDatasetMetas,
  readMapDataset,
} from '@/lib/services/agentAccess/accessRulesStore';
import {
  MAP_DATASET_SOURCE,
  MapDataset,
  canonicalAgentKey,
  mapDatasetMeta,
  mapDatasetMetaBlobPath,
} from '@/lib/services/agentAccess/types';

import { parseJsonResponse } from './helpers';

import { GET as getById } from '@/app/api/map-datasets/[id]/route';
import { GET } from '@/app/api/map-datasets/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const serviceIsEnabled = vi.hoisted(() => vi.fn());
const serviceEnsureFresh = vi.hoisted(() => vi.fn());
const serviceEvaluateAccess = vi.hoisted(() => vi.fn());

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: {
    getInstance: () => ({
      isEnabled: serviceIsEnabled,
      ensureFresh: serviceEnsureFresh,
      evaluateAccess: serviceEvaluateAccess,
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
    };
  },
);

const DATASET_ID = 'mapds-abc123def456';

function makeDataset(): MapDataset {
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
    sources: [
      {
        id: 's1',
        name: 'Internal report',
        addedAt: '2026-07-23T00:00:00.000Z',
        featureCount: 1,
        kind: 'text',
      },
    ],
    createdBy: 'admin@example.com',
    createdAt: '2026-07-23T00:00:00.000Z',
    updatedBy: 'admin@example.com',
    updatedAt: '2026-07-23T00:00:00.000Z',
  };
}

function idRequest(id: string) {
  return [
    new NextRequest(`https://app.example.com/api/map-datasets/${id}`),
    { params: Promise.resolve({ id }) },
  ] as const;
}

describe('/api/map-datasets (user routes)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({
      user: { id: 'u1', mail: 'user@example.com' },
    });
    serviceIsEnabled.mockReturnValue(true);
    serviceEnsureFresh.mockResolvedValue(undefined);
    serviceEvaluateAccess.mockReturnValue({
      decision: 'allow',
      reason: 'public',
    });
    vi.mocked(createAgentAccessBlobStorage).mockReturnValue({} as never);
    const dataset = makeDataset();
    vi.mocked(listAllMapDatasetMetas).mockResolvedValue([
      {
        canonicalKey: canonicalAgentKey(MAP_DATASET_SOURCE, DATASET_ID),
        blobPath: mapDatasetMetaBlobPath(DATASET_ID),
        meta: mapDatasetMeta(dataset),
      },
    ]);
    vi.mocked(readMapDataset).mockResolvedValue({ dataset, etag: '"e"' });
  });

  describe('list', () => {
    it('returns an empty list (not 404) when the feature is disabled', async () => {
      serviceIsEnabled.mockReturnValue(false);
      const body = await parseJsonResponse(
        await GET(new NextRequest('http://localhost/api/map-datasets')),
      );
      expect(body.data.datasets).toEqual([]);
      expect(vi.mocked(listAllMapDatasetMetas)).not.toHaveBeenCalled();
    });

    it('filters by access and serves metadata only', async () => {
      const body = await parseJsonResponse(
        await GET(new NextRequest('http://localhost/api/map-datasets')),
      );
      expect(body.data.datasets).toHaveLength(1);
      expect(body.data.datasets[0]).toEqual({
        id: DATASET_ID,
        name: 'Sahel Presence',
        description: '',
        tags: [],
        featureCount: 1,
        connectionCount: 0,
        updatedAt: '2026-07-23T00:00:00.000Z',
      });

      serviceEvaluateAccess.mockReturnValue({
        decision: 'deny',
        reason: 'not-allowed',
      });
      const denied = await parseJsonResponse(
        await GET(new NextRequest('http://localhost/api/map-datasets')),
      );
      expect(denied.data.datasets).toEqual([]);
    });

    it('fails closed when rules are unavailable', async () => {
      serviceEvaluateAccess.mockReturnValue({
        decision: 'unavailable',
        reason: 'rules-unavailable',
      });
      const body = await parseJsonResponse(
        await GET(new NextRequest('http://localhost/api/map-datasets')),
      );
      expect(body.data.datasets).toEqual([]);
    });
  });

  describe('load by id', () => {
    it('serves the full payload to an allowed user, omitting internal sources', async () => {
      const [request, ctx] = idRequest(DATASET_ID);
      const response = await getById(request, ctx);
      const body = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(body.data.dataset.features).toHaveLength(1);
      expect(body.data.dataset.connections).toEqual([]);
      // Generation provenance is admin-internal.
      expect(body.data.dataset.sources).toBeUndefined();
    });

    it('answers the identical 404 for missing, denied, and unavailable', async () => {
      // Denied: the storage read must never even run (no existence oracle).
      serviceEvaluateAccess.mockReturnValue({
        decision: 'deny',
        reason: 'not-allowed',
      });
      let [request, ctx] = idRequest(DATASET_ID);
      expect((await getById(request, ctx)).status).toBe(404);
      expect(vi.mocked(readMapDataset)).not.toHaveBeenCalled();

      serviceEvaluateAccess.mockReturnValue({
        decision: 'unavailable',
        reason: 'rules-unavailable',
      });
      [request, ctx] = idRequest(DATASET_ID);
      expect((await getById(request, ctx)).status).toBe(404);

      serviceEvaluateAccess.mockReturnValue({
        decision: 'allow',
        reason: 'public',
      });
      vi.mocked(readMapDataset).mockResolvedValue(null);
      [request, ctx] = idRequest(DATASET_ID);
      expect((await getById(request, ctx)).status).toBe(404);
    });

    it('404s when the feature is disabled and 400s a malformed id', async () => {
      serviceIsEnabled.mockReturnValue(false);
      let [request, ctx] = idRequest(DATASET_ID);
      expect((await getById(request, ctx)).status).toBe(404);

      serviceIsEnabled.mockReturnValue(true);
      [request, ctx] = idRequest('not-a-dataset-id');
      expect((await getById(request, ctx)).status).toBe(400);
    });
  });
});
