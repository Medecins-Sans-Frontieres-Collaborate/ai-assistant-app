import { NextRequest } from 'next/server';

import { CLEAN_PARQUET_BASE64 } from '../../../lib/services/analytics/parquetFixtures';
import {
  usageSheets,
  workbook,
} from '../../../lib/services/analytics/workbooks';
import { setPayloadCacheForTests } from '@/lib/services/agentAccess/payloadCache';
import { analyticsFileId } from '@/lib/services/analytics/deliveryStore';
import { extractTables } from '@/lib/services/analytics/extract';
import { VALIDATOR_VERSION } from '@/lib/services/analytics/fileState';
import { __resetHeavyWorkForTests } from '@/lib/services/analytics/heavyWork';
import {
  ROLLUP_VERSION,
  SMALL_GROUPS_LABEL,
} from '@/lib/services/analytics/rollup';
import { buildRollup } from '@/lib/services/analytics/rollupBuild';
import {
  ANALYTICS_PREVIEW_VERSION,
  AnalyticsFileState,
  AnalyticsFolder,
  DeliveredBlob,
} from '@/lib/services/analytics/types';

import { parseJsonResponse } from '../helpers';

import { GET as accessGET } from '@/app/api/analytics/access/route';
import { GET as dashboardGET } from '@/app/api/analytics/dashboard/route';
import { GET as downloadGET } from '@/app/api/analytics/download/route';
import { GET as exportGET } from '@/app/api/analytics/export/route';
import { GET as filesGET } from '@/app/api/analytics/files/route';
import { GET as previewGET } from '@/app/api/analytics/preview/route';
import { GET as tableGET } from '@/app/api/analytics/table/route';
import { GET as treeGET } from '@/app/api/analytics/tree/route';
import { GET as trendGET } from '@/app/api/analytics/trend/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';

const mockAuth = vi.hoisted(() => vi.fn());
const mockEnv = vi.hoisted(() => ({
  AGENT_ACCESS_ADMINS: 'global@example.org',
}));
const world = vi.hoisted(() => ({
  groups: [] as string[],
  delegations: [] as unknown[],
  snapshot: {} as Record<string, unknown>,
  downloads: [] as string[],
  audit: [] as Record<string, unknown>[],
  /** Delivered bytes by path; anything else is placeholder text. */
  content: {} as Record<string, Buffer>,
  /** Stored previews by file id. */
  previews: {} as Record<string, unknown>,
  /** Stored rollups by file id. */
  rollups: {} as Record<string, unknown>,
}));

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/config/environment', () => ({ env: mockEnv }));
vi.mock('@/lib/services/m365/groupMembership', () => ({
  resolveUserGroupIds: vi.fn(async () => world.groups),
  getCachedGroupIdsForUser: () => world.groups,
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
      ensureFoldersFresh: async () => undefined,
      getSnapshot: () => world.snapshot,
      getDeliveryStore: () => ({
        download: async (path: string) => {
          world.downloads.push(path);
          return world.content[path] ?? Buffer.from(`bytes of ${path}`);
        },
      }),
      getAdminStorage: () => ({}),
    }),
  },
}));
vi.mock('@/lib/services/analytics/rollupStore', () => ({
  readRollup: vi.fn(
    async (_storage: unknown, fileId: string) => world.rollups[fileId] ?? null,
  ),
}));
vi.mock('@/lib/services/analytics/previewStore', () => ({
  readPreview: vi.fn(
    async (_storage: unknown, fileId: string) => world.previews[fileId] ?? null,
  ),
}));
vi.mock('@/lib/services/analytics/maintenance', () => ({
  scheduleAnalyticsMaintenance: vi.fn(),
}));
vi.mock('@/lib/services/observability/AzureMonitorLoggingService', () => ({
  getAzureMonitorLogger: () => ({
    logAgentAccess: async (entry: Record<string, unknown>) => {
      world.audit.push(entry);
    },
  }),
}));

const OCBA_GROUP = '11111111-1111-1111-1111-111111111111';
const NOW_ISH = new Date().toISOString();

