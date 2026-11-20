import { WorkflowPolicyService } from '@/lib/services/workflows/policy/WorkflowPolicyService';
import {
  WORKFLOW_FEATURES,
  WORKFLOW_FEATURE_IDS,
  WORKFLOW_POLICY_DEFAULTS,
  WorkflowFeatureOverride,
  WorkflowPolicy,
  featureSettingProblem,
  resolveAllWorkflowFeaturesEnabled,
  resolveAllWorkflowsEnabled,
  resolveWorkflowEnabled,
  resolveWorkflowFeatureEnabled,
  resolveWorkflowFeatureLimits,
  resolveWorkflowFeatureSetting,
  workflowFeaturesOf,
} from '@/lib/services/workflows/policy/types';
import { readWorkflowPolicy } from '@/lib/services/workflows/policy/workflowPolicyStore';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/workflows/policy/workflowPolicyStore', () => ({
  createWorkflowPolicyBlobStorage: vi.fn(() => ({})),
  readWorkflowPolicy: vi.fn(),
}));

const policy = (workflows: WorkflowPolicy['workflows']): WorkflowPolicy => ({
  version: 1,
  workflows,
  updatedBy: 'admin@example.com',
  updatedAt: '2026-08-24T00:00:00.000Z',
});

describe('workflow policy resolution', () => {
  it('grants defaults to DISABLED, every other workflow to enabled', () => {
    expect(WORKFLOW_POLICY_DEFAULTS.grants).toBe(false);
    expect(resolveWorkflowEnabled(null, 'grants')).toBe(false);
    for (const type of [
      'translation',
      'document',
      'data-analysis',
      'map',
    ] as const) {
      expect(resolveWorkflowEnabled(null, type)).toBe(true);
    }
  });

  it('an explicit setting wins over the default in both directions', () => {
    const p = policy({
      grants: { enabled: true },
      map: { enabled: false },
    });
    expect(resolveWorkflowEnabled(p, 'grants')).toBe(true);
    expect(resolveWorkflowEnabled(p, 'map')).toBe(false);
    // Unmentioned workflows keep their defaults.
    expect(resolveWorkflowEnabled(p, 'document')).toBe(true);
  });

  it('resolveAllWorkflowsEnabled covers every known workflow', () => {
    const all = resolveAllWorkflowsEnabled(
      policy({ grants: { enabled: true } }),
    );
    expect(Object.keys(all).sort()).toEqual(
      [
        'brand-review',
        'channel-drafter',
        'data-analysis',
        'deck-builder',
        'document',
        'form-fill',
        'grants',
        'map',
        'translation',
      ].sort(),
    );
    expect(all.grants).toBe(true);
  });
});

describe('workflow feature resolution', () => {
  const FEATURE = 'translation-preserve-formatting' as const;
  const withFeature = (
    enabled: boolean,
    workflows: WorkflowPolicy['workflows'] = {},
  ): WorkflowPolicy => ({
    ...policy(workflows),
    features: { [FEATURE]: { enabled } },
  });

  it('every feature belongs to a known workflow and is listed under it', () => {
    for (const id of WORKFLOW_FEATURE_IDS) {
      expect(workflowFeaturesOf(WORKFLOW_FEATURES[id].workflow)).toContain(id);
    }
    expect(workflowFeaturesOf('translation')).toEqual([FEATURE]);
    expect(workflowFeaturesOf('map')).toEqual([]);
  });

  it('uses the default with no policy and with a policy that predates features', () => {
    const fallback = WORKFLOW_FEATURES[FEATURE].defaultEnabled;
    expect(fallback).toBe(true);
    expect(resolveWorkflowFeatureEnabled(null, FEATURE)).toBe(fallback);
    expect(resolveWorkflowFeatureEnabled(policy({}), FEATURE)).toBe(fallback);
  });

  it('an explicit setting wins in both directions', () => {
    expect(resolveWorkflowFeatureEnabled(withFeature(false), FEATURE)).toBe(
      false,
    );
    expect(resolveWorkflowFeatureEnabled(withFeature(true), FEATURE)).toBe(
      true,
    );
  });

  it('is unavailable while its workflow is off, but keeps its own switch', () => {
    const p = withFeature(true, { translation: { enabled: false } });
    expect(resolveWorkflowFeatureEnabled(p, FEATURE)).toBe(false);
    expect(resolveWorkflowFeatureSetting(p, FEATURE)).toBe(true);
    // Another workflow being off does not affect it.
    expect(
      resolveWorkflowFeatureEnabled(
        withFeature(true, { map: { enabled: false } }),
        FEATURE,
      ),
    ).toBe(true);
  });

  it('resolveAllWorkflowFeaturesEnabled covers every known feature', () => {
    const all = resolveAllWorkflowFeaturesEnabled(withFeature(false));
    expect(Object.keys(all).sort()).toEqual([...WORKFLOW_FEATURE_IDS].sort());
    expect(all[FEATURE]).toBe(false);
  });

  it('the service answers from the loaded policy', async () => {
    WorkflowPolicyService.resetInstance();
    vi.mocked(readWorkflowPolicy).mockReset();
    vi.mocked(readWorkflowPolicy).mockResolvedValue({
      policy: withFeature(false),
      etag: '"e"',
    });
    const service = WorkflowPolicyService.getInstance();
    expect(service.isFeatureEnabled(FEATURE)).toBe(true);
    await service.ensureFresh();
    expect(service.isFeatureEnabled(FEATURE)).toBe(false);
    expect(service.allFeaturesEnabled()).toEqual({ [FEATURE]: false });
  });
});

