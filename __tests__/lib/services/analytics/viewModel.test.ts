import {
  indexFolders,
  resolveFolderAccess,
} from '@/lib/services/analytics/access';
import { buildHealth } from '@/lib/services/analytics/health';
import {
  AnalyticsData,
  buildFileViews,
  buildFolderViews,
  canDownloadOriginal,
  findStaleFolders,
  findUnconfiguredFolders,
  isFileVisible,
} from '@/lib/services/analytics/viewModel';

import { actor, blob, folder, state } from './fixtures';

import { describe, expect, it } from 'vitest';

const NOW = new Date('2026-08-10T09:00:00.000Z');
const id = (path: string) => `id:${path}`;

const OCBA = blob('usage/ocba/ocba_report_2026-07-01_to_2026-07-31.xlsx');
const REBILLING = blob('rebilling/MS Azure rebilling_2026-07.xlsx');
const RAW = blob('raw/telemetry/2026-08-09.parquet');
const OLD = blob('usage/ocba/ocba_report_2024-06-01_to_2024-06-30.xlsx');

function data(overrides: Partial<AnalyticsData> = {}): AnalyticsData {
  return {
    folders: {
      version: 1,
      folders: [
        folder('usage', { reportType: 'usage' }),
        folder('usage/ocba', {
          audience: [
            {
              scope: 'domain',
              targets: ['ocba.example.org'],
              level: 'download',
            },
            { scope: 'domain', targets: ['viewer.example.org'], level: 'view' },
          ],
        }),
        folder('rebilling', { reportType: 'rebilling' }),
      ],
      updatedBy: 'admin@example.org',
      updatedAt: '2026-08-01T00:00:00.000Z',
    },
    policy: null,
    policyUnavailable: false,
    state: {
      version: 1,
      files: {
        [id(OCBA.path)]: state(OCBA, {
          reportType: 'usage',
          columns: ['UserId', 'UserJobTitle'],
        }),
        [id(REBILLING.path)]: state(REBILLING, { reportType: 'rebilling' }),
        [id(RAW.path)]: state(RAW),
        [id(OLD.path)]: state(OLD, { reportType: 'usage' }),
      },
      updatedAt: '2026-08-03T08:05:00.000Z',
    },
    blobs: [OCBA, REBILLING, RAW, OLD],
    ...overrides,
  };
}

function viewOf(source: AnalyticsData, path: string) {
  return buildFileViews(source, id, NOW).find((file) => file.path === path)!;
}

const member = actor();
const viewer = actor({ mail: 'someone@viewer.example.org' });
const delegated = actor({ isAnalyticsAdmin: true, isGlobalAdmin: false });
const global = actor({ isGlobalAdmin: true });

describe('file visibility', () => {
  it('shows a validated, unexpired file to its audience and lets them download it', () => {
    const file = viewOf(data(), OCBA.path);
    expect(file.validation).toBe('ok');
    expect(isFileVisible(file, 'download')).toBe(true);
    expect(canDownloadOriginal(file, 'download')).toBe(true);
  });

  it('lists but does not hand over the file at view level', () => {
    const file = viewOf(data(), OCBA.path);
    expect(isFileVisible(file, 'view')).toBe(true);
    expect(canDownloadOriginal(file, 'view')).toBe(false);
  });

  it('hides a file the validator has not seen in its current bytes', () => {
    const replaced = { ...OCBA, lastModified: '2026-08-09T00:00:00.000Z' };
    const file = viewOf(
      data({ blobs: [replaced, REBILLING, RAW, OLD] }),
      OCBA.path,
    );
    expect(file.validation).toBe('pending');
    expect(isFileVisible(file, 'download')).toBe(false);
    expect(isFileVisible(file, 'admin')).toBe(true);
  });

  it('hides a quarantined file from everyone but admins', () => {
    const source = data();
    source.state!.files[id(OCBA.path)] = state(OCBA, {
      reportType: 'usage',
      status: 'error',
      issues: [
        {
          code: 'identifier-column',
          severity: 'error',
          params: { sheet: 'Users', column: 'UserEmail' },
        },
      ],
    });
    const file = viewOf(source, OCBA.path);
    expect(isFileVisible(file, 'download')).toBe(false);
    expect(canDownloadOriginal(file, 'download')).toBe(false);
    expect(canDownloadOriginal(file, 'admin')).toBe(true);
  });

  it('hides a file past its folder’s retention, exactly, without any sweep', () => {
    const file = viewOf(data(), OLD.path);
    expect(file.expired).toBe(true);
    expect(isFileVisible(file, 'download')).toBe(false);
    expect(file.issues.map((issue) => issue.code)).toContain('past-retention');
  });

  it('keeps that file visible when its folder keeps reports longer', () => {
    const source = data();
    source.folders!.folders[1] = {
      ...source.folders!.folders[1],
      retentionMonths: 60,
    };
    expect(viewOf(source, OLD.path).expired).toBe(false);
  });
});

