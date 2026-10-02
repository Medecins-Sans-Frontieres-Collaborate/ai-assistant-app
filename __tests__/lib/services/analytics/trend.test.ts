import { indexFolders } from '@/lib/services/analytics/access';
import { analyticsFileId } from '@/lib/services/analytics/deliveryStore';
import {
  MAX_TREND_FILES,
  ROLLUP_VERSION,
} from '@/lib/services/analytics/rollup';
import { PREVIEW_ROWS } from '@/lib/services/analytics/tables';
import { selectTrendFiles } from '@/lib/services/analytics/trend';
import { validateDelivery } from '@/lib/services/analytics/validate';
import {
  AnalyticsData,
  buildFileViews,
} from '@/lib/services/analytics/viewModel';

import { actor, blob, folder, state } from './fixtures';
import { Row, usageSheets, workbook } from './workbooks';

import { describe, expect, it } from 'vitest';

const NOW = new Date('2026-08-10T09:00:00.000Z');

function world(
  paths: string[],
  folders = [folder('rebilling', { reportType: 'rebilling' })],
) {
  const blobs = paths.map((path) => blob(path));
  const data: AnalyticsData = {
    folders: {
      version: 1,
      folders: [
        folder('', {
          audience: [
            { scope: 'domain', targets: ['ocba.example.org'], level: 'view' },
          ],
        }),
        ...folders,
      ],
      updatedBy: 'a',
      updatedAt: 'b',
    },
    policy: null,
    policyUnavailable: false,
    state: {
      version: 1,
      files: Object.fromEntries(
        blobs.map((delivered) => [
          analyticsFileId(delivered.path),
          state(delivered, {
            rollupVersion: ROLLUP_VERSION,
            reportType: delivered.path.startsWith('usage')
              ? 'usage'
              : 'rebilling',
          }),
        ]),
      ),
      updatedAt: 'c',
    },
    blobs,
  };
  return {
    files: buildFileViews(data, analyticsFileId, NOW),
    folders: indexFolders(data.folders!.folders),
  };
}

const month = (m: string) => `rebilling/2026/MS Azure rebilling_2026-${m}.xlsx`;

describe('selectTrendFiles', () => {
  it('orders one run of reports by period, across year folders', () => {
    const { files, folders } = world([
      month('07'),
      'rebilling/2025/MS Azure rebilling_2025-12.xlsx',
      month('05'),
    ]);
    const selection = selectTrendFiles('rebilling', files, folders, actor());
    expect(selection.status).toBe('ok');
    expect(selection.reportType).toBe('rebilling');
    expect(selection.files.map(({ file }) => file.period!.to)).toEqual([
      '2025-12-31',
      '2026-05-31',
      '2026-07-31',
    ]);
  });

  it('needs at least two reports', () => {
    const { files, folders } = world([month('07')]);
    expect(selectTrendFiles('rebilling', files, folders, actor()).status).toBe(
      'none',
    );
  });

  it('refuses to invent a series from several reports covering one period', () => {
    const { files, folders } = world(
      [
        'usage/ocba/ocba_report_2026-07-01_to_2026-07-31.xlsx',
        'usage/ocg/ocg_report_2026-07-01_to_2026-07-31.xlsx',
        'usage/ocba/ocba_report_2026-06-01_to_2026-06-30.xlsx',
      ],
      [folder('usage', { reportType: 'usage' })],
    );
    expect(selectTrendFiles('usage', files, folders, actor()).status).toBe(
      'several-per-period',
    );
    // One level down there IS a single run.
    expect(selectTrendFiles('usage/ocba', files, folders, actor()).status).toBe(
      'ok',
    );
  });

  it('refuses to mix report types', () => {
    const { files, folders } = world(
      [
        month('06'),
        month('07'),
        'usage/ocba/ocba_report_2026-07-01_to_2026-07-31.xlsx',
      ],
      [
        folder('rebilling', { reportType: 'rebilling' }),
        folder('usage', { reportType: 'usage' }),
      ],
    );
    expect(selectTrendFiles('', files, folders, actor()).status).toBe(
      'mixed-types',
    );
  });

  it('leaves out reports in a sub-folder the reader may not open', () => {
    const { files, folders } = world(
      [
        month('05'),
        month('06'),
        'rebilling/board/MS Azure rebilling_2026-07.xlsx',
      ],
      [
        folder('rebilling', { reportType: 'rebilling' }),
        folder('rebilling/board', { restricted: true }),
      ],
    );
    const selection = selectTrendFiles('rebilling', files, folders, actor());
    expect(selection.files.map(({ file }) => file.period!.to)).toEqual([
      '2026-05-31',
      '2026-06-30',
    ]);
    // An admin sees all three.
    expect(
      selectTrendFiles(
        'rebilling',
        files,
        folders,
        actor({ isGlobalAdmin: true }),
      ).files,
    ).toHaveLength(3);
  });

  it('leaves out expired reports, raw telemetry, and files with no dashboard', () => {
    const { files, folders } = world([
      month('06'),
      month('07'),
      'rebilling/2023/MS Azure rebilling_2023-01.xlsx',
      'raw/telemetry/2026-07-01.parquet',
      'raw/telemetry/2026-07-02.parquet',
    ]);
    const selection = selectTrendFiles(
      '',
      files,
      folders,
      actor({ isGlobalAdmin: true }),
    );
    // The admin sees the expired file listed elsewhere, and it has a rollup,
    // so it is part of their trend; raw never is.
    expect(selection.files.map(({ file }) => file.path)).not.toContain(
      'raw/telemetry/2026-07-01.parquet',
    );
    expect(
      selectTrendFiles('', files, folders, actor()).files.map(
        ({ file }) => file.period!.to,
      ),
    ).toEqual(['2026-06-30', '2026-07-31']);
  });

  it('keeps only the most recent periods of a very long run', () => {
    const paths = Array.from({ length: MAX_TREND_FILES + 6 }, (_, i) => {
      const year = 2024 + Math.floor(i / 12);
      const m = String((i % 12) + 1).padStart(2, '0');
      return `rebilling/MS Azure rebilling_${year}-${m}.xlsx`;
    });
    const { files, folders } = world(paths, [
      folder('rebilling', { reportType: 'rebilling', retentionMonths: 120 }),
    ]);
    const selection = selectTrendFiles('rebilling', files, folders, actor());
    expect(selection.files).toHaveLength(MAX_TREND_FILES);
    expect(selection.files[0].file.period!.from).toBe('2024-07-01');
  });
});

