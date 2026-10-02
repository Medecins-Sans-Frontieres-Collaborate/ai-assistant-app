import { indexFolders } from '@/lib/services/analytics/access';
import { isStateCurrent } from '@/lib/services/analytics/fileState';
import { findHeaderRow } from '@/lib/services/analytics/tables';
import {
  MAX_INSPECT_BYTES,
  needsContent,
  validateDelivery,
} from '@/lib/services/analytics/validate';

import { blob, folder } from './fixtures';
import { CLEAN_PARQUET_BASE64, LEAKY_PARQUET_BASE64 } from './parquetFixtures';
import { CLEAN_USERS, Row, usageSheets, workbook } from './workbooks';

import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';

const NOW = new Date('2026-08-03T09:00:00.000Z');
const USAGE_FOLDERS = indexFolders([folder('usage', { reportType: 'usage' })]);
const NO_TYPES = indexFolders([]);
const USAGE_PATH = 'usage/ocba/ocba_report_2026-07-01_to_2026-07-31.xlsx';

function run(
  path: string,
  content: Buffer | null,
  folders = USAGE_FOLDERS,
  size = content?.length ?? 1000,
) {
  return validateDelivery({
    blob: blob(path, { size }),
    content,
    folders,
    now: NOW,
  });
}

async function validate(...args: Parameters<typeof run>) {
  return (await run(...args)).state;
}

const codes = (state: { issues: { code: string }[] }) =>
  state.issues.map((issue) => issue.code);

