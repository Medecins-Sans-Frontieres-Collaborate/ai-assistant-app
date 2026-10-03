import { indexFolders } from '@/lib/services/analytics/access';
import {
  classifyColumn,
  effectiveHiddenFields,
  isIdentifierColumn,
  originalRestriction,
  summarizeFileFields,
} from '@/lib/services/analytics/fields';

import { folder } from './fixtures';

import { describe, expect, it } from 'vitest';

describe('classifyColumn', () => {
  it('maps the several names one field travels under onto that field', () => {
    for (const column of ['UserJobTitle', 'top_job_title', ' Job  Title ']) {
      expect(classifyColumn(column, null)).toBe('jobTitle');
    }
    expect(classifyColumn('UserId', null)).toBe('userCode');
    expect(classifyColumn('Mail domain', null)).toBe('mailDomain');
  });

  it('leaves an unknown column unclassified until an admin files it', () => {
    expect(classifyColumn('UserCountry', null)).toBeNull();
    expect(
      classifyColumn('UserCountry', { columns: { usercountry: 'other' } }),
    ).toBe('other');
  });

  it('lets the built-in catalog win over a stored mapping', () => {
    expect(
      classifyColumn('UserJobTitle', {
        columns: { userjobtitle: 'technical' },
      }),
    ).toBe('jobTitle');
  });

  it('ignores a stored mapping to a field that does not exist', () => {
    expect(
      classifyColumn('UserCountry', { columns: { usercountry: 'nonsense' } }),
    ).toBeNull();
  });
});

describe('isIdentifierColumn', () => {
  it('recognises direct identifiers and not their harmless neighbours', () => {
    for (const column of ['UserEmail', 'userDisplayName', 'File Name', 'UPN']) {
      expect(isIdentifierColumn(column), column).toBe(true);
    }
    for (const column of ['Mail domain', 'UserId', 'Section Name', 'Model']) {
      expect(isIdentifierColumn(column), column).toBe(false);
    }
  });
});

describe('effectiveHiddenFields', () => {
  it('is the platform policy plus every ancestor’s extras — never less', () => {
    const folders = indexFolders([
      folder('usage', { hiddenFields: ['workLocation'] }),
      folder('usage/ocba', { hiddenFields: ['department'] }),
    ]);
    const policy = { hidden: ['jobTitle'] };
    expect(
      [...effectiveHiddenFields('usage/ocba/2026', folders, policy)].sort(),
    ).toEqual(['department', 'jobTitle', 'workLocation']);
    expect([...effectiveHiddenFields('rebilling', folders, policy)]).toEqual([
      'jobTitle',
    ]);
  });
});

describe('originalRestriction', () => {
  const usage = {
    columns: ['UserId', 'UserJobTitle', 'UserDepartment'],
    declaredFields: [],
    inspected: true,
  };

  it('allows the delivered file when nothing in it is hidden (the default)', () => {
    expect(originalRestriction(usage, new Set(), null)).toBeNull();
  });

  it('blocks it once a field it contains is hidden', () => {
    expect(originalRestriction(usage, new Set(['jobTitle']), null)).toBe(
      'hidden-fields',
    );
    // Hiding a field the file does not contain changes nothing.
    expect(originalRestriction(usage, new Set(['section']), null)).toBeNull();
  });

  it('blocks it while a column is unclassified, and unblocks when filed', () => {
    const withNew = { ...usage, columns: [...usage.columns, 'UserCountry'] };
    expect(originalRestriction(withNew, new Set(), null)).toBe(
      'unclassified-fields',
    );
    expect(
      originalRestriction(withNew, new Set(), {
        columns: { usercountry: 'other' },
      }),
    ).toBeNull();
  });

  it('counts fields a report type declares for its laid-out sheets', () => {
    const emissions = {
      columns: [],
      declaredFields: ['department'],
      inspected: true,
    };
    expect(summarizeFileFields(emissions, null).fields).toEqual(['department']);
    expect(originalRestriction(emissions, new Set(['department']), null)).toBe(
      'hidden-fields',
    );
  });

  it('blocks a file whose contents were never opened', () => {
    expect(
      originalRestriction({ ...usage, inspected: false }, new Set(), null),
    ).toBe('not-inspected');
  });
});