function monthName(offsetMonths: number): string {
  const date = new Date();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + offsetMonths);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Periods are relative to today so the files are neither stale nor expired.
const OCBA_PATH = `usage/ocba/ocba_summary_${monthName(-1)}.xlsx`;
const QUARANTINED_PATH = `usage/ocba/ocba_bad_${monthName(-1)}.xlsx`;
const EXPIRED_PATH = `usage/ocba/ocba_summary_${monthName(-40)}.xlsx`;
const REBILLING_PATH = `rebilling/MS Azure rebilling_${monthName(-1)}.xlsx`;
const RAW_PATH = 'raw/telemetry/day.parquet';

function delivered(path: string): DeliveredBlob {
  return { path, size: 1234, lastModified: NOW_ISH };
}

function record(
  blob: DeliveredBlob,
  overrides: Partial<AnalyticsFileState> = {},
): AnalyticsFileState {
  return {
    path: blob.path,
    blobVersion: `${blob.size}:${blob.lastModified}`,
    validatorVersion: VALIDATOR_VERSION,
    validatedAt: NOW_ISH,
    firstSeenAt: NOW_ISH,
    status: 'ok',
    issues: [],
    columns: [],
    declaredFields: [],
    inspected: true,
    reportType: null,
    previewVersion: null,
    rollupVersion: null,
    ...overrides,
  };
}

function folder(
  path: string,
  overrides: Partial<AnalyticsFolder> = {},
): AnalyticsFolder {
  return {
    path,
    name: '',
    description: '',
    reportType: null,
    audience: [],
    restricted: false,
    retentionMonths: null,
    hiddenFields: [],
    ...overrides,
  };
}

function setWorld(
  options: {
    hidden?: string[];
    states?: Record<string, Partial<AnalyticsFileState>>;
    policyUnavailable?: boolean;
    /** Report type of the usage/ocba folder (records must match it). */
    reportType?: AnalyticsFolder['reportType'];
  } = {},
) {
  const blobs = [
    OCBA_PATH,
    QUARANTINED_PATH,
    EXPIRED_PATH,
    REBILLING_PATH,
    RAW_PATH,
  ].map(delivered);
  const overrides: Record<string, Partial<AnalyticsFileState>> = {
    [OCBA_PATH]: {
      columns: ['UserId', 'UserJobTitle'],
      previewVersion: ANALYTICS_PREVIEW_VERSION,
    },
    [QUARANTINED_PATH]: {
      status: 'error',
      issues: [
        {
          code: 'identifier-column',
          severity: 'error',
          params: { sheet: 'Users', column: 'UserEmail' },
        },
      ],
    },
    ...options.states,
  };
  world.snapshot = {
    folders: {
      version: 1,
      folders: [
        folder('usage/ocba', {
          reportType: options.reportType ?? null,
          audience: [
            { scope: 'group', targets: [OCBA_GROUP], level: 'download' },
            { scope: 'domain', targets: ['viewer.example.org'], level: 'view' },
          ],
        }),
      ],
      updatedBy: 'global@example.org',
      updatedAt: NOW_ISH,
    },
    foldersUnavailable: false,
    policy: {
      version: 1,
      hidden: options.hidden ?? [],
      columns: {},
      updatedBy: 'global@example.org',
      updatedAt: NOW_ISH,
    },
    policyUnavailable: options.policyUnavailable ?? false,
    state: {
      version: 1,
      files: Object.fromEntries(
        blobs.map((blob) => [
          analyticsFileId(blob.path),
          record(blob, overrides[blob.path]),
        ]),
      ),
      updatedAt: NOW_ISH,
    },
    stateUnavailable: false,
    blobs,
    deliveryUnavailable: false,
  };
}

const session = (mail: string, extra: Record<string, unknown> = {}) => ({
  user: { id: `oid-${mail}`, displayName: mail, mail, ...extra },
});
const member = session('nurse@ocba.example.org');
const viewer = session('lead@viewer.example.org');
const stranger = session('someone@elsewhere.example.org');
const globalAdmin = session('global@example.org');
const delegatedAdmin = session('delegate@example.org');

