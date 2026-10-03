import { AnalyticsFieldId } from '@/lib/services/analytics/fields';
import {
  PreviewContext,
  summarizeTable,
  viewTable,
} from '@/lib/services/analytics/previewModel';
import { DerivedTable, gridToTable } from '@/lib/services/analytics/tables';

import { describe, expect, it } from 'vitest';

function context(
  access: PreviewContext['access'],
  hidden: AnalyticsFieldId[] = [],
  columns: Record<string, string> = {},
): PreviewContext {
  return { access, hidden: new Set(hidden), policy: { columns } };
}

const USERS: DerivedTable = gridToTable({
  name: 'Users',
  grid: [
    ['UserId', 'UserJobTitle', 'UserCountry', 'total_interactions'],
    ['u-93d80e8bfd9b', 'Nutrition Referent', 'ES', 1108],
    ['u-f7d440cec18d', 'Site Follow-up', 'CH', 885],
  ],
  sourceRows: 3,
  freeform: false,
  declaredFields: [],
  maxRows: 5000,
});

const DAILY: DerivedTable = gridToTable({
  name: 'Daily',
  grid: [
    ['date', 'unique_users', 'top_job_title'],
    ['2026-07-01', 73, 'logco'],
  ],
  sourceRows: 2,
  freeform: false,
  declaredFields: [],
  maxRows: 5000,
});

const SUMMARY_PAGE: DerivedTable = gridToTable({
  name: 'Summary',
  grid: [['By department'], ['Fundraising', 12]],
  sourceRows: 2,
  freeform: true,
  declaredFields: ['department', 'technical'],
  maxRows: 5000,
});

const names = (view: ReturnType<typeof viewTable>) =>
  view?.columns.map((column) => column.name);

describe('viewTable', () => {
  it('withholds a per-person table at view level, and says why', () => {
    expect(viewTable(USERS, context('view'))).toBeNull();
    expect(summarizeTable(USERS, context('view')).withheld).toBe('row-level');
  });

  it('shows an aggregate table at view level', () => {
    expect(names(viewTable(DAILY, context('view')))).toEqual([
      'date',
      'unique_users',
      'top_job_title',
    ]);
  });

  it('removes an unclassified column for users, and keeps the rows aligned', () => {
    const view = viewTable(USERS, context('download'))!;
    expect(names(view)).toEqual([
      'UserId',
      'UserJobTitle',
      'total_interactions',
    ]);
    expect(view.rows[0]).toEqual([
      'u-93d80e8bfd9b',
      'Nutrition Referent',
      1108,
    ]);
  });

  it('shows that column once an admin has filed it under a field', () => {
    expect(
      names(
        viewTable(USERS, context('download', [], { usercountry: 'other' })),
      ),
    ).toContain('UserCountry');
  });

  it('removes a hidden field wherever it travels, including as a value column', () => {
    const hidden = context('download', ['jobTitle'], { usercountry: 'other' });
    expect(names(viewTable(USERS, hidden))).toEqual([
      'UserId',
      'UserCountry',
      'total_interactions',
    ]);
    expect(names(viewTable(DAILY, hidden))).toEqual(['date', 'unique_users']);
  });

  it('never removes a measure', () => {
    const everything = context('download', [
      'userCode',
      'jobTitle',
      'department',
      'company',
      'orgGroup',
      'section',
      'mailDomain',
      'workLocation',
      'technical',
      'other',
    ]);
    expect(names(viewTable(USERS, everything))).toEqual(['total_interactions']);
  });

  it('keeps a table row-level even after the user-code field is hidden', () => {
    // Stripping the code column does not turn per-person rows into an
    // aggregate: job title and department are still one row per person.
    const hidden = context('view', ['userCode']);
    expect(viewTable(USERS, hidden)).toBeNull();
  });

  it('withholds a laid-out page whole when it holds a hidden field', () => {
    expect(viewTable(SUMMARY_PAGE, context('view'))).not.toBeNull();
    const hidden = context('download', ['department']);
    expect(viewTable(SUMMARY_PAGE, hidden)).toBeNull();
    expect(summarizeTable(SUMMARY_PAGE, hidden).withheld).toBe('hidden-fields');
  });

  it('shows admins everything, marking what users do not get', () => {
    const view = viewTable(USERS, context('admin', ['jobTitle']))!;
    expect(
      view.columns.map((column) => [column.name, column.hiddenFromUsers]),
    ).toEqual([
      ['UserId', false],
      ['UserJobTitle', true],
      ['UserCountry', true],
      ['total_interactions', false],
    ]);
    expect(view.rows).toBe(USERS.rows);
    const page = viewTable(SUMMARY_PAGE, context('admin', ['department']))!;
    expect(page.columns.every((column) => column.hiddenFromUsers)).toBe(true);
  });
});
