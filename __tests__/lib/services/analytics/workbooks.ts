import * as XLSX from 'xlsx';

export type Row = (string | number | boolean | null)[];

export function workbook(sheets: Record<string, Row[]>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export const CLEAN_USERS: Row[] = [
  [
    'UserId',
    'UserDepartment',
    'UserJobTitle',
    'total_interactions',
    'days_active',
    'first_seen',
  ],
  [
    'u-93d80e8bfd9b',
    'Medical Department',
    'Nutrition Referent',
    1108,
    22,
    '2026-07-01',
  ],
  ['u-f7d440cec18d', 'Logistics', 'Site Follow-up', 885, 23, '2026-07-01'],
];

/** Every sheet and column the `usage` report type requires. */
export function usageSheets(
  overrides: Record<string, Row[]> = {},
): Record<string, Row[]> {
  return {
    Summary: [
      ['slice', 'unique_users', 'interactions', 'top_job_title'],
      ['OCBA', 222, 19029, 'logco'],
      ['All MSF', 3292, 273609, 'PROJECT COORDINATOR'],
    ],
    Users: CLEAN_USERS,
    Daily: [
      ['date', 'unique_users', 'interactions'],
      ['2026-07-01', 73, 681],
      ['2026-07-02', 71, 603],
    ],
    Weekly: [
      ['week_start', 'unique_users', 'interactions'],
      ['2026-06-29', 111, 1937],
    ],
    Interactions: [
      ['UserId', 'ModelUsed', 'MessageCount', 'event_date'],
      ['u-93d80e8bfd9b', 'gpt-5.2-chat', 3, '2026-07-01'],
      ['u-f7d440cec18d', 'gpt-5.4', 9, '2026-07-02'],
    ],
    ...overrides,
  };
}
