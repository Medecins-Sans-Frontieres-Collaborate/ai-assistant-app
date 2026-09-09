import {
  AgentAccessConflictError,
  deleteMapDataset,
  listAllMapDatasetMetas,
  readMapDataset,
  writeMapDataset,
} from '@/lib/services/agentAccess/accessRulesStore';
import {
  MAP_DATASET_SOURCE,
  MapDataset,
  canonicalAgentKey,
  mapDatasetDataBlobPath,
  mapDatasetMetaBlobPath,
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

const DATASET_ID = 'mapds-abc123def456';
const DATA_PATH = mapDatasetDataBlobPath(DATASET_ID);
const META_PATH = mapDatasetMetaBlobPath(DATASET_ID);

const sampleDataset: MapDataset = {
  version: 1,
  id: DATASET_ID,
  name: 'Sahel Presence',
  description: 'Operational presence 2026',
  tags: ['sahel'],
  features: [
    {
      id: 'f1',
      name: 'Gao',
      description: 'Field office',
      lat: 16.27,
      lon: -0.04,
      confidence: 'high',
      confidenceReason: 'Well-known city',
      category: 'office',
    },
  ],
  connections: [],
  sources: [],
  createdBy: 'admin@example.com',
  createdAt: '2026-07-23T00:00:00.000Z',
  updatedBy: 'admin@example.com',
  updatedAt: '2026-07-23T00:00:00.000Z',
};

function createMockClient() {
  return {
    upload: vi.fn(),
    download: vi.fn(),
    delete: vi.fn(),
  };
}
type MockClient = ReturnType<typeof createMockClient>;

function createMockStorage(clientForPath: (path: string) => MockClient) {
  return {
    getBlockBlobClient: vi.fn(clientForPath),
    listBlobs: vi.fn(),
    upload: vi.fn(),
  } as unknown as BlobStorage & {
    listBlobs: ReturnType<typeof vi.fn>;
    upload: ReturnType<typeof vi.fn>;
  };
}

function downloadResponseFor(content: string, etag = '"etag-1"') {
  return {
    etag,
    readableStreamBody: Readable.from([Buffer.from(content, 'utf8')]),
  };
}

function preconditionError() {
  return Object.assign(new Error('precondition failed'), { statusCode: 412 });
}

describe('accessRulesStore — map datasets (split meta/data blobs)', () => {
  let dataClient: MockClient;
  let metaClient: MockClient;
  let storage: ReturnType<typeof createMockStorage>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    dataClient = createMockClient();
    metaClient = createMockClient();
    storage = createMockStorage((path) =>
      path === META_PATH ? metaClient : dataClient,
    );
  });

  describe('writeMapDataset', () => {
    it('CAS-writes the data blob, then rewrites the derived meta unconditionally', async () => {
      dataClient.upload.mockResolvedValue({ etag: '"etag-new"' });
      metaClient.upload.mockResolvedValue({ etag: '"meta"' });

      const etag = await writeMapDataset(storage, sampleDataset, '"etag-old"');

      expect(etag).toBe('"etag-new"');
      const [, , dataOptions] = dataClient.upload.mock.calls[0];
      expect(dataOptions.conditions).toEqual({ ifMatch: '"etag-old"' });
      // Meta write carries NO conditions — it is a derived projection.
      const [metaContent, , metaOptions] = metaClient.upload.mock.calls[0];
      expect(metaOptions.conditions).toBeUndefined();
      const meta = JSON.parse((metaContent as Buffer).toString('utf8'));
      expect(meta).toMatchObject({
        id: DATASET_ID,
        name: 'Sahel Presence',
        featureCount: 1,
        connectionCount: 0,
      });
      // Data landed BEFORE meta.
      expect(dataClient.upload.mock.invocationCallOrder[0]).toBeLessThan(
        metaClient.upload.mock.invocationCallOrder[0],
      );
    });

    it('maps a data-blob 412 to AgentAccessConflictError and skips the meta write', async () => {
      dataClient.upload.mockRejectedValue(preconditionError());

      await expect(
        writeMapDataset(storage, sampleDataset, '"stale"'),
      ).rejects.toBeInstanceOf(AgentAccessConflictError);
      expect(metaClient.upload).not.toHaveBeenCalled();
    });

    it('tolerates a meta-write failure — the save still succeeds (stale listing, truthful load)', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      dataClient.upload.mockResolvedValue({ etag: '"etag-new"' });
      metaClient.upload.mockRejectedValue(new Error('meta storage down'));

      const etag = await writeMapDataset(storage, sampleDataset, null);

      expect(etag).toBe('"etag-new"');
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('META write failed'),
      );
    });
  });

  describe('readMapDataset', () => {
    it('reads the data blob and returns its etag as the CAS anchor', async () => {
      dataClient.download.mockResolvedValue(
        downloadResponseFor(JSON.stringify(sampleDataset), '"data-etag"'),
      );

      const result = await readMapDataset(storage, DATASET_ID);

      expect(storage.getBlockBlobClient).toHaveBeenCalledWith(DATA_PATH);
      expect(result?.etag).toBe('"data-etag"');
      expect(result?.dataset.features).toHaveLength(1);
    });
  });

  describe('deleteMapDataset', () => {
    it('deletes data under If-Match, then meta best-effort', async () => {
      dataClient.delete.mockResolvedValue(undefined);
      metaClient.delete.mockResolvedValue(undefined);

      const deleted = await deleteMapDataset(storage, DATASET_ID, '"e"');

      expect(deleted).toBe(true);
      expect(dataClient.delete).toHaveBeenCalledWith({
        conditions: { ifMatch: '"e"' },
      });
      expect(metaClient.delete).toHaveBeenCalled();
    });

    it('still deletes an orphaned meta when the data blob is already gone (self-healing)', async () => {
      dataClient.delete.mockRejectedValue(
        Object.assign(new Error('not found'), { statusCode: 404 }),
      );
      metaClient.delete.mockResolvedValue(undefined);

      const deleted = await deleteMapDataset(storage, DATASET_ID, '"e"');

      expect(deleted).toBe(false);
      expect(metaClient.delete).toHaveBeenCalled();
    });

    it('maps a data-blob 412 to AgentAccessConflictError without touching meta', async () => {
      dataClient.delete.mockRejectedValue(preconditionError());

      await expect(
        deleteMapDataset(storage, DATASET_ID, '"stale"'),
      ).rejects.toBeInstanceOf(AgentAccessConflictError);
      expect(metaClient.delete).not.toHaveBeenCalled();
    });
  });

  describe('listAllMapDatasetMetas', () => {
    it('lists metas with canonical keys and soft-skips malformed blobs', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const goodMeta = {
        version: 1,
        id: DATASET_ID,
        name: 'Sahel Presence',
        description: '',
        tags: [],
        featureCount: 1,
        connectionCount: 0,
        createdBy: 'admin@example.com',
        createdAt: '2026-07-23T00:00:00.000Z',
        updatedBy: 'admin@example.com',
        updatedAt: '2026-07-23T00:00:00.000Z',
      };
      const badPath = mapDatasetMetaBlobPath('mapds-000000000bad');
      const badClient = createMockClient();
      badClient.download.mockResolvedValue(downloadResponseFor('not json'));
      metaClient.download.mockResolvedValue(
        downloadResponseFor(JSON.stringify(goodMeta)),
      );
      storage = createMockStorage((path) =>
        path === badPath ? badClient : metaClient,
      );
      storage.listBlobs.mockResolvedValue([META_PATH, badPath]);

      const metas = await listAllMapDatasetMetas(storage);

      expect(metas).toHaveLength(1);
      expect(metas[0].canonicalKey).toBe(
        canonicalAgentKey(MAP_DATASET_SOURCE, DATASET_ID),
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('invalid JSON'),
      );
    });

    it('skips a meta blob whose path does not match its content id', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const masquerading = {
        version: 1,
        id: 'mapds-999999999999',
        name: 'Masquerade',
        description: '',
        tags: [],
        featureCount: 0,
        connectionCount: 0,
        createdBy: 'x@example.com',
        createdAt: '2026-07-23T00:00:00.000Z',
        updatedBy: 'x@example.com',
        updatedAt: '2026-07-23T00:00:00.000Z',
      };
      metaClient.download.mockResolvedValue(
        downloadResponseFor(JSON.stringify(masquerading)),
      );
      storage.listBlobs.mockResolvedValue([META_PATH]);

      const metas = await listAllMapDatasetMetas(storage);

      expect(metas).toHaveLength(0);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('does not match'),
      );
    });
  });
});
