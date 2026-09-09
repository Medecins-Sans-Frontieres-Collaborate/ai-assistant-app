/**
 * GET /api/agents (fast half) — org RAG agents. The main agents suite pins
 * `getOrgAgents` to []; this file covers the org path the split must keep
 * serving: admin records, static overrides + suppression, fail-open.
 */
import { NextRequest } from 'next/server';

import { GET } from '@/app/api/agents/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const accessEvaluate = vi.hoisted(() => vi.fn());
const orgRecords = vi.hoisted(() => ({ list: [] as unknown[] }));

const ADMIN_RECORD = {
  id: 'orgr-admin',
  name: 'Admin Org Agent',
  description: 'd',
  enabled: true,
  validation: { status: 'ok' },
  searchIndex: 'idx',
  semanticConfig: 'sem',
  allowWebSearch: true,
  allowCodeInterpreter: false,
};
const STATIC_OVERRIDE = {
  ...ADMIN_RECORD,
  id: 'msf_communications',
  name: 'Comms (admin override)',
};

vi.mock('@/auth', () => ({ auth: mockAuth, getAccessTokenForOBO: vi.fn() }));
vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: {
    getInstance: () => ({
      isEnabled: () => true,
      ensureFresh: vi.fn().mockResolvedValue(undefined),
      evaluateAccess: accessEvaluate,
      getPromptAgents: () => [],
      getM365Agents: () => [],
      getOrgAgents: () => orgRecords.list,
    }),
  },
}));
vi.mock('@/lib/services/orgAgents/orgAgentSearchValidation', () => ({
  checkIndexServeableCached: vi.fn().mockResolvedValue(true),
  peekIndexServeable: vi.fn().mockReturnValue(true),
}));

function fastRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/agents');
}

describe('GET /api/agents — org RAG agents on the fast half', () => {
  beforeEach(() => {
    mockAuth.mockResolvedValue({ user: { mail: 'u@example.com' } });
    accessEvaluate.mockReturnValue({ decision: 'allow', reason: 'no-rule' });
    orgRecords.list = [];
  });

  it('serves an admin org agent as type "org" and suppresses nothing static', async () => {
    orgRecords.list = [ADMIN_RECORD];
    const response = await GET(fastRequest());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(
      body.agents.map((a: { id: string; type: string }) => `${a.type}:${a.id}`),
    ).toEqual(['org:orgr-admin']);
    expect(body.suppressedOrgAgentIds).toEqual([]);
  });

  it('serves an admin override of a static agent and suppresses the static id', async () => {
    orgRecords.list = [STATIC_OVERRIDE];
    const body = await (await GET(fastRequest())).json();
    expect(body.agents.map((a: { id: string }) => a.id)).toEqual([
      'msf_communications',
    ]);
    expect(body.suppressedOrgAgentIds).toEqual(['msf_communications']);
  });

  it('drops an admin org agent the user is denied and folds a denied static id', async () => {
    orgRecords.list = [ADMIN_RECORD];
    accessEvaluate.mockReturnValue({ decision: 'deny', reason: 'not-listed' });
    const body = await (await GET(fastRequest())).json();
    expect(body.agents).toEqual([]);
    expect(body.suppressedOrgAgentIds).toEqual(['msf_communications']);
  });

  it("keeps everything visible when rules are 'unavailable'", async () => {
    orgRecords.list = [ADMIN_RECORD];
    accessEvaluate.mockReturnValue({
      decision: 'unavailable',
      reason: 'rules-unavailable',
    });
    const body = await (await GET(fastRequest())).json();
    expect(body.agents.map((a: { id: string }) => a.id)).toEqual([
      'orgr-admin',
    ]);
    expect(body.suppressedOrgAgentIds).toEqual([]);
  });
});
