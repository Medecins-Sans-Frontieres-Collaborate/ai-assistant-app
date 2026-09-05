/**
 * Write-side canonicalization (lib/services/limits/policyWriteSchema.ts).
 *
 * Contract: the write schema canonicalizes jurisdiction targets and
 * delegation admins (trim, lowercase, dedupe, drop blank) BEFORE its own
 * non-empty rule runs, so it refuses exactly what the READ schema
 * (`JurisdictionPredicateSchema.targets.min(1)`) would refuse — a body the
 * route accepts can never fail the read-schema parse inside `writePolicy`
 * and surface as a 500 with a raw zod dump.
 */
import {
  canonicalList,
  delegationWriteSchema,
  formatIssues,
  jurisdictionPredicateWriteSchema,
} from '@/lib/services/limits/policyWriteSchema';
import { JurisdictionPredicateSchema } from '@/lib/services/limits/types';

import { describe, expect, it } from 'vitest';

describe('canonicalList', () => {
  it('trims, lowercases, dedupes and drops blanks; idempotent', () => {
    const once = canonicalList([' OCP.msf.org ', 'ocp.msf.org', '   ', '']);
    expect(once).toEqual(['ocp.msf.org']);
    expect(canonicalList(once)).toEqual(once);
  });
});

describe('jurisdictionPredicateWriteSchema', () => {
  it('canonicalizes targets in the parsed output', () => {
    const parsed = jurisdictionPredicateWriteSchema.parse({
      scope: 'domain',
      targets: [' OCP.msf.org ', 'ocp.msf.org', '  '],
    });
    expect(parsed.targets).toEqual(['ocp.msf.org']);
    // What the write side accepts, the read side accepts.
    expect(JurisdictionPredicateSchema.safeParse(parsed).success).toBe(true);
  });

  it('refuses a predicate whose targets are all whitespace with a `targets` issue — exactly what the read schema refuses', () => {
    const input = { scope: 'domain', targets: ['   ', '\t'] };
    const result = jurisdictionPredicateWriteSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(formatIssues(result.error)).toMatch(/^targets: /);
    // The read schema would have thrown on the canonicalized form.
    expect(
      JurisdictionPredicateSchema.safeParse({
        scope: 'domain',
        targets: canonicalList(input.targets),
      }).success,
    ).toBe(false);
  });

  it('still refuses an empty list and an empty string outright', () => {
    expect(
      jurisdictionPredicateWriteSchema.safeParse({
        scope: 'domain',
        targets: [],
      }).success,
    ).toBe(false);
    expect(
      jurisdictionPredicateWriteSchema.safeParse({
        scope: 'domain',
        targets: [''],
      }).success,
    ).toBe(false);
  });
});

describe('delegationWriteSchema', () => {
  it('canonicalizes admins (an all-blank list becomes an empty, legal one)', () => {
    const parsed = delegationWriteSchema.parse({
      admins: [' OCP-Admin@ocp.msf.org ', 'ocp-admin@ocp.msf.org', '    '],
    });
    expect(parsed.admins).toEqual(['ocp-admin@ocp.msf.org']);
    expect(delegationWriteSchema.parse({ admins: ['    '] }).admins).toEqual(
      [],
    );
    expect(delegationWriteSchema.parse({}).admins).toEqual([]);
  });

  it('reports a whitespace-only target under the delegation path', () => {
    const result = delegationWriteSchema.safeParse({
      jurisdiction: [{ scope: 'domain', targets: ['   '] }],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(formatIssues(result.error)).toContain('jurisdiction.0.targets');
  });
});
