/**
 * Merge semantics of the org-agent registry: admin records win by id,
 * disables retire agents outright, and failed-validation records fall back
 * to the static config entry (never serve a broken index).
 */
import {
  getServeableAdminOrgAgents,
  getSuppressedStaticAgentIds,
  peekOrgAgentById,
  resolveOrgAgentById,
} from '@/lib/services/orgAgents/orgAgentRegistry';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockService = vi.hoisted(() => ({
  isEnabled: vi.fn(),
  ensureFresh: vi.fn(),
  getOrgAgents: vi.fn(),
  getOrgAgentById: vi.fn(),
}));

vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: { getInstance: () => mockService },
}));

const staticAgent = {
  id: 'msf_communications',
  name: 'MSF Communications',
  description: 'static entry',
  icon: 'IconNews',
  color: '#4190f2',
  type: 'rag' as const,
  enabled: true,
  allowWebSearch: true,
  ragConfig: { topK: 10 },
};

vi.mock('@/lib/organizationAgents', () => ({
  getOrganizationAgents: () => [staticAgent],
  getOrganizationAgentById: (id: string) =>
    id === 'msf_communications' ? staticAgent : undefined,
}));

function record(overrides: Record<string, unknown> = {}) {
  return {
    version: 1 as const,
    id: 'orgr-abcdefabcdef',
    name: 'Field manuals',
    description: '',
    icon: 'IconHexagon',
    color: '#22aa66',
    category: '',
    maintainedBy: '',
    systemPrompt: 'Answer from the manuals.',
    sources: [{ name: 'Manuals', url: 'https://example.org' }],
    searchIndex: 'field-manuals',
    semanticConfig: '',
    topK: 5,
    baseModelId: null,
    allowWebSearch: false,
    allowCodeInterpreter: false,
    enabled: true,
    validation: { status: 'ok' as const, checkedAt: '2026-07-30T00:00:00Z' },
    createdBy: 'a@x.org',
    createdAt: '2026-07-30T00:00:00Z',
    updatedBy: 'a@x.org',
    updatedAt: '2026-07-30T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockService.isEnabled.mockReturnValue(true);
  mockService.ensureFresh.mockResolvedValue(undefined);
  mockService.getOrgAgents.mockReturnValue([]);
  mockService.getOrgAgentById.mockReturnValue(null);
});

describe('resolveOrgAgentById', () => {
  it('serves the static config when the feature is disabled', async () => {
    mockService.isEnabled.mockReturnValue(false);
    const agent = await resolveOrgAgentById('msf_communications');
    expect(agent?.description).toBe('static entry');
  });

  it('projects a serveable admin record onto the pipeline shape', async () => {
    mockService.getOrgAgentById.mockReturnValue(record());
    const agent = await resolveOrgAgentById('orgr-abcdefabcdef');
    expect(agent).toMatchObject({
      id: 'orgr-abcdefabcdef',
      type: 'rag',
      systemPrompt: 'Answer from the manuals.',
      ragConfig: { searchIndex: 'field-manuals', topK: 5 },
      allowWebSearch: false,
    });
  });

  it('lets an admin OVERRIDE beat the static entry with the same id', async () => {
    mockService.getOrgAgentById.mockReturnValue(
      record({ id: 'msf_communications', name: 'Comms v2' }),
    );
    const agent = await resolveOrgAgentById('msf_communications');
    expect(agent?.name).toBe('Comms v2');
    expect(agent?.ragConfig?.searchIndex).toBe('field-manuals');
  });

  it('retires the agent when the record is disabled — no static fallback', async () => {
    mockService.getOrgAgentById.mockReturnValue(
      record({ id: 'msf_communications', enabled: false }),
    );
    expect(await resolveOrgAgentById('msf_communications')).toBeNull();
  });

  it('falls back to the static entry when an override failed validation', async () => {
    mockService.getOrgAgentById.mockReturnValue(
      record({
        id: 'msf_communications',
        validation: {
          status: 'failed',
          checkedAt: '2026-07-30T00:00:00Z',
          error: 'index gone',
        },
      }),
    );
    const agent = await resolveOrgAgentById('msf_communications');
    expect(agent?.description).toBe('static entry');
  });

  it('serves nothing for a failed-validation record with no static twin', async () => {
    mockService.getOrgAgentById.mockReturnValue(
      record({
        validation: { status: 'failed', checkedAt: 'x', error: 'broken' },
      }),
    );
    expect(await resolveOrgAgentById('orgr-abcdefabcdef')).toBeNull();
  });
});

describe('peekOrgAgentById', () => {
  it('mirrors resolve synchronously over the current snapshot', () => {
    mockService.getOrgAgentById.mockReturnValue(record());
    expect(peekOrgAgentById('orgr-abcdefabcdef')?.name).toBe('Field manuals');
    // Cold snapshot → static fallback only.
    mockService.getOrgAgentById.mockReturnValue(null);
    expect(peekOrgAgentById('orgr-abcdefabcdef')).toBeNull();
    expect(peekOrgAgentById('msf_communications')?.name).toBe(
      'MSF Communications',
    );
  });
});

describe('discovery projections', () => {
  it('serves only enabled + validated records', async () => {
    mockService.getOrgAgents.mockReturnValue([
      record(),
      record({ id: 'orgr-000000000002', enabled: false }),
      record({
        id: 'orgr-000000000003',
        validation: { status: 'failed', checkedAt: 'x' },
      }),
    ]);
    const serveable = await getServeableAdminOrgAgents();
    expect(serveable.map((a) => a.id)).toEqual(['orgr-abcdefabcdef']);
  });

  it('suppresses static ids for serveable overrides and disables, not failures', async () => {
    mockService.getOrgAgents.mockReturnValue([
      record({ id: 'msf_communications', enabled: false }),
      record(), // orgr- id — not a static id, never suppressed
    ]);
    expect(await getSuppressedStaticAgentIds()).toEqual(['msf_communications']);

    mockService.getOrgAgents.mockReturnValue([
      record({
        id: 'msf_communications',
        validation: { status: 'failed', checkedAt: 'x' },
      }),
    ]);
    // Failed override → the static entry still serves, so it must stay
    // visible.
    expect(await getSuppressedStaticAgentIds()).toEqual([]);
  });
});
