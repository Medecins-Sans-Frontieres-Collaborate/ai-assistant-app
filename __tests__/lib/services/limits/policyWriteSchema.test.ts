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
  entrySchema,
  formatIssues,
  jurisdictionPredicateWriteSchema,
  modelAccessRuleSchema,
  overrideSchema,
  putBodySchema,
  scopedOverrideBodySchema,
} from '@/lib/services/limits/policyWriteSchema';
import { JurisdictionPredicateSchema } from '@/lib/services/limits/types';

import { describe, expect, it } from 'vitest';

describe('modelAccessRuleSchema', () => {
  it('accepts a rule with one dimension, canonicalizes grants and the block list, dedupes by target', () => {
    const parsed = modelAccessRuleSchema.parse({
      series: 'Claude',
      defaultAccess: false,
      groups: [
        { target: ' 0F3A9C2B-0000-4000-8000-000000000001 ' },
        { target: '0f3a9c2b-0000-4000-8000-000000000001', requests: 5 },
      ],
      domains: [{ target: 'OCP.msf.org', requests: null }],
      allow: [{ target: 'Alice@MSF.org', requests: 20 }],
      deny: [' Mallory@msf.org ', 'mallory@msf.org'],
    });
    expect(parsed).toEqual({
      series: 'Claude',
      defaultAccess: false,
      groups: [
        { target: '0f3a9c2b-0000-4000-8000-000000000001', requests: null },
      ],
      domains: [{ target: 'ocp.msf.org', requests: null }],
      allow: [{ target: 'alice@msf.org', requests: 20 }],
      deny: ['mallory@msf.org'],
    });
  });

  it('refuses no dimension, both dimensions, a zero cap, an unknown key, and allow ∩ deny', () => {
    const base = { groups: [], domains: [], allow: [], deny: [] };
    expect(modelAccessRuleSchema.safeParse({ ...base }).success).toBe(false);
    expect(
      modelAccessRuleSchema.safeParse({ ...base, modelId: 'o3', series: 'gpt' })
        .success,
    ).toBe(false);
    expect(
      modelAccessRuleSchema.safeParse({
        ...base,
        modelId: 'o3',
        defaultAccess: 0,
      }).success,
    ).toBe(false);
    expect(
      modelAccessRuleSchema.safeParse({
        ...base,
        modelId: 'o3',
        allow: [{ target: 'a@x.org', requests: 0 }],
      }).success,
    ).toBe(false);
    expect(
      modelAccessRuleSchema.safeParse({ ...base, modelId: 'o3', extra: 1 })
        .success,
    ).toBe(false);
    expect(
      modelAccessRuleSchema.safeParse({
        ...base,
        modelId: 'o3',
        allow: [{ target: 'A@x.org' }],
        deny: ['a@x.org'],
      }).success,
    ).toBe(false);
  });

  it('putBodySchema leaves modelAccess undefined when the key is absent (stale-client guard)', () => {
    const parsed = putBodySchema.parse({ defaults: [], overrides: [] });
    expect(parsed.modelAccess).toBeUndefined();
  });
});

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

describe('value shape follows the catalog unit (review 2026-09-12)', () => {
  it('refuses a boolean on a numeric key — `true` would read as unlimited past every ceiling', () => {
    const numeric = entrySchema.safeParse({
      limitKey: 'feature.upload.megabytesPerFile',
      value: true,
    });
    expect(numeric.success).toBe(false);
    const gate = entrySchema.safeParse({
      limitKey: 'feature.webSearch.enabled',
      value: 5,
    });
    expect(gate.success).toBe(false);
  });

  it('accepts the shapes the editor produces', () => {
    expect(
      entrySchema.safeParse({ limitKey: 'chat.messagesPerDay', value: 0 })
        .success,
    ).toBe(true);
    expect(
      entrySchema.safeParse({ limitKey: 'chat.messagesPerDay', value: null })
        .success,
    ).toBe(true);
    expect(
      entrySchema.safeParse({ limitKey: 'feature.mcp.enabled', value: false })
        .success,
    ).toBe(true);
  });
});

describe('override targets are stored canonical (review 2026-09-12)', () => {
  it('trims, lowercases, dedupes and drops blanks on both write schemas', () => {
    const raw = [' Ada@Example.org ', 'ada@example.org', '   ', 'Bob@x.org'];
    const global = overrideSchema.safeParse({
      id: 'lim-000000000001',
      scope: 'user',
      targets: raw,
      entries: [],
    });
    expect(global.success && global.data.targets).toEqual([
      'ada@example.org',
      'bob@x.org',
    ]);
    const scoped = scopedOverrideBodySchema.safeParse({
      id: 'lim-000000000001',
      scope: 'user',
      targets: raw,
      entries: [],
    });
    expect(scoped.success && scoped.data.targets).toEqual([
      'ada@example.org',
      'bob@x.org',
    ]);
  });
});

describe('group targets are Entra object ids (write-time)', () => {
  const GUID = '0f3a9c2b-0000-4000-8000-000000000001';
  const override = {
    id: 'lim-0000000000a1',
    scope: 'group',
    targets: [' 0F3A9C2B-0000-4000-8000-000000000001 '],
    entries: [],
  };

  it('accepts a GUID (any case, padded) on an override and stores it canonical', () => {
    expect(overrideSchema.parse(override).targets).toEqual([GUID]);
  });

  it('refuses a display name on a group override, a group predicate, a scoped body and a model-access grant — with the `targets`/`groups` path', () => {
    const name = 'Health team';
    const bad = overrideSchema.safeParse({ ...override, targets: [name] });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues[0].path).toEqual(['targets']);
      expect(bad.error.issues[0].message).toMatch(/object ids/);
    }
    expect(
      jurisdictionPredicateWriteSchema.safeParse({
        scope: 'group',
        targets: [name],
      }).success,
    ).toBe(false);
    expect(
      scopedOverrideBodySchema.safeParse({
        id: 'lim-0000000000a1',
        scope: 'group',
        targets: [name],
        entries: [],
      }).success,
    ).toBe(false);
    const grant = modelAccessRuleSchema.safeParse({
      series: 'claude',
      groups: [{ target: name }],
    });
    expect(grant.success).toBe(false);
    if (!grant.success) {
      expect(grant.error.issues[0].path).toEqual(['groups']);
    }
  });

  it('leaves the other scopes alone', () => {
    expect(
      overrideSchema.safeParse({
        ...override,
        scope: 'user',
        targets: ['a@x.org'],
      }).success,
    ).toBe(true);
    expect(
      jurisdictionPredicateWriteSchema.safeParse({
        scope: 'attribute',
        targets: ['department:health'],
      }).success,
    ).toBe(true);
  });
});