describe('workflow feature limits', () => {
  const FEATURE = 'translation-preserve-formatting' as const;
  const definitions = WORKFLOW_FEATURES[FEATURE].limits ?? {};
  const person = (mail: string, attributes: string[] = []) => ({
    userId: 'oid',
    mail,
    domain: mail.split('@')[1],
    attributes,
    groupIds: [],
  });
  const withLimits = (
    limits: Record<string, number>,
    overrides: WorkflowFeatureOverride[] = [],
  ): WorkflowPolicy => ({
    ...policy({}),
    features: { [FEATURE]: { enabled: true, limits, overrides } },
  });

  it('declares defaults inside their own bounds and in order', () => {
    for (const definition of Object.values(definitions)) {
      expect(definition.default).toBeGreaterThanOrEqual(definition.min);
      expect(definition.default).toBeLessThanOrEqual(definition.max);
    }
    expect(definitions.defaultBatchPages.default).toBeLessThanOrEqual(
      definitions.maxBatchPages.default,
    );
    expect(definitions.maxBatchPages.default).toBeLessThanOrEqual(
      definitions.maxDocumentPages.default,
    );
  });

  it('answers the defaults with no policy, and with one that sets nothing', () => {
    const defaults = Object.fromEntries(
      Object.entries(definitions).map(([key, d]) => [key, d.default]),
    );
    expect(resolveWorkflowFeatureLimits(null, FEATURE)).toEqual(defaults);
    expect(resolveWorkflowFeatureLimits(policy({}), FEATURE)).toEqual(defaults);
  });

  it('takes saved values and keeps the default of a limit left out', () => {
    expect(
      resolveWorkflowFeatureLimits(withLimits({ maxBatchPages: 9 }), FEATURE),
    ).toMatchObject({
      maxBatchPages: 9,
      maxDocumentPages: definitions.maxDocumentPages.default,
    });
  });

  it('holds a saved value inside the compiled bounds', () => {
    const { min, max } = definitions.maxDocumentPages;
    const resolved = (value: number) =>
      resolveWorkflowFeatureLimits(
        withLimits({ maxDocumentPages: value }),
        FEATURE,
      ).maxDocumentPages;
    // At each bound the value stands; one past it is brought back.
    expect(resolved(max)).toBe(max);
    expect(resolved(max + 1)).toBe(max);
    expect(resolved(min)).toBe(min);
    expect(resolved(min - 1)).toBe(min);
  });

  it('applies an override only to the people it names', () => {
    const p = withLimits({ maxDocumentPages: 20 }, [
      {
        scope: 'user',
        targets: ['Lead@Example.org'],
        limits: { maxDocumentPages: 60 },
      },
    ]);
    const limit = (mail?: string) =>
      resolveWorkflowFeatureLimits(p, FEATURE, mail ? person(mail) : null)
        .maxDocumentPages;
    expect(limit('lead@example.org')).toBe(60);
    expect(limit('other@example.org')).toBe(20);
    // Nobody asking: no override applies.
    expect(limit()).toBe(20);
  });

  it('inherits the limits an override leaves out', () => {
    const p = withLimits({ maxBatchPages: 8, maxDocumentPages: 20 }, [
      {
        scope: 'domain',
        targets: ['example.org'],
        limits: { maxBatchPages: 10 },
      },
    ]);
    expect(
      resolveWorkflowFeatureLimits(p, FEATURE, person('a@example.org')),
    ).toMatchObject({ maxBatchPages: 10, maxDocumentPages: 20 });
  });

  it('lets the person outrank the attribute, and the attribute the domain', () => {
    const overrides: WorkflowFeatureOverride[] = [
      // Listed most specific first, to show order in the list is not it.
      {
        scope: 'user',
        targets: ['a@example.org'],
        limits: { maxDocumentPages: 70 },
      },
      {
        scope: 'attribute',
        targets: ['department:health'],
        limits: { maxDocumentPages: 50 },
      },
      {
        scope: 'domain',
        targets: ['example.org'],
        limits: { maxDocumentPages: 40 },
      },
    ];
    const p = withLimits({}, overrides);
    const limit = (mail: string, attributes: string[] = []) =>
      resolveWorkflowFeatureLimits(p, FEATURE, person(mail, attributes))
        .maxDocumentPages;
    expect(limit('a@example.org', ['department:health'])).toBe(70);
    expect(limit('b@example.org', ['department:health'])).toBe(50);
    expect(limit('b@example.org')).toBe(40);
    expect(limit('b@elsewhere.org')).toBe(definitions.maxDocumentPages.default);
  });

  it('holds an override inside the compiled bounds too', () => {
    const { max } = definitions.maxBatchPages;
    const p = withLimits({}, [
      {
        scope: 'user',
        targets: ['a@example.org'],
        limits: { maxBatchPages: max + 50 },
      },
    ]);
    expect(
      resolveWorkflowFeatureLimits(p, FEATURE, person('a@example.org'))
        .maxBatchPages,
    ).toBe(max);
  });

  it('refuses a setting it cannot honour, and accepts the bounds themselves', () => {
    const { min, max } = definitions.maxBatchPages;
    const problem = (limits: Record<string, number>) =>
      featureSettingProblem(FEATURE, { enabled: true, limits });
    expect(problem({ maxBatchPages: max })).toBeNull();
    expect(problem({ maxBatchPages: min })).toBeNull();
    expect(problem({ maxBatchPages: max + 1 })).toMatch(/maxBatchPages/);
    expect(problem({ maxBatchPages: min - 1 })).toMatch(/maxBatchPages/);
    expect(problem({ maxBatchPages: 2.5 })).toMatch(/whole number/);
    expect(problem({ pagesPerMoon: 3 })).toMatch(/unknown limit/);
    expect(
      featureSettingProblem(FEATURE, {
        enabled: true,
        overrides: [
          {
            scope: 'user',
            targets: ['a@example.org'],
            limits: { maxBatchPages: max + 1 },
          },
        ],
      }),
    ).toMatch(/override 1/);
  });
});

