import { NextRequest } from 'next/server';

import {
  ANALYTICS_FIELD_POLICY_PATH,
  ANALYTICS_FOLDERS_PATH,
  AnalyticsFieldPolicyDocument,
  AnalyticsFoldersDocument,
} from '@/lib/services/analytics/types';

import { parseJsonResponse } from '../helpers';
import { BlobFake, installBlobFake } from './blobFake';

import {
  GET as policyGET,
  PUT as policyPUT,
} from '@/app/api/admin/analytics/field-policy/route';
import {
  GET as foldersGET,
  PUT as foldersPUT,
} from '@/app/api/admin/analytics/folders/route';
import { GET as healthGET } from '@/app/api/admin/analytics/health/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const mockEnv = vi.hoisted(() => ({
  AGENT_ACCESS_ADMINS: 'global@example.org',
  ANALYTICS_RETENTION_DELETE_ENABLED: true,
}));
const world = vi.hoisted(() => ({
  delegations: [] as unknown[],
  blobs: [] as { path: string; size: number; lastModified: string }[],
}));
const serviceSpies = vi.hoisted(() => ({
  invalidateConfig: vi.fn(),
  invalidateFiles: vi.fn(),
}));
const scheduleMaintenance = vi.hoisted(() => vi.fn());

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/config/environment', () => ({ env: mockEnv }));
vi.mock('@/lib/services/adminBlobStorage', () => ({
  createAdminBlobStorage: () => ({}),
  resolveAdminStorageLocation: () => ({
    accountName: 'account',
    containerName: 'ai-portal-admin',
  }),
}));
vi.mock('@/lib/services/agentAccess/blobCas', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/services/agentAccess/blobCas')>();
  return { ...actual, downloadBlob: vi.fn(), uploadJson: vi.fn() };
});
vi.mock('@/lib/services/m365/groupMembership', () => ({
  resolveUserGroupIds: vi.fn(async () => []),
  getCachedGroupIdsForUser: () => [],
  isGroupMembershipDegradedForUser: () => false,
}));
vi.mock('@/lib/services/delegations/DelegationsService', () => ({
  DelegationsService: {
    getInstance: () => ({
      ensureFresh: async () => undefined,
      getSnapshot: () => ({
        document: { delegations: world.delegations },
        unavailable: false,
      }),
    }),
  },
}));
vi.mock('@/lib/services/analytics/AnalyticsService', () => ({
  AnalyticsService: {
    getInstance: () => ({
      ensureFresh: async () => undefined,
      getSnapshot: () => ({
        folders: null,
        foldersUnavailable: false,
        policy: null,
        policyUnavailable: false,
        state: null,
        stateUnavailable: false,
        blobs: world.blobs,
        deliveryUnavailable: false,
      }),
      getAdminStorage: () => ({}),
      ...serviceSpies,
    }),
  },
}));
vi.mock('@/lib/services/analytics/maintenance', () => ({
  scheduleAnalyticsMaintenance: scheduleMaintenance,
}));

const STAMP = '2026-08-01T00:00:00.000Z';
const globalAdmin = {
  user: { id: 'oid-1', displayName: 'Global', mail: 'global@example.org' },
};
const delegatedAdmin = {
  user: { id: 'oid-2', displayName: 'Delegate', mail: 'delegate@example.org' },
};
const normalUser = {
  user: { id: 'oid-3', displayName: 'User', mail: 'user@example.org' },
};
const demotedAdmin = {
  user: {
    ...globalAdmin.user,
    viewAs: { overrides: { adminRole: 'none' }, actual: {} },
  },
};

const analyticsDelegation = {
  id: 'del-0000000000aa',
  label: 'Analytics',
  enabled: true,
  jurisdiction: [],
  capabilities: ['analytics'],
  admins: [{ mail: 'delegate@example.org', grants: 'all' }],
  limits: { maxOverrides: 0 },
  createdBy: 'global@example.org',
  createdAt: STAMP,
  updatedBy: 'global@example.org',
  updatedAt: STAMP,
};

function folderInput(path: string, extra: Record<string, unknown> = {}) {
  return { path, ...extra };
}

function put(
  route: 'folders' | 'field-policy',
  body: unknown,
  etag?: string | null,
) {
  return new NextRequest(`http://localhost/api/admin/analytics/${route}`, {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      ...(etag ? { 'if-match': etag } : {}),
    },
  });
}

const RAW_ENTRY = {
  path: 'raw/telemetry',
  name: 'Raw telemetry',
  description: '',
  reportType: 'raw-telemetry',
  audience: [],
  restricted: false,
  retentionMonths: 3,
  hiddenFields: [],
};

let fake: BlobFake;

function seedFolders(folders: unknown[]) {
  fake.seed(ANALYTICS_FOLDERS_PATH, {
    version: 1,
    folders,
    updatedBy: 'global@example.org',
    updatedAt: STAMP,
  });
}

async function currentEtag(): Promise<string> {
  const body = await parseJsonResponse(await foldersGET());
  return body.data.etag;
}