describe('validateDelivery', () => {
  it('passes a complete report and records its text columns only', async () => {
    const { state, tables } = await run(USAGE_PATH, workbook(usageSheets()));
    expect(state.status).toBe('ok');
    expect(state.issues).toEqual([]);
    expect(state.inspected).toBe(true);
    expect(state.reportType).toBe('usage');
    // Numbers and dates are measures: never classified, never hidden.
    expect(state.columns).toEqual([
      'slice',
      'top_job_title',
      'UserId',
      'UserDepartment',
      'UserJobTitle',
      'ModelUsed',
    ]);
    // The tables it read come back for the stored preview.
    expect(tables?.map((table) => table.name)).toEqual([
      'Summary',
      'Users',
      'Daily',
      'Weekly',
      'Interactions',
    ]);
  });

  it('quarantines a file with an identifier column, and offers no preview of it', async () => {
    const { state, tables } = await run(
      USAGE_PATH,
      workbook({
        Users: [
          ['UserId', 'UserEmail', 'total_interactions'],
          ['u-93d80e8bfd9b', 'someone', 3],
        ],
      }),
      NO_TYPES,
    );
    expect(state.status).toBe('error');
    expect(state.issues).toContainEqual({
      code: 'identifier-column',
      severity: 'error',
      params: { sheet: 'Users', column: 'UserEmail' },
    });
    expect(tables).toBeNull();
  });

  it('finds an email address in any cell, far past the rows it reads', async () => {
    const rows: Row[] = [['UserId', 'Note']];
    for (let i = 0; i < 6000; i++) rows.push(['u-93d80e8bfd9b', 'fine']);
    rows.push(['u-93d80e8bfd9b', 'ask jane.doe@example.org']);
    const state = await validate(
      USAGE_PATH,
      workbook({ Users: rows }),
      NO_TYPES,
    );
    expect(state.status).toBe('error');
    const hit = state.issues.find((i) => i.code === 'identifier-values');
    expect(hit?.params).toEqual({ sheet: 'Users', count: 1 });
    // The address itself is never copied into the record.
    expect(JSON.stringify(state)).not.toContain('jane.doe');
  });

  it('does not mistake an @ that is not an address for one', async () => {
    const state = await validate(
      USAGE_PATH,
      workbook({
        Users: [
          ['UserId', 'Note'],
          ['u-93d80e8bfd9b', 'rate @ 4 per day'],
          ['u-f7d440cec18d', 'handle @someone, no domain'],
        ],
      }),
      NO_TYPES,
    );
    expect(state.status).toBe('ok');
  });

  it('scans a long unbroken value in linear time', async () => {
    const started = Date.now();
    const state = await validate(
      USAGE_PATH,
      workbook({
        Users: [
          ['UserId', 'Note'],
          ['u-93d80e8bfd9b', 'A'.repeat(30_000)],
        ],
      }),
      NO_TYPES,
    );
    expect(state.status).toBe('ok');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('quarantines user ids that are not pseudonymous codes', async () => {
    const state = await validate(
      USAGE_PATH,
      workbook({
        Users: [
          ['UserId', 'UserDepartment'],
          ['7c3488f9-df83-47e8-b6cd-8ca8a161e005', 'Logistics'],
          ['u-93d80e8bfd9b', 'Logistics'],
        ],
      }),
      NO_TYPES,
    );
    expect(state.status).toBe('error');
    expect(state.issues).toContainEqual({
      code: 'user-code-format',
      severity: 'error',
      params: { sheet: 'Users', column: 'UserId', count: 1 },
    });
  });

  it('warns about formulas that carry no stored result', async () => {
    const wb = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ['Model', 'Requests'],
      ['gpt-5.4', 4],
      ['gpt-5.2', 6],
    ]);
    sheet['B4'] = { t: 'n', f: 'SUM(B2:B3)' } as XLSX.CellObject;
    sheet['!ref'] = 'A1:B4';
    XLSX.utils.book_append_sheet(wb, sheet, 'Detail');
    const state = await validate(
      USAGE_PATH,
      XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer,
      NO_TYPES,
    );
    expect(state.status).toBe('warning');
    expect(state.issues).toContainEqual({
      code: 'formulas-without-values',
      severity: 'warning',
      params: { sheet: 'Detail', count: 1 },
    });
  });

  describe('structure of a typed report', () => {
    it('names a missing sheet and a missing column, as warnings', async () => {
      const sheets = usageSheets({
        Daily: [
          ['date', 'interactions'],
          ['2026-07-01', 681],
        ],
      });
      delete sheets.Weekly;
      const { state, tables } = await run(USAGE_PATH, workbook(sheets));
      expect(state.status).toBe('warning');
      expect(state.issues).toEqual([
        {
          code: 'missing-column',
          severity: 'warning',
          params: { sheet: 'Daily', column: 'unique_users' },
        },
        {
          code: 'missing-sheet',
          severity: 'warning',
          params: { sheet: 'Weekly' },
        },
      ]);
      // Still previewable and downloadable: only the views that need the
      // missing piece are affected.
      expect(tables).not.toBeNull();
    });

    it('matches required columns without regard to case or spacing', async () => {
      const state = await validate(
        USAGE_PATH,
        workbook(
          usageSheets({
            Weekly: [
              [' Week_Start ', 'UNIQUE_USERS', 'interactions'],
              ['2026-06-29', 111, 1937],
            ],
          }),
        ),
      );
      expect(state.status).toBe('ok');
    });

    it('asks nothing of a folder with no report type', async () => {
      const state = await validate(
        'misc/anything_2026-07.xlsx',
        workbook({ Users: CLEAN_USERS }),
        NO_TYPES,
      );
      expect(state.status).toBe('ok');
    });
  });

  it('warns when the name is not what the folder’s report type expects', async () => {
    const state = await validate(
      'usage/ocba/final_v2.xlsx',
      workbook(usageSheets()),
    );
    expect(state.status).toBe('warning');
    expect(codes(state)).toEqual(['name-mismatch', 'no-period']);
  });

  it('reports a damaged file instead of throwing', async () => {
    const { state, tables } = await run(
      USAGE_PATH,
      Buffer.from('not a workbook at all'),
    );
    expect(state.status).toBe('error');
    expect(codes(state)).toEqual(['unreadable']);
    expect(state.inspected).toBe(false);
    expect(tables).toBeNull();
  });

  it('quarantines what it cannot open outside raw/', async () => {
    expect(
      codes(await validate('usage/ocba/report_2026-07.pdf', null, NO_TYPES)),
    ).toEqual(['unsupported-format']);
    expect(
      codes(
        await validate(
          'usage/ocba/report_2026-07.xlsx',
          null,
          NO_TYPES,
          MAX_INSPECT_BYTES + 1,
        ),
      ),
    ).toEqual(['too-large']);
    expect(
      codes(
        await validate('usage/ocba/report_2026-07.xlsx', null, NO_TYPES, 0),
      ),
    ).toEqual(['empty-file']);
  });

  it('does not open raw telemetry, and does not flag it for that', async () => {
    const raw = blob('raw/telemetry/2026/09/2026-09-26.parquet');
    expect(needsContent(raw)).toBe(false);
    const { state, tables } = await validateDelivery({
      blob: raw,
      content: null,
      folders: indexFolders([
        folder('raw/telemetry', { reportType: 'raw-telemetry' }),
      ]),
      now: NOW,
    });
    expect(state.status).toBe('ok');
    expect(state.issues).toEqual([]);
    // No stored copy of raw rows.
    expect(tables).toBeNull();
  });

  it('declares the fields of a laid-out sheet instead of scanning it', async () => {
    const emissions = workbook({
      Summary: [
        ['Emissions summary - 2026-09'],
        [],
        ['By department'],
        [null, 'Requests', 'Total tokens'],
        ['Fundraising', 12, 3400],
      ],
      'Usage detail': [
        ['User code', 'Department', 'Model', 'Requests'],
        ['u-001c028d2af0', 'Fundraising', 'gpt-5.4', 12],
      ],
    });
    const path = 'emissions/de/emissions_report_2026-09_MSF-Germany.xlsx';
    const typed = await validate(
      path,
      emissions,
      indexFolders([folder('emissions', { reportType: 'emissions' })]),
    );
    expect(typed.columns).toEqual(['User code', 'Department', 'Model']);
    expect(typed.declaredFields).toEqual(['department', 'technical']);

    // Without the report type the layout sheet is read as a table and yields
    // a column nobody can classify — which is why the type matters.
    const untyped = await validate(path, emissions, NO_TYPES);
    expect(untyped.columns).toContain('Column A');
  });

  it('files a page nobody declared under the catch-all field', async () => {
    const state = await validate(
      'misc/notes_2026-07.xlsx',
      workbook({
        Cover: [
          ['Prepared for the board', 2026],
          ['Contact', 42],
        ],
      }),
      NO_TYPES,
    );
    expect(state.declaredFields).toEqual(['other']);
  });

  it('reads a CSV the same way', async () => {
    const csv = Buffer.from(
      'UserId,UserDepartment,total\nu-93d80e8bfd9b,Logistics,4\n',
    );
    const state = await validate('usage/ocba/users_2026-07.csv', csv, NO_TYPES);
    expect(state.status).toBe('ok');
    expect(state.columns).toEqual(['UserId', 'UserDepartment']);
  });

  describe('parquet outside raw/', () => {
    it('is opened and passes when it is clean', async () => {
      const { state, tables } = await run(
        'usage/ocba/interactions_2026-07.parquet',
        Buffer.from(CLEAN_PARQUET_BASE64, 'base64'),
        NO_TYPES,
      );
      expect(state.status).toBe('ok');
      expect(state.columns).toEqual(['UserId', 'UserDepartment']);
      expect(tables?.[0]).toMatchObject({ name: 'data', rowCount: 3 });
    });

    it('is quarantined when a text column holds an address', async () => {
      const state = await validate(
        'usage/ocba/interactions_2026-07.parquet',
        Buffer.from(LEAKY_PARQUET_BASE64, 'base64'),
        NO_TYPES,
      );
      expect(state.status).toBe('error');
      expect(state.issues).toContainEqual({
        code: 'identifier-values',
        severity: 'error',
        params: { sheet: 'Note', count: 1 },
      });
    });
  });

  it('keeps firstSeenAt while a file stays wrong, and resets it once clean', async () => {
    const bad = Buffer.from('nope');
    const first = await validate(USAGE_PATH, bad);
    const again = await validateDelivery({
      blob: blob(USAGE_PATH, { size: bad.length }),
      content: bad,
      folders: USAGE_FOLDERS,
      previous: { ...first, firstSeenAt: '2026-07-01T00:00:00.000Z' },
      now: NOW,
    });
    expect(again.state.firstSeenAt).toBe('2026-07-01T00:00:00.000Z');
  });
});

