import {
  AgentAccessConflictError,
  downloadBlob,
  uploadJson,
} from '@/lib/services/agentAccess/blobCas';
import { setPayloadCacheForTests } from '@/lib/services/agentAccess/payloadCache';
import { AnalyticsService } from '@/lib/services/analytics/AnalyticsService';
import { analyticsFileId } from '@/lib/services/analytics/deliveryStore';
import { __resetHeavyWorkForTests } from '@/lib/services/analytics/heavyWork';
import {
  __resetAnalyticsMaintenanceForTests,
  runAnalyticsMaintenance,
} from '@/lib/services/analytics/maintenance';
import { readPreview } from '@/lib/services/analytics/previewStore';
import { ROLLUP_VERSION } from '@/lib/services/analytics/rollup';
import { readRollup } from '@/lib/services/analytics/rollupStore';
import {
  ANALYTICS_FOLDERS_PATH,
  ANALYTICS_MAINTENANCE_CLAIM_PATH,
  ANALYTICS_PREVIEW_VERSION,
  ANALYTICS_STATE_PATH,
  AnalyticsStateDocument,
  DeliveredBlob,
  analyticsPreviewPath,
  analyticsRollupPath,
} from '@/lib/services/analytics/types';

import { blob, folder } from './fixtures';
import { usageSheets, workbook } from './workbooks';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  ANALYTICS_RETENTION_DELETE_ENABLED: true,
}));
const admin = vi.hoisted(() => ({
  blobs: new Map<string, { text: string; etag: string }>(),
  failReads: new Set<string>(),
}));
const delivery = vi.hoisted(() => ({
  files: new Map<string, { blob: unknown; content: Buffer }>(),
  deleted: [] as string[],
}));