describe('/api/admin/analytics/folders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fake = installBlobFake();
    world.delegations = [analyticsDelegation];
    world.blobs = [
      { path: 'usage/ocba/a_2026-07.xlsx', size: 1, lastModified: STAMP },
      {
        path: 'raw/telemetry/2026-09-26.parquet',
        size: 1,
        lastModified: STAMP,
      },
    ];
    mockAuth.mockResolvedValue(globalAdmin);
  });

  it('401s without a session and 403s for non-admins', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await foldersGET()).status).toBe(401);
    expect((await foldersPUT(put('folders', { folders: [] }))).status).toBe(
      401,
    );

    for (const who of [normalUser, demotedAdmin]) {
      mockAuth.mockResolvedValue(who);
      expect((await foldersGET()).status).toBe(403);
      expect((await foldersPUT(put('folders', { folders: [] }))).status).toBe(
        403,
      );
    }
  });

  it('GET lists every delivered folder, and hides raw from a delegated admin', async () => {
    seedFolders([RAW_ENTRY]);
    const asGlobal = await parseJsonResponse(await foldersGET());
    expect(asGlobal.data.paths).toEqual([
      '',
      'raw',
      'raw/telemetry',
      'usage',
      'usage/ocba',
    ]);
    expect(asGlobal.data.document.folders).toHaveLength(1);

    mockAuth.mockResolvedValue(delegatedAdmin);
    const asDelegate = await parseJsonResponse(await foldersGET());
    expect(asDelegate.data.isGlobalAdmin).toBe(false);
    expect(asDelegate.data.paths).toEqual(['', 'usage', 'usage/ocba']);
    expect(asDelegate.data.document.folders).toEqual([]);
  });

  it('GET reports unavailable on a read failure rather than "nothing configured"', async () => {
    fake.seed(ANALYTICS_FOLDERS_PATH, '{ not json');
    const body = await parseJsonResponse(await foldersGET());
    expect(body.data.unavailable).toBe(true);
    expect(body.data.document).toBeNull();
  });

  it('creates the overlay on the first save and canonicalizes it', async () => {
    const response = await foldersPUT(
      put('folders', {
        folders: [
          folderInput('/usage/ocba/', {
            name: '  OCBA  ',
            reportType: 'usage',
            audience: [
              {
                scope: 'domain',
                targets: [' OCBA.Example.org ', 'ocba.example.org'],
                level: 'download',
              },
            ],
          }),
        ],
      }),
    );
    expect(response.status).toBe(200);
    const stored = fake.read<AnalyticsFoldersDocument>(ANALYTICS_FOLDERS_PATH)!;
    expect(stored.folders[0]).toMatchObject({
      path: 'usage/ocba',
      name: 'OCBA',
      audience: [
        { scope: 'domain', targets: ['ocba.example.org'], level: 'download' },
      ],
    });
    expect(stored.updatedBy).toBe('global@example.org');
    expect(serviceSpies.invalidateConfig).toHaveBeenCalled();
    expect(scheduleMaintenance).toHaveBeenCalledWith({ force: true });
    // A history copy sits beside the document.
    expect(fake.paths().some((path) => path.includes('folders-history/'))).toBe(
      true,
    );
  });

  it('409s on a stale or missing ETag instead of overwriting', async () => {
    seedFolders([]);
    expect(
      (await foldersPUT(put('folders', { folders: [] }, '"stale"'))).status,
    ).toBe(409);
    expect((await foldersPUT(put('folders', { folders: [] }))).status).toBe(
      409,
    );
    expect(
      (await foldersPUT(put('folders', { folders: [] }, await currentEtag())))
        .status,
    ).toBe(200);
  });

  it('refuses an audience on a raw folder, even from a global admin', async () => {
    const response = await foldersPUT(
      put('folders', {
        folders: [
          folderInput('raw/telemetry', {
            audience: [
              { scope: 'domain', targets: ['example.org'], level: 'view' },
            ],
          }),
        ],
      }),
    );
    expect(response.status).toBe(400);
    expect(fake.read(ANALYTICS_FOLDERS_PATH)).toBeNull();
  });

  it('refuses raw telemetry outside raw/, and other report types inside it', async () => {
    for (const folders of [
      [folderInput('usage', { reportType: 'raw-telemetry' })],
      [folderInput('raw/x', { reportType: 'usage' })],
      [folderInput('RAW/x', { reportType: 'usage' })],
    ]) {
      expect((await foldersPUT(put('folders', { folders }))).status).toBe(400);
    }
  });

  it('refuses path traversal, duplicates and unknown fields', async () => {
    for (const folders of [
      [folderInput('usage/../raw')],
      [folderInput('usage//ocba')],
      [folderInput('usage'), folderInput('usage/')],
      [folderInput('usage', { hiddenFields: ['salary'] })],
      [folderInput('usage', { retentionMonths: 0 })],
      [folderInput('usage', { somethingElse: true })],
    ]) {
      expect(
        (await foldersPUT(put('folders', { folders }))).status,
        JSON.stringify(folders),
      ).toBe(400);
    }
  });

  it('keeps the stored raw entries when a delegated admin saves, and drops any they send', async () => {
    seedFolders([RAW_ENTRY]);
    const etag = await currentEtag();
    mockAuth.mockResolvedValue(delegatedAdmin);

    const response = await foldersPUT(
      put(
        'folders',
        {
          folders: [
            folderInput('usage/ocba', { name: 'OCBA' }),
            folderInput('raw/telemetry', { retentionMonths: 200 }),
          ],
        },
        etag,
      ),
    );
    expect(response.status).toBe(200);

    const stored = fake.read<AnalyticsFoldersDocument>(ANALYTICS_FOLDERS_PATH)!;
    expect(stored.folders.map((folder) => folder.path).sort()).toEqual([
      'raw/telemetry',
      'usage/ocba',
    ]);
    expect(
      stored.folders.find((folder) => folder.path === 'raw/telemetry'),
    ).toMatchObject({ retentionMonths: 3, name: 'Raw telemetry' });
    // …and the response does not hand the raw entry back to them.
    const body = await parseJsonResponse(response);
    expect(
      body.data.document.folders.map((folder: { path: string }) => folder.path),
    ).toEqual(['usage/ocba']);
  });
});