describe('findHeaderRow', () => {
  it('skips the title rows above a table', () => {
    expect(
      findHeaderRow([
        ['AI Assistant rebilling — 2026-07'],
        ['Every Section below is a value from the Cost Recovery list'],
        [],
        ['Section', 'Usage events', 'Billed'],
        ['OC Amsterdam', 85869, 4209.76],
      ]),
    ).toBe(3);
  });

  it('takes the first cell of a one-column sheet', () => {
    expect(findHeaderRow([['Section'], ['Argentina'], ['Australia']])).toBe(0);
  });

  it('gives up on a sheet with no label row', () => {
    expect(
      findHeaderRow([
        ['Requests', 12],
        ['Active users', 181],
      ]),
    ).toBe(-1);
  });
});

describe('isStateCurrent', () => {
  const delivered = blob(USAGE_PATH);

  async function record() {
    return (
      await validateDelivery({
        blob: delivered,
        content: workbook(usageSheets()),
        folders: USAGE_FOLDERS,
        now: NOW,
      })
    ).state;
  }

  it('holds while the bytes and the folder’s report type are unchanged', async () => {
    expect(isStateCurrent(await record(), delivered, USAGE_FOLDERS)).toBe(true);
  });

  it('lapses when the file is replaced', async () => {
    expect(
      isStateCurrent(
        await record(),
        { ...delivered, lastModified: '2026-08-09T00:00:00.000Z' },
        USAGE_FOLDERS,
      ),
    ).toBe(false);
  });

  it('lapses when the folder’s report type changes', async () => {
    expect(isStateCurrent(await record(), delivered, NO_TYPES)).toBe(false);
  });

  it('lapses for a record written by an OLDER validator', async () => {
    const current = await record();
    expect(
      isStateCurrent(
        { ...current, validatorVersion: current.validatorVersion - 1 },
        delivered,
        USAGE_FOLDERS,
      ),
    ).toBe(false);
  });

  it('accepts a record from a NEWER validator (beta writes, prod reads)', async () => {
    const current = await record();
    expect(
      isStateCurrent(
        { ...current, validatorVersion: current.validatorVersion + 1 },
        delivered,
        USAGE_FOLDERS,
      ),
    ).toBe(true);
  });
});
