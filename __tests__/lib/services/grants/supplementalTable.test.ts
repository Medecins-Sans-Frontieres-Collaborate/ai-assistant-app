import { ALLOCATION_COLUMN_ALIASES } from '@/lib/services/grants/allocationList';
import {
  loadTable,
  resolveColumn,
} from '@/lib/services/grants/supplementalTable';

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Reproduces the shape of a real OC allocation list — a plural "Project Codes"
 * header with the columns in a non-default order — and asserts the loader +
 * column resolver recover the expected roster. This is the parsing half of the
 * "allocation list not recognized" investigation.
 */
describe('allocation-list parsing', () => {
  let dir: string;
  let csvPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'alloc-test-'));
    csvPath = join(dir, 'OCA-Allocation-List.csv');
    writeFileSync(
      csvPath,
      'Project Codes,Country,Project Name\r\n' +
        'P1036,Haiti,Port-au-Prince SGBV\r\n' +
        'P1655,Haiti,Port-au-Prince SRH\r\n' +
        'P1341,India,Patna advanced HIV\r\n',
    );
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('resolves a plural, reordered header against the default OCA spec', () => {
    const rows = loadTable(csvPath, 0);
    expect(rows).toHaveLength(3);

    const headers = Object.keys(rows[0]);
    expect(headers).toEqual(['Project Codes', 'Country', 'Project Name']);

    const codeCol = resolveColumn(headers, 'Project Code', [
      ...ALLOCATION_COLUMN_ALIASES.code,
    ]);
    const nameCol = resolveColumn(headers, 'Project Name', [
      ...ALLOCATION_COLUMN_ALIASES.name,
    ]);
    const countryCol = resolveColumn(headers, 'Country', [
      ...ALLOCATION_COLUMN_ALIASES.country,
    ]);

    // "Project Codes" (plural) must still resolve to the code column.
    expect(codeCol).toBe('Project Codes');
    expect(nameCol).toBe('Project Name');
    expect(countryCol).toBe('Country');

    const codes = rows.map((r) => String(r[codeCol!]).trim());
    expect(codes).toEqual(['P1036', 'P1655', 'P1341']);
  });
});