describe('/api/admin/analytics/field-policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fake = installBlobFake();
    world.delegations = [analyticsDelegation];
    mockAuth.mockResolvedValue(globalAdmin);
  });

  it('lets a delegated admin read but not write', async () => {
    mockAuth.mockResolvedValue(delegatedAdmin);
    const read = await parseJsonResponse(await policyGET());
    expect(read.data.canEdit).toBe(false);
    expect(
      (await policyPUT(put('field-policy', { hidden: ['jobTitle'] }))).status,
    ).toBe(403);
    expect(fake.read(ANALYTICS_FIELD_POLICY_PATH)).toBeNull();
  });

  it('403s for non-admins', async () => {
    mockAuth.mockResolvedValue(normalUser);
    expect((await policyGET()).status).toBe(403);
    expect((await policyPUT(put('field-policy', {}))).status).toBe(403);
  });

  it('saves hidden fields and classifications, normalizing column names', async () => {
    const response = await policyPUT(
      put('field-policy', {
        hidden: ['jobTitle', 'jobTitle'],
        columns: { '  User  Country ': 'other', UserJobTitle: 'technical' },
      }),
    );
    expect(response.status).toBe(200);
    const stored = fake.read<AnalyticsFieldPolicyDocument>(
      ANALYTICS_FIELD_POLICY_PATH,
    )!;
    expect(stored.hidden).toEqual(['jobTitle']);
    // A column the catalog already knows is not stored: the catalog wins.
    expect(stored.columns).toEqual({ 'user country': 'other' });
    expect(serviceSpies.invalidateConfig).toHaveBeenCalled();
  });

  it('refuses unknown fields and any attempt to classify an identifier', async () => {
    for (const body of [
      { hidden: ['salary'] },
      { columns: { UserCountry: 'salary' } },
      { columns: { UserEmail: 'other' } },
      { hidden: [], extra: 1 },
    ]) {
      expect(
        (await policyPUT(put('field-policy', body))).status,
        JSON.stringify(body),
      ).toBe(400);
    }
  });

  it('409s on a stale ETag', async () => {
    await policyPUT(put('field-policy', { hidden: [] }));
    expect(
      (await policyPUT(put('field-policy', { hidden: [] }, '"stale"'))).status,
    ).toBe(409);
  });
});

describe('/api/admin/analytics/health', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fake = installBlobFake();
    world.delegations = [analyticsDelegation];
    world.blobs = [
      { path: 'usage/ocba/a_2026-07.xlsx', size: 1, lastModified: STAMP },
      {
        path: 'raw/telemetry/2026-09-26.parquet',
        size: 1,
        lastModified: STAMP,
      },
    ];
  });

  const request = () =>
    new NextRequest('http://localhost/api/admin/analytics/health');

  it('403s for non-admins', async () => {
    mockAuth.mockResolvedValue(normalUser);
    expect((await healthGET(request())).status).toBe(403);
  });

  it('reports undelivered-to folders and pending files, scoped to what the admin administers', async () => {
    mockAuth.mockResolvedValue(globalAdmin);
    const asGlobal = await parseJsonResponse(await healthGET(request()));
    expect(asGlobal.data.totals).toMatchObject({ files: 2, pending: 2 });
    expect(asGlobal.data.unconfiguredFolders).toEqual([
      'raw/telemetry',
      'usage/ocba',
    ]);
    expect(asGlobal.data.retentionDeletion).toBe('waiting-for-config');

    mockAuth.mockResolvedValue(delegatedAdmin);
    const asDelegate = await parseJsonResponse(await healthGET(request()));
    expect(asDelegate.data.totals.files).toBe(1);
    expect(asDelegate.data.unconfiguredFolders).toEqual(['usage/ocba']);
  });
});
