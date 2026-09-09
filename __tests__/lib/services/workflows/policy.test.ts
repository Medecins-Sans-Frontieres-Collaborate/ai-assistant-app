import { WorkflowPolicyService } from '@/lib/services/workflows/policy/WorkflowPolicyService';
import {
  WORKFLOW_POLICY_DEFAULTS,
  WorkflowPolicy,
  resolveAllWorkflowsEnabled,
  resolveWorkflowEnabled,
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
      ['data-analysis', 'document', 'grants', 'map', 'translation'].sort(),
    );
    expect(all.grants).toBe(true);
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