describe('WorkflowPolicyService', () => {
  beforeEach(() => {
    WorkflowPolicyService.resetInstance();
    vi.mocked(readWorkflowPolicy).mockReset();
  });

  it('serves defaults (grants closed) when no policy has been authored', async () => {
    vi.mocked(readWorkflowPolicy).mockResolvedValue(null);
    const service = WorkflowPolicyService.getInstance();
    await service.ensureFresh();
    expect(service.getSnapshot().policyUnavailable).toBe(false);
    expect(service.isEnabled('grants')).toBe(false);
    expect(service.isEnabled('translation')).toBe(true);
  });

  it('serves defaults and flags policyUnavailable when storage is down on cold start', async () => {
    vi.mocked(readWorkflowPolicy).mockRejectedValue(new Error('boom'));
    const service = WorkflowPolicyService.getInstance();
    await service.ensureFresh();
    expect(service.getSnapshot().policyUnavailable).toBe(true);
    // Fail closed for the restricted workflow, open for the general ones.
    expect(service.isEnabled('grants')).toBe(false);
    expect(service.isEnabled('map')).toBe(true);
  });

  it('keeps last-known-good across a failed refresh', async () => {
    vi.mocked(readWorkflowPolicy).mockResolvedValueOnce({
      policy: policy({ grants: { enabled: true } }),
      etag: '"1"',
    });
    const service = WorkflowPolicyService.getInstance();
    await service.ensureFresh();
    expect(service.isEnabled('grants')).toBe(true);

    vi.mocked(readWorkflowPolicy).mockRejectedValue(new Error('boom'));
    service.invalidate();
    await service.ensureFresh();
    expect(service.isEnabled('grants')).toBe(true);
    expect(service.getSnapshot().policyUnavailable).toBe(false);
  });

  it('invalidate() forces a refetch', async () => {
    vi.mocked(readWorkflowPolicy).mockResolvedValueOnce(null);
    const service = WorkflowPolicyService.getInstance();
    await service.ensureFresh();
    expect(service.isEnabled('grants')).toBe(false);

    vi.mocked(readWorkflowPolicy).mockResolvedValueOnce({
      policy: policy({ grants: { enabled: true } }),
      etag: '"2"',
    });
    await service.ensureFresh(); // TTL warm → no refetch
    expect(service.isEnabled('grants')).toBe(false);
    service.invalidate();
    await service.ensureFresh();
    expect(service.isEnabled('grants')).toBe(true);
  });
});