describe('rollups built during validation', () => {
  const USAGE_FOLDERS = indexFolders([
    folder('usage', { reportType: 'usage' }),
  ]);
  const PATH = 'usage/ocba/ocba_report_2026-07-01_to_2026-07-31.xlsx';

  it('reads a sheet in FULL when the preview holds only part of it', async () => {
    const rows: Row[] = [['UserId', 'ModelUsed', 'MessageCount', 'event_date']];
    const total = PREVIEW_ROWS + 250;
    for (let i = 0; i < total; i++) {
      rows.push([
        `u-${String(i % 40).padStart(6, '0')}`,
        i < PREVIEW_ROWS ? 'gpt-5.2' : 'gpt-5.4',
        1,
        '2026-07-01',
      ]);
    }
    const content = workbook(usageSheets({ Interactions: rows }));
    const { tables, rollup } = await validateDelivery({
      blob: blob(PATH, { size: content.length }),
      content,
      folders: USAGE_FOLDERS,
      now: NOW,
    });
    // The preview is capped…
    expect(tables!.find((t) => t.name === 'Interactions')!.rows).toHaveLength(
      PREVIEW_ROWS,
    );
    // …the aggregate is not: the model that only appears past the cap is there.
    const byModel = new Map(
      rollup!.datasets.byModel.rows.map((row) => [row[0], row[2]]),
    );
    expect(byModel.get('gpt-5.2')).toBe(PREVIEW_ROWS);
    expect(byModel.get('gpt-5.4')).toBe(250);
  });

  it('builds none for a folder with no report type, or for a quarantined file', async () => {
    const content = workbook(usageSheets());
    const untyped = await validateDelivery({
      blob: blob('misc/x_2026-07.xlsx', { size: content.length }),
      content,
      folders: indexFolders([]),
      now: NOW,
    });
    expect(untyped.rollup).toBeNull();

    const leaky = workbook(
      usageSheets({
        Users: [
          ['UserId', 'UserEmail', 'total_interactions', 'days_active'],
          ['u-000001', 'x', 1, 1],
        ],
      }),
    );
    const quarantined = await validateDelivery({
      blob: blob(PATH, { size: leaky.length }),
      content: leaky,
      folders: USAGE_FOLDERS,
      now: NOW,
    });
    expect(quarantined.state.status).toBe('error');
    expect(quarantined.rollup).toBeNull();
  });
});