vi.mock('@/config/environment', () => ({ env: mockEnv }));
vi.mock('@/lib/services/adminBlobStorage', () => ({
  createAdminBlobStorage: () => ({
    deleteIfExists: async (path: string) => admin.blobs.delete(path),
  }),
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
vi.mock('@/lib/services/analytics/deliveryStore', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/lib/services/analytics/deliveryStore')
    >();
  return {
    ...actual,
    createDeliveryStore: () => ({
      list: async () => [...delivery.files.values()].map((file) => file.blob),
      download: async (path: string) =>
        delivery.files.get(path)?.content ?? null,
      delete: async (path: string) => {
        delivery.deleted.push(path);
        return delivery.files.delete(path);
      },
    }),
  };
});

let etagCounter = 0;
function seed(path: string, body: unknown) {
  admin.blobs.set(path, {
    text: JSON.stringify(body),
    etag: `"e${++etagCounter}"`,
  });
}
function stored<T>(path: string): T | null {
  const entry = admin.blobs.get(path);
  return entry ? (JSON.parse(entry.text) as T) : null;
}

function cleanWorkbook(): Buffer {
  return workbook(usageSheets());
}

function deliver(path: string, content = cleanWorkbook()): DeliveredBlob {
  const delivered = blob(path, { size: content.length });
  delivery.files.set(path, { blob: delivered, content });
  return delivered;
}

function saveOverlay(folders = [folder('usage', { reportType: 'usage' })]) {
  seed(ANALYTICS_FOLDERS_PATH, {
    version: 1,
    folders,
    updatedBy: 'admin@example.org',
    updatedAt: '2026-08-01T00:00:00.000Z',
  });
}

const CURRENT = 'usage/ocba/ocba_report_2026-07-01_to_2026-07-31.xlsx';
const EXPIRED = 'usage/ocba/ocba_report_2024-05-01_to_2024-05-31.xlsx';
const NOW = new Date('2026-08-10T09:00:00.000Z');

describe('runAnalyticsMaintenance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    admin.blobs.clear();
    admin.failReads.clear();
    delivery.files.clear();
    delivery.deleted.length = 0;
    mockEnv.ANALYTICS_RETENTION_DELETE_ENABLED = true;
    AnalyticsService.resetInstance();
    __resetAnalyticsMaintenanceForTests();
    __resetHeavyWorkForTests();
    setPayloadCacheForTests(null);

    vi.mocked(downloadBlob).mockImplementation(async (_storage, path) => {
      if (admin.failReads.has(path)) throw new Error('storage down');
      const entry = admin.blobs.get(path);
      return entry
        ? { buffer: Buffer.from(entry.text, 'utf8'), etag: entry.etag }
        : null;
    });
    vi.mocked(uploadJson).mockImplementation(
      async (_storage, path, payload, condition) => {
        const existing = admin.blobs.get(path);
        if (condition === null && existing) {
          throw new AgentAccessConflictError();
        }
        if (typeof condition === 'string' && existing?.etag !== condition) {
          throw new AgentAccessConflictError();
        }
        seed(path, payload);
        return admin.blobs.get(path)!.etag;
      },
    );
  });

  it('validates a new delivery, records it, and then has nothing left to do', async () => {
    saveOverlay();
    deliver(CURRENT);

    const first = await runAnalyticsMaintenance(NOW);
    expect(first).toMatchObject({ ran: true, validated: 1, deleted: 0 });
    const state = stored<AnalyticsStateDocument>(ANALYTICS_STATE_PATH)!;
    expect(state.files[analyticsFileId(CURRENT)]).toMatchObject({
      path: CURRENT,
      status: 'ok',
      reportType: 'usage',
      previewVersion: ANALYTICS_PREVIEW_VERSION,
      rollupVersion: ROLLUP_VERSION,
    });
    // …and so was the rollup its dashboard is drawn from.
    const rollup = await readRollup(
      {} as never,
      analyticsFileId(CURRENT),
      state.files[analyticsFileId(CURRENT)].blobVersion,
    );
    expect(rollup?.reportType).toBe('usage');
    expect(rollup?.kpis.users).toBe(222);
    // The preview was written in the same pass, from the same read.
    const preview = await readPreview(
      {} as never,
      analyticsFileId(CURRENT),
      state.files[analyticsFileId(CURRENT)].blobVersion,
    );
    expect(preview?.map((table) => table.name)).toEqual([
      'Summary',
      'Users',
      'Daily',
      'Weekly',
      'Interactions',
    ]);
    // The claim is released, so the next run is not locked out.
    expect(admin.blobs.has(ANALYTICS_MAINTENANCE_CLAIM_PATH)).toBe(false);

    AnalyticsService.resetInstance();
    expect((await runAnalyticsMaintenance(NOW)).ran).toBe(false);
  });

  it('re-validates when the ETL replaces a file', async () => {
    saveOverlay();
    deliver(CURRENT);
    await runAnalyticsMaintenance(NOW);

    delivery.files.set(CURRENT, {
      blob: blob(CURRENT, {
        size: 21,
        lastModified: '2026-08-09T00:00:00.000Z',
      }),
      content: Buffer.from('no longer a workbook!'),
    });
    AnalyticsService.resetInstance();
    await runAnalyticsMaintenance(NOW);
    expect(
      stored<AnalyticsStateDocument>(ANALYTICS_STATE_PATH)!.files[
        analyticsFileId(CURRENT)
      ].status,
    ).toBe('error');
    // A quarantined file keeps no stored preview of its earlier, clean self.
    expect(
      admin.blobs.has(analyticsPreviewPath(analyticsFileId(CURRENT))),
    ).toBe(false);
  });

  it('deletes a file past retention and grace, and forgets its record', async () => {
    saveOverlay();
    deliver(CURRENT);
    deliver(EXPIRED);

    const report = await runAnalyticsMaintenance(NOW);
    expect(report.deleted).toBe(1);
    expect(delivery.deleted).toEqual([EXPIRED]);
    const state = stored<AnalyticsStateDocument>(ANALYTICS_STATE_PATH)!;
    expect(Object.keys(state.files)).toEqual([analyticsFileId(CURRENT)]);
    expect(
      admin.blobs.has(analyticsPreviewPath(analyticsFileId(CURRENT))),
    ).toBe(true);
    expect(
      admin.blobs.has(analyticsPreviewPath(analyticsFileId(EXPIRED))),
    ).toBe(false);
  });

  it('deletes NOTHING until a folder overlay has been saved', async () => {
    // No overlay: every folder would resolve to the default retention, and a
    // folder meant to be kept longer would be cut at it.
    deliver(EXPIRED);
    await runAnalyticsMaintenance(NOW);
    expect(delivery.deleted).toEqual([]);
    // It is still validated, so admins can see it.
    expect(
      stored<AnalyticsStateDocument>(ANALYTICS_STATE_PATH)!.files[
        analyticsFileId(EXPIRED)
      ],
    ).toBeDefined();
  });

  it('honours a folder that keeps its files longer', async () => {
    saveOverlay([
      folder('usage', { reportType: 'usage', retentionMonths: 84 }),
    ]);
    deliver(EXPIRED);
    await runAnalyticsMaintenance(NOW);
    expect(delivery.deleted).toEqual([]);
  });

  it('deletes nothing when deletion is switched off', async () => {
    mockEnv.ANALYTICS_RETENTION_DELETE_ENABLED = false;
    saveOverlay();
    deliver(EXPIRED);
    await runAnalyticsMaintenance(NOW);
    expect(delivery.deleted).toEqual([]);
  });

  it('does nothing at all while the overlay cannot be read', async () => {
    saveOverlay();
    deliver(CURRENT);
    deliver(EXPIRED);
    admin.failReads.add(ANALYTICS_FOLDERS_PATH);

    const report = await runAnalyticsMaintenance(NOW);
    expect(report.ran).toBe(false);
    expect(delivery.deleted).toEqual([]);
    expect(admin.blobs.has(ANALYTICS_STATE_PATH)).toBe(false);
  });

  it('stands down while another replica holds a fresh claim, and takes over a stale one', async () => {
    saveOverlay();
    deliver(CURRENT);

    seed(ANALYTICS_MAINTENANCE_CLAIM_PATH, { at: new Date().toISOString() });
    expect((await runAnalyticsMaintenance(NOW)).ran).toBe(false);
    expect(admin.blobs.has(ANALYTICS_STATE_PATH)).toBe(false);

    seed(ANALYTICS_MAINTENANCE_CLAIM_PATH, {
      at: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    AnalyticsService.resetInstance();
    expect((await runAnalyticsMaintenance(NOW)).ran).toBe(true);
  });

  it('drops records of files that are no longer in storage', async () => {
    saveOverlay();
    deliver(CURRENT);
    await runAnalyticsMaintenance(NOW);

    delivery.files.clear();
    AnalyticsService.resetInstance();
    await runAnalyticsMaintenance(NOW);
    expect(stored<AnalyticsStateDocument>(ANALYTICS_STATE_PATH)!.files).toEqual(
      {},
    );
    expect(delivery.deleted).toEqual([]);
    expect(admin.blobs.has(analyticsRollupPath(analyticsFileId(CURRENT)))).toBe(
      false,
    );
    // …and their previews go with them.
    expect(
      admin.blobs.has(analyticsPreviewPath(analyticsFileId(CURRENT))),
    ).toBe(false);
  });
});