function get(url: string) {
  return new NextRequest(`http://localhost${url}`);
}
const download = (path: string) =>
  downloadGET(get(`/api/analytics/download?id=${analyticsFileId(path)}`));

describe('analytics viewer routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    world.groups = [];
    world.delegations = [];
    world.downloads = [];
    world.audit = [];
    world.content = {};
    world.previews = {};
    world.rollups = {};
    __resetHeavyWorkForTests();
    setPayloadCacheForTests(null);
    setWorld();
    mockAuth.mockResolvedValue(member);
  });

  it('401s without a session', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await accessGET(get('/api/analytics/access'))).status).toBe(401);
    expect((await treeGET(get('/api/analytics/tree'))).status).toBe(401);
    expect((await filesGET(get('/api/analytics/files?folder=x'))).status).toBe(
      401,
    );
    expect((await download(OCBA_PATH)).status).toBe(401);
  });

  describe('access', () => {
    it('is false for someone no audience names', async () => {
      mockAuth.mockResolvedValue(stranger);
      const body = await parseJsonResponse(
        await accessGET(get('/api/analytics/access')),
      );
      expect(body.data).toEqual({ hasAccess: false, canAdmin: false });
    });

    it('is true for a member of a granted group', async () => {
      world.groups = [OCBA_GROUP];
      const body = await parseJsonResponse(
        await accessGET(get('/api/analytics/access')),
      );
      expect(body.data).toEqual({ hasAccess: true, canAdmin: false });
    });
  });

  describe('tree and files', () => {
    it('gives a stranger an empty tree and a 404 for any folder', async () => {
      mockAuth.mockResolvedValue(stranger);
      const tree = await parseJsonResponse(
        await treeGET(get('/api/analytics/tree')),
      );
      expect(tree.data.folders).toEqual([]);
      expect(
        (await filesGET(get('/api/analytics/files?folder=usage/ocba'))).status,
      ).toBe(404);
    });

    it('lists only validated, unexpired files to a member', async () => {
      world.groups = [OCBA_GROUP];
      const body = await parseJsonResponse(
        await filesGET(get('/api/analytics/files?folder=usage/ocba')),
      );
      expect(body.data.access).toBe('download');
      expect(body.data.files).toHaveLength(1);
      expect(body.data.files[0]).toMatchObject({
        id: analyticsFileId(OCBA_PATH),
        canDownload: true,
        downloadBlock: null,
      });
      // Nothing about validation leaks to a non-admin.
      expect(body.data.files[0].admin).toBeUndefined();
    });

    it('shows a member neither the rebilling folder nor raw', async () => {
      world.groups = [OCBA_GROUP];
      const tree = await parseJsonResponse(
        await treeGET(get('/api/analytics/tree')),
      );
      const paths = tree.data.folders.map((f: { path: string }) => f.path);
      expect(paths).toEqual(['', 'usage', 'usage/ocba']);
      for (const folderPath of ['rebilling', 'raw/telemetry']) {
        expect(
          (await filesGET(get(`/api/analytics/files?folder=${folderPath}`)))
            .status,
        ).toBe(404);
      }
    });

    it('rejects a folder parameter that is not a plain path', async () => {
      world.groups = [OCBA_GROUP];
      for (const folderPath of ['usage/ocba/../../raw', '/usage', 'usage//x']) {
        expect(
          (
            await filesGET(
              get(
                `/api/analytics/files?folder=${encodeURIComponent(folderPath)}`,
              ),
            )
          ).status,
          folderPath,
        ).toBe(400);
      }
    });

    it('shows an admin every file in the folder, with its standing', async () => {
      mockAuth.mockResolvedValue(globalAdmin);
      const body = await parseJsonResponse(
        await filesGET(get('/api/analytics/files?folder=usage/ocba')),
      );
      expect(body.data.access).toBe('admin');
      expect(body.data.files).toHaveLength(3);
      const bad = body.data.files.find(
        (f: { id: string }) => f.id === analyticsFileId(QUARANTINED_PATH),
      );
      expect(bad.admin.validation).toBe('error');
    });
  });

  describe('download', () => {
    it('rejects a malformed id before touching anything', async () => {
      const response = await downloadGET(
        get('/api/analytics/download?id=../../etc/passwd'),
      );
      expect(response.status).toBe(400);
      expect(world.downloads).toEqual([]);
    });

    it('404s for an id that matches no listed file', async () => {
      world.groups = [OCBA_GROUP];
      const response = await downloadGET(
        get(`/api/analytics/download?id=${'0'.repeat(32)}`),
      );
      expect(response.status).toBe(404);
    });

    it('serves the file to a member with download access, and records it', async () => {
      world.groups = [OCBA_GROUP];
      const response = await download(OCBA_PATH);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('content-disposition')).toContain(
        'attachment',
      );
      expect(await response.text()).toBe(`bytes of ${OCBA_PATH}`);
      expect(world.audit).toEqual([
        expect.objectContaining({
          agentName: OCBA_PATH,
          agentSource: 'analytics',
          decision: 'allow',
        }),
      ]);
    });

    it('404s — not 403s — for a file in a folder the caller cannot open', async () => {
      mockAuth.mockResolvedValue(stranger);
      for (const path of [OCBA_PATH, REBILLING_PATH, RAW_PATH]) {
        expect((await download(path)).status, path).toBe(404);
      }
      expect(world.downloads).toEqual([]);
    });

    it('403s at view level, with the reason, and records the refusal', async () => {
      mockAuth.mockResolvedValue(viewer);
      const response = await download(OCBA_PATH);
      expect(response.status).toBe(403);
      const body = await parseJsonResponse(response);
      expect(body.code).toBe('ANALYTICS_DOWNLOAD_RESTRICTED');
      expect(body.details).toBe('view-only');
      expect(world.downloads).toEqual([]);
      expect(world.audit[0]).toMatchObject({ decision: 'deny' });
    });

    it('withholds a file containing a hidden field from members, not from admins', async () => {
      setWorld({ hidden: ['jobTitle'] });
      world.groups = [OCBA_GROUP];
      const refused = await download(OCBA_PATH);
      expect(refused.status).toBe(403);
      expect((await parseJsonResponse(refused)).details).toBe('hidden-fields');

      mockAuth.mockResolvedValue(globalAdmin);
      expect((await download(OCBA_PATH)).status).toBe(200);
    });

    it('hides a quarantined or expired file from members as if it did not exist', async () => {
      world.groups = [OCBA_GROUP];
      expect((await download(QUARANTINED_PATH)).status).toBe(404);
      expect((await download(EXPIRED_PATH)).status).toBe(404);
      expect(world.downloads).toEqual([]);
    });

    it('hides a file the ETL replaced until it has been validated again', async () => {
      world.groups = [OCBA_GROUP];
      setWorld({ states: { [OCBA_PATH]: { blobVersion: 'older-bytes' } } });
      expect((await download(OCBA_PATH)).status).toBe(404);
    });

    describe('raw telemetry', () => {
      const analyticsDelegation = {
        id: 'del-0000000000aa',
        label: 'Analytics',
        enabled: true,
        jurisdiction: [],
        capabilities: ['analytics'],
        admins: [{ mail: 'delegate@example.org', grants: 'all' }],
        limits: { maxOverrides: 0 },
        createdBy: 'global@example.org',
        createdAt: NOW_ISH,
        updatedBy: 'global@example.org',
        updatedAt: NOW_ISH,
      };

      it('is served to a global admin', async () => {
        mockAuth.mockResolvedValue(globalAdmin);
        expect((await download(RAW_PATH)).status).toBe(200);
      });

      it('is invisible to a delegated analytics admin, who still administers the rest', async () => {
        world.delegations = [analyticsDelegation];
        mockAuth.mockResolvedValue(delegatedAdmin);
        expect((await download(RAW_PATH)).status).toBe(404);
        expect((await download(REBILLING_PATH)).status).toBe(200);
        const tree = await parseJsonResponse(
          await treeGET(get('/api/analytics/tree')),
        );
        expect(tree.data.canAdmin).toBe(true);
        expect(
          tree.data.folders.some((f: { path: string }) =>
            f.path.startsWith('raw'),
          ),
        ).toBe(false);
      });

      it('is invisible to a global admin who is viewing as a regular user', async () => {
        mockAuth.mockResolvedValue(
          session('global@example.org', {
            viewAs: { overrides: { adminRole: 'none' }, actual: {} },
          }),
        );
        expect((await download(RAW_PATH)).status).toBe(404);
        expect((await download(REBILLING_PATH)).status).toBe(404);
      });
    });
  });
  describe('opening a file', () => {
    const OCBA_BYTES = workbook(usageSheets());
    const preview = (path: string) =>
      previewGET(get(`/api/analytics/preview?id=${analyticsFileId(path)}`));
    const table = (path: string, name: string) =>
      tableGET(
        get(
          `/api/analytics/table?id=${analyticsFileId(path)}&table=${encodeURIComponent(name)}`,
        ),
      );
    const exportFile = (path: string, query: string) =>
      exportGET(
        get(`/api/analytics/export?id=${analyticsFileId(path)}&${query}`),
      );

    beforeEach(async () => {
      world.content[OCBA_PATH] = OCBA_BYTES;
      world.previews[analyticsFileId(OCBA_PATH)] = await extractTables(
        OCBA_BYTES,
        'xlsx',
        { maxRows: 5000 },
      );
    });

    it('401s without a session', async () => {
      mockAuth.mockResolvedValue(null);
      expect((await preview(OCBA_PATH)).status).toBe(401);
      expect((await table(OCBA_PATH, 'Users')).status).toBe(401);
      expect((await exportFile(OCBA_PATH, 'format=xlsx')).status).toBe(401);
    });

    it('404s for a stranger on every route, and reads nothing', async () => {
      mockAuth.mockResolvedValue(stranger);
      expect((await preview(OCBA_PATH)).status).toBe(404);
      expect((await table(OCBA_PATH, 'Daily')).status).toBe(404);
      expect((await exportFile(OCBA_PATH, 'format=xlsx')).status).toBe(404);
      expect(world.downloads).toEqual([]);
    });

    it('404s for a file with no stored preview', async () => {
      world.groups = [OCBA_GROUP];
      setWorld({ states: { [OCBA_PATH]: { previewVersion: null } } });
      expect((await preview(OCBA_PATH)).status).toBe(404);
      expect((await exportFile(OCBA_PATH, 'format=xlsx')).status).toBe(403);
    });

    it('lists every table to a member, all of them open', async () => {
      world.groups = [OCBA_GROUP];
      const body = await parseJsonResponse(await preview(OCBA_PATH));
      expect(body.data.canExport).toBe(true);
      expect(
        body.data.tables.map((t: { name: string; withheld: unknown }) => [
          t.name,
          t.withheld,
        ]),
      ).toEqual([
        ['Summary', null],
        ['Users', null],
        ['Daily', null],
        ['Weekly', null],
        ['Interactions', null],
      ]);
    });

    it('at view level: aggregate tables open, per-person tables locked, no export', async () => {
      mockAuth.mockResolvedValue(viewer);
      const body = await parseJsonResponse(await preview(OCBA_PATH));
      expect(body.data.canExport).toBe(false);
      expect(
        Object.fromEntries(
          body.data.tables.map((t: { name: string; withheld: unknown }) => [
            t.name,
            t.withheld,
          ]),
        ),
      ).toEqual({
        Summary: null,
        Users: 'row-level',
        Daily: null,
        Weekly: null,
        Interactions: 'row-level',
      });

      expect((await table(OCBA_PATH, 'Daily')).status).toBe(200);
      const refused = await table(OCBA_PATH, 'Users');
      expect(refused.status).toBe(403);
      expect((await parseJsonResponse(refused)).code).toBe(
        'ANALYTICS_TABLE_WITHHELD',
      );
      expect(
        (await exportFile(OCBA_PATH, 'format=csv&table=Daily')).status,
      ).toBe(403);
      expect(world.audit.map((entry) => entry.decision)).toEqual([
        'allow',
        'deny',
        'deny',
      ]);
    });

    it('strips a hidden field on the server — from the grid, the value column and the export', async () => {
      setWorld({ hidden: ['jobTitle'] });
      world.groups = [OCBA_GROUP];

      const users = await parseJsonResponse(await table(OCBA_PATH, 'Users'));
      const userColumns = users.data.columns.map(
        (c: { name: string }) => c.name,
      );
      expect(userColumns).not.toContain('UserJobTitle');
      expect(userColumns).toContain('UserDepartment');
      expect(JSON.stringify(users.data.rows)).not.toContain(
        'Nutrition Referent',
      );

      const summary = await parseJsonResponse(
        await table(OCBA_PATH, 'Summary'),
      );
      expect(JSON.stringify(summary.data)).not.toContain('top_job_title');
      expect(JSON.stringify(summary.data)).not.toContain('logco');

      const csv = await exportFile(OCBA_PATH, 'format=csv&table=Users');
      expect(csv.status).toBe(200);
      const text = await csv.text();
      expect(text).toContain('UserId');
      expect(text).not.toContain('UserJobTitle');
      expect(text).not.toContain('Nutrition Referent');
      expect(csv.headers.get('content-disposition')).toContain('_Users.csv');

      const xlsx = await exportFile(OCBA_PATH, 'format=xlsx');
      expect(xlsx.status).toBe(200);
      const exported = XLSX.read(Buffer.from(await xlsx.arrayBuffer()), {
        type: 'buffer',
      });
      expect(exported.SheetNames).toEqual([
        'Summary',
        'Users',
        'Daily',
        'Weekly',
        'Interactions',
      ]);
      expect(JSON.stringify(exported.Sheets)).not.toContain(
        'Nutrition Referent',
      );
      expect(JSON.stringify(exported.Sheets)).not.toContain('logco');
    });

    it('shows an admin the hidden column, marked', async () => {
      setWorld({ hidden: ['jobTitle'] });
      mockAuth.mockResolvedValue(globalAdmin);
      const users = await parseJsonResponse(await table(OCBA_PATH, 'Users'));
      const jobTitle = users.data.columns.find(
        (c: { name: string }) => c.name === 'UserJobTitle',
      );
      expect(jobTitle.hiddenFromUsers).toBe(true);
    });

    it('fails closed for users when the field policy cannot be read', async () => {
      setWorld({ policyUnavailable: true });
      world.groups = [OCBA_GROUP];
      expect((await preview(OCBA_PATH)).status).toBe(503);
      expect((await table(OCBA_PATH, 'Daily')).status).toBe(503);
      expect((await exportFile(OCBA_PATH, 'format=xlsx')).status).toBe(403);

      mockAuth.mockResolvedValue(globalAdmin);
      expect((await preview(OCBA_PATH)).status).toBe(200);
    });

    it('validates its parameters', async () => {
      world.groups = [OCBA_GROUP];
      expect((await table(OCBA_PATH, 'No such table')).status).toBe(404);
      expect((await exportFile(OCBA_PATH, 'format=pdf')).status).toBe(400);
      expect((await exportFile(OCBA_PATH, 'format=csv')).status).toBe(400);
      expect(
        (await exportFile(OCBA_PATH, 'format=csv&table=No%20such')).status,
      ).toBe(404);
      expect(
        (await previewGET(get('/api/analytics/preview?id=nope'))).status,
      ).toBe(400);
    });

    it('records a successful export', async () => {
      world.groups = [OCBA_GROUP];
      await exportFile(OCBA_PATH, 'format=csv&table=Daily');
      expect(world.audit).toEqual([
        expect.objectContaining({
          agentName: OCBA_PATH,
          decision: 'allow',
          reason: 'export:csv:Daily',
        }),
      ]);
    });

    describe('raw telemetry', () => {
      const RAW_PARQUET = 'raw/telemetry/2026-09-26.parquet';

      beforeEach(() => {
        const snapshot = world.snapshot as {
          blobs: DeliveredBlob[];
          state: { files: Record<string, AnalyticsFileState> };
        };
        const blob = delivered(RAW_PARQUET);
        snapshot.blobs.push(blob);
        snapshot.state.files[analyticsFileId(RAW_PARQUET)] = record(blob);
        world.content[RAW_PARQUET] = Buffer.from(
          CLEAN_PARQUET_BASE64,
          'base64',
        );
      });

      it('opens for a global admin, read on demand rather than from a stored copy', async () => {
        mockAuth.mockResolvedValue(globalAdmin);
        const body = await parseJsonResponse(await preview(RAW_PARQUET));
        expect(body.data.tables).toEqual([
          expect.objectContaining({
            name: 'data',
            rowCount: 3,
            withheld: null,
          }),
        ]);
        expect(world.downloads).toEqual([RAW_PARQUET]);

        const csv = await exportFile(RAW_PARQUET, 'format=csv&table=data');
        expect(csv.status).toBe(200);
        expect(await csv.text()).toContain('u-93d80e8bfd9b');
      });

      it('does not exist for anyone else', async () => {
        world.groups = [OCBA_GROUP];
        expect((await preview(RAW_PARQUET)).status).toBe(404);
        expect((await table(RAW_PARQUET, 'data')).status).toBe(404);
        expect((await exportFile(RAW_PARQUET, 'format=xlsx')).status).toBe(404);
        expect(world.downloads).toEqual([]);
      });
    });
  });
  describe('dashboards and trends', () => {
    const PREVIOUS_PATH = `usage/ocba/ocba_summary_${monthName(-2)}.xlsx`;
    const dashboard = (path: string) =>
      dashboardGET(get(`/api/analytics/dashboard?id=${analyticsFileId(path)}`));
    const trend = (folderPath: string) =>
      trendGET(
        get(`/api/analytics/trend?folder=${encodeURIComponent(folderPath)}`),
      );

    async function usageRollup(blobVersion: string) {
      return buildRollup(
        'usage',
        blobVersion,
        await extractTables(workbook(usageSheets()), 'xlsx', {
          maxRows: Number.POSITIVE_INFINITY,
        }),
      );
    }

    /** Adds last month's and the month before's report, each with a rollup. */
    async function withRollups(
      options: Parameters<typeof setWorld>[0] = {},
    ): Promise<void> {
      setWorld({
        ...options,
        reportType: 'usage',
        states: {
          [OCBA_PATH]: {
            columns: ['UserId', 'UserJobTitle'],
            previewVersion: ANALYTICS_PREVIEW_VERSION,
            rollupVersion: ROLLUP_VERSION,
            reportType: 'usage',
          },
          ...options.states,
        },
      });
      const snapshot = world.snapshot as {
        blobs: DeliveredBlob[];
        state: { files: Record<string, AnalyticsFileState> };
      };
      const previous = delivered(PREVIOUS_PATH);
      snapshot.blobs.push(previous);
      snapshot.state.files[analyticsFileId(PREVIOUS_PATH)] = record(previous, {
        rollupVersion: ROLLUP_VERSION,
        reportType: 'usage',
      });
      for (const path of [OCBA_PATH, PREVIOUS_PATH]) {
        world.rollups[analyticsFileId(path)] = await usageRollup(
          `${1234}:${NOW_ISH}`,
        );
      }
    }

    it('401s without a session, 404s for a stranger', async () => {
      await withRollups();
      mockAuth.mockResolvedValue(null);
      expect((await dashboard(OCBA_PATH)).status).toBe(401);
      expect((await trend('usage/ocba')).status).toBe(401);
      mockAuth.mockResolvedValue(stranger);
      expect((await dashboard(OCBA_PATH)).status).toBe(404);
      expect((await trend('usage/ocba')).status).toBe(404);
    });

    it('404s for a file with no rollup', async () => {
      world.groups = [OCBA_GROUP];
      expect((await dashboard(OCBA_PATH)).status).toBe(404);
    });

    it('opens at VIEW level — with small groups folded before the response is built', async () => {
      await withRollups();
      mockAuth.mockResolvedValue(viewer);
      const response = await dashboard(OCBA_PATH);
      expect(response.status).toBe(200);
      const body = await parseJsonResponse(response);
      expect(body.data.reportType).toBe('usage');
      expect(body.data.access).toBe('view');
      expect(body.data.kpis.users).toBe(222);
      // Two people in two departments: one unnamed row, and no trace of the
      // department names anywhere in what was sent.
      expect(body.data.datasets.byDepartment).toEqual({
        columns: ['group', 'users', 'interactions'],
        rows: [[SMALL_GROUPS_LABEL, 2, 1993]],
        folded: true,
      });
      expect(JSON.stringify(body.data)).not.toContain('Medical Department');
      expect(JSON.stringify(body.data)).not.toContain('Nutrition Referent');
      // …and nothing about who is behind each group is sent along.
      expect(JSON.stringify(body.data)).not.toContain('"people"');
      expect(world.audit[0]).toMatchObject({
        decision: 'allow',
        reason: 'view:view:dashboard',
      });
    });

    it('shows every group to someone with download access', async () => {
      await withRollups();
      world.groups = [OCBA_GROUP];
      const body = await parseJsonResponse(await dashboard(OCBA_PATH));
      expect(
        body.data.datasets.byDepartment.rows.map((row: unknown[]) => row[0]),
      ).toEqual(['Medical Department', 'Logistics']);
    });

    it('withholds a breakdown by a hidden field, for the dashboard and the trend alike', async () => {
      await withRollups({ hidden: ['jobTitle'] });
      world.groups = [OCBA_GROUP];
      const body = await parseJsonResponse(await dashboard(OCBA_PATH));
      expect(body.data.datasets.byJobTitle).toBeUndefined();
      expect(body.data.withheld).toContain('byJobTitle');
      expect(JSON.stringify(body.data)).not.toContain('Nutrition Referent');

      mockAuth.mockResolvedValue(globalAdmin);
      const asAdmin = await parseJsonResponse(await dashboard(OCBA_PATH));
      expect(asAdmin.data.datasets.byJobTitle).toBeDefined();
    });

    it('fails closed for users when the field policy cannot be read', async () => {
      await withRollups({ policyUnavailable: true });
      world.groups = [OCBA_GROUP];
      expect((await dashboard(OCBA_PATH)).status).toBe(503);
      expect((await trend('usage/ocba')).status).toBe(503);
    });

    it('plots the run of reports under a folder, oldest first, with only what a trend needs', async () => {
      await withRollups();
      mockAuth.mockResolvedValue(viewer);
      const body = await parseJsonResponse(await trend('usage/ocba'));
      expect(body.data.status).toBe('ok');
      expect(body.data.reportType).toBe('usage');
      expect(
        body.data.points.map(
          (point: { file: { id: string } }) => point.file.id,
        ),
      ).toEqual([analyticsFileId(PREVIOUS_PATH), analyticsFileId(OCBA_PATH)]);
      // Headline figures only: no breakdowns travel with a usage trend.
      expect(body.data.points[0].kpis.users).toBe(222);
      expect(body.data.points[0].datasets).toEqual({});
    });

    it('says so when there is no single run to plot', async () => {
      world.groups = [OCBA_GROUP];
      const body = await parseJsonResponse(await trend('usage/ocba'));
      expect(body.data).toEqual({
        reportType: null,
        status: 'none',
        points: [],
      });
    });

    it('validates the folder parameter', async () => {
      world.groups = [OCBA_GROUP];
      expect((await trend('usage/../raw')).status).toBe(400);
      expect((await trendGET(get('/api/analytics/trend'))).status).toBe(400);
    });
  });
});