describe('field policy at the download gate', () => {
  it('blocks the delivered file once a field it contains is hidden', () => {
    const file = viewOf(
      data({
        policy: {
          version: 1,
          hidden: ['jobTitle'],
          columns: {},
          updatedBy: 'a',
          updatedAt: 'b',
        },
      }),
      OCBA.path,
    );
    expect(file.originalBlock).toBe('hidden-fields');
    expect(isFileVisible(file, 'download')).toBe(true);
    expect(canDownloadOriginal(file, 'download')).toBe(false);
    expect(canDownloadOriginal(file, 'admin')).toBe(true);
  });

  it('applies a folder’s own hidden fields to its subtree only', () => {
    const source = data();
    source.folders!.folders[0] = {
      ...source.folders!.folders[0],
      hiddenFields: ['jobTitle'],
    };
    expect(viewOf(source, OCBA.path).originalBlock).toBe('hidden-fields');
    expect(viewOf(source, REBILLING.path).originalBlock).toBeNull();
  });

  it('blocks, and warns, while a column is unclassified', () => {
    const source = data();
    source.state!.files[id(OCBA.path)] = state(OCBA, {
      reportType: 'usage',
      columns: ['UserId', 'UserCountry'],
    });
    const file = viewOf(source, OCBA.path);
    expect(file.originalBlock).toBe('unclassified-fields');
    expect(file.validation).toBe('warning');
    expect(file.issues).toContainEqual({
      code: 'unclassified-field',
      severity: 'warning',
      params: { column: 'UserCountry' },
    });
  });

  it('fails closed when the policy could not be read', () => {
    const file = viewOf(data({ policyUnavailable: true }), OCBA.path);
    expect(file.originalBlock).toBe('policy-unavailable');
    expect(canDownloadOriginal(file, 'download')).toBe(false);
  });

  it('does not apply to raw telemetry', () => {
    expect(
      viewOf(data({ policyUnavailable: true }), RAW.path).originalBlock,
    ).toBeNull();
  });
});

describe('buildFolderViews', () => {
  const paths = (who: ReturnType<typeof actor>) => {
    const source = data();
    return buildFolderViews(source, buildFileViews(source, id, NOW), who).map(
      (view) =>
        `${view.path || '(root)'}:${view.pathOnly ? 'path' : view.access}`,
    );
  };

  it('gives a member their folder plus the bare path leading to it', () => {
    expect(paths(member)).toEqual([
      '(root):path',
      'usage:path',
      'usage/ocba:download',
    ]);
  });

  it('gives someone with no audience an empty tree', () => {
    expect(paths(actor({ mail: 'stranger@elsewhere.example.org' }))).toEqual(
      [],
    );
  });

  it('gives a delegated admin everything except raw', () => {
    expect(paths(delegated)).toEqual([
      '(root):admin',
      'rebilling:admin',
      'usage:admin',
      'usage/ocba:admin',
    ]);
  });

  it('gives a global admin raw as well', () => {
    expect(paths(global)).toContain('raw/telemetry:admin');
  });

  it('counts only the files the person can see, and hides overlay names on bare paths', () => {
    const source = data();
    source.folders!.folders[0] = {
      ...source.folders!.folders[0],
      name: 'Usage reports',
      description: 'Internal note',
    };
    const views = buildFolderViews(
      source,
      buildFileViews(source, id, NOW),
      member,
    );
    const ocba = views.find((view) => view.path === 'usage/ocba')!;
    // The expired 2024 file is not counted.
    expect(ocba.fileCount).toBe(1);
    const usage = views.find((view) => view.path === 'usage')!;
    expect(usage.name).toBe('usage');
    expect(usage.description).toBe('');
  });
});

describe('admin health', () => {
  function health(who: ReturnType<typeof actor>, source = data()) {
    return buildHealth({
      data: source,
      files: buildFileViews(source, id, NOW),
      actor: who,
      deliveryUnavailable: false,
      foldersUnavailable: false,
      container: 'ai-portal-analytics',
      deleteEnabled: true,
      now: NOW,
    });
  }

  it('leaves raw out of a delegated admin’s view entirely', () => {
    const view = health(delegated);
    expect(view.totals.files).toBe(3);
    expect(JSON.stringify(view)).not.toContain('raw/');
    expect(health(global).totals.files).toBe(4);
    expect(health(global).unconfiguredFolders).toEqual(['raw/telemetry']);
  });

  it('lists what is expiring or expired', () => {
    expect(health(delegated).expiring).toEqual([
      expect.objectContaining({ path: OLD.path, expired: true }),
    ]);
  });

  it('reports why nothing is being deleted yet', () => {
    expect(health(global).retentionDeletion).toBe('active');
    expect(health(global, data({ folders: null })).retentionDeletion).toBe(
      'waiting-for-config',
    );
  });
});

describe('findStaleFolders / findUnconfiguredFolders', () => {
  it('flags a monthly stream whose latest report is too old', () => {
    const source = data();
    const files = buildFileViews(source, id, NOW);
    // Latest usage and rebilling reports end 31 July; 10 Aug is fine.
    expect(findStaleFolders(source, files, NOW)).toEqual([]);
    expect(
      findStaleFolders(source, files, new Date('2026-09-20T00:00:00.000Z')).map(
        (stale) => stale.path,
      ),
    ).toEqual(['usage', 'rebilling']);
  });

  it('flags a typed folder that has never received anything', () => {
    const source = data({ blobs: [REBILLING] });
    expect(
      findStaleFolders(source, buildFileViews(source, id, NOW), NOW),
    ).toEqual([{ path: 'usage', cadence: 'monthly', lastPeriodEnd: null }]);
  });

  it('names folders that receive files nobody has configured', () => {
    expect(findUnconfiguredFolders(data())).toEqual(['raw/telemetry']);
    expect(
      resolveFolderAccess(
        'raw/telemetry',
        indexFolders(data().folders!.folders),
        member,
      ),
    ).toBe('none');
  });
});
