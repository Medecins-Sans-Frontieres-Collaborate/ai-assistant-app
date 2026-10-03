import {
  hasAnyAnalyticsAccess,
  indexFolders,
  resolveFolderAccess,
} from '@/lib/services/analytics/access';

import { actor, folder } from './fixtures';

import { describe, expect, it } from 'vitest';

const OCBA_GROUP = '11111111-1111-1111-1111-111111111111';

describe('resolveFolderAccess', () => {
  it('denies by default: an unconfigured folder is nobody’s but the admins’', () => {
    const folders = indexFolders([]);
    expect(resolveFolderAccess('usage/ocba', folders, actor())).toBe('none');
    expect(
      resolveFolderAccess(
        'usage/ocba',
        folders,
        actor({ isAnalyticsAdmin: true }),
      ),
    ).toBe('admin');
  });

  it('denies a configured folder with an empty audience', () => {
    const folders = indexFolders([folder('usage/ocba')]);
    expect(resolveFolderAccess('usage/ocba', folders, actor())).toBe('none');
  });

  it('grants the level of the matching audience entry, by group', () => {
    const folders = indexFolders([
      folder('usage/ocba', {
        audience: [{ scope: 'group', targets: [OCBA_GROUP], level: 'view' }],
      }),
    ]);
    expect(
      resolveFolderAccess(
        'usage/ocba',
        folders,
        actor({ groupIds: [OCBA_GROUP] }),
      ),
    ).toBe('view');
    // A cold or failed group cache yields no groups: nothing is granted.
    expect(resolveFolderAccess('usage/ocba', folders, actor())).toBe('none');
  });

  it('takes the strongest of several matching entries', () => {
    const folders = indexFolders([
      folder('usage/ocba', {
        audience: [
          { scope: 'domain', targets: ['ocba.example.org'], level: 'view' },
          {
            scope: 'user',
            targets: ['user@ocba.example.org'],
            level: 'download',
          },
        ],
      }),
    ]);
    expect(resolveFolderAccess('usage/ocba', folders, actor())).toBe(
      'download',
    );
    expect(
      resolveFolderAccess(
        'usage/ocba',
        folders,
        actor({ mail: 'other@ocba.example.org' }),
      ),
    ).toBe('view');
  });

  it('inherits a grant down the tree, including into unconfigured folders', () => {
    const folders = indexFolders([
      folder('usage', {
        audience: [
          { scope: 'domain', targets: ['ocba.example.org'], level: 'download' },
        ],
      }),
    ]);
    expect(resolveFolderAccess('usage/ocba/2026', folders, actor())).toBe(
      'download',
    );
    // …but never sideways or upwards.
    expect(resolveFolderAccess('rebilling', folders, actor())).toBe('none');
    expect(resolveFolderAccess('', folders, actor())).toBe('none');
  });

  it('stops inheriting at a restricted folder, whose own entries still apply', () => {
    const folders = indexFolders([
      folder('usage', {
        audience: [
          { scope: 'domain', targets: ['ocba.example.org'], level: 'download' },
        ],
      }),
      folder('usage/ocg', {
        restricted: true,
        audience: [
          { scope: 'user', targets: ['lead@ocg.example.org'], level: 'view' },
        ],
      }),
    ]);
    expect(resolveFolderAccess('usage/ocg', folders, actor())).toBe('none');
    expect(resolveFolderAccess('usage/ocg/2026', folders, actor())).toBe(
      'none',
    );
    expect(
      resolveFolderAccess(
        'usage/ocg/2026',
        folders,
        actor({ mail: 'lead@ocg.example.org' }),
      ),
    ).toBe('view');
    // The sibling is untouched by the restriction.
    expect(resolveFolderAccess('usage/ocba', folders, actor())).toBe(
      'download',
    );
  });

  describe('raw telemetry', () => {
    // An audience on raw can only exist if written around the API; the
    // evaluator must ignore it regardless.
    const folders = indexFolders([
      folder('', {
        audience: [
          { scope: 'domain', targets: ['ocba.example.org'], level: 'download' },
        ],
      }),
      folder('raw', {
        audience: [
          { scope: 'domain', targets: ['ocba.example.org'], level: 'download' },
        ],
      }),
    ]);

    it('is closed to everyone but global admins, whatever is stored', () => {
      expect(resolveFolderAccess('raw/telemetry', folders, actor())).toBe(
        'none',
      );
    });

    it('is closed to a delegated analytics admin', () => {
      expect(
        resolveFolderAccess(
          'raw/telemetry',
          folders,
          actor({ isAnalyticsAdmin: true, isGlobalAdmin: false }),
        ),
      ).toBe('none');
    });

    it('is open to a global admin', () => {
      expect(
        resolveFolderAccess(
          'raw/telemetry',
          folders,
          actor({ isGlobalAdmin: true }),
        ),
      ).toBe('admin');
    });

    it('cannot be sidestepped by the case of the folder name', () => {
      for (const path of ['Raw', 'RAW/telemetry', 'rAw/x/y']) {
        expect(resolveFolderAccess(path, folders, actor())).toBe('none');
      }
      // A folder that merely starts with the letters is not raw.
      expect(resolveFolderAccess('rawdata', folders, actor())).toBe('download');
    });
  });
});

describe('hasAnyAnalyticsAccess', () => {
  const folders = indexFolders([
    folder('rebilling', {
      audience: [
        { scope: 'attribute', targets: ['department:finance'], level: 'view' },
      ],
    }),
  ]);

  it('is true for someone an audience names, false otherwise', () => {
    expect(
      hasAnyAnalyticsAccess(
        folders,
        actor({ attributes: ['department:finance'] }),
      ),
    ).toBe(true);
    expect(hasAnyAnalyticsAccess(folders, actor())).toBe(false);
  });

  it('is true for an analytics admin even with nothing configured', () => {
    expect(
      hasAnyAnalyticsAccess(
        indexFolders([]),
        actor({ isAnalyticsAdmin: true }),
      ),
    ).toBe(true);
  });
});
