import { createTelemetryMiddleware } from '@/lib/services/chat/pipeline/Middleware';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const accessIsEnabled = vi.hoisted(() => vi.fn());
const accessGetOrgAgentById = vi.hoisted(() => vi.fn());
const resolveOrgAgentById = vi.hoisted(() => vi.fn());

vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: {
    getInstance: () => ({
      isEnabled: accessIsEnabled,
      ensureFresh: vi.fn(),
      getPromptAgentById: vi.fn(),
      getM365AgentById: vi.fn(),
      getOrgAgentById: accessGetOrgAgentById,
    }),
  },
  emitAccessAudit: vi.fn(),
}));
vi.mock('@/lib/services/orgAgents/orgAgentRegistry', () => ({
  resolveOrgAgentById,
}));
vi.mock('@/lib/services/agents/AgentDiscoveryService', () => ({
  AgentDiscoveryService: { getInstance: () => ({}) },
}));
vi.mock('@/lib/services/auth/UserTokenProvider', () => ({
  UserTokenProvider: { getInstance: () => ({}) },
}));
vi.mock('@/lib/services/auth/OfficeResolver', () => ({
  OfficeResolver: { getFoundryEndpoint: vi.fn() },
}));
vi.mock('@/auth', () => ({ auth: vi.fn(), getAccessTokenForOBO: vi.fn() }));

const base = {
  conversationId: 'conv-1',
  requestId: 'req-1',
  mcpLoopRound: 3,
  model: { id: 'gpt-5.2', name: 'GPT-5.2' },
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  accessIsEnabled.mockReturnValue(true);
  resolveOrgAgentById.mockResolvedValue(null);
  accessGetOrgAgentById.mockReturnValue(null);
});

describe('createTelemetryMiddleware', () => {
  it('carries correlation ids only when no agent is involved', async () => {
    const out = await createTelemetryMiddleware(base);
    expect(out.requestId).toBe('req-1');
    expect(out.telemetry).toEqual({
      botId: undefined,
      conversationId: 'conv-1',
      requestId: 'req-1',
      loopRound: 3,
    });
  });

  it('mints a requestId when the parser did not', async () => {
    const out = await createTelemetryMiddleware({
      ...base,
      requestId: undefined,
    });
    expect(out.requestId).toMatch(/[0-9a-f-]{36}/);
    expect(out.telemetry?.requestId).toBe(out.requestId);
  });

  it('reports an applied prompt agent', async () => {
    const out = await createTelemetryMiddleware({
      ...base,
      botId: 'prompt-abc',
      promptAgent: { id: 'prompt-abc', name: 'Persona' },
    });
    expect(out.telemetry).toEqual(
      expect.objectContaining({
        botId: 'prompt-abc',
        agentKind: 'prompt',
        agentName: 'Persona',
        agentSource: 'admin',
        agentApplied: true,
      }),
    );
  });

  it('reports an applied M365 agent', async () => {
    const out = await createTelemetryMiddleware({
      ...base,
      botId: 'm365-xyz',
      m365Agent: { id: 'm365-xyz', name: 'Finance files' },
    });
    expect(out.telemetry).toEqual(
      expect.objectContaining({
        agentKind: 'm365',
        agentName: 'Finance files',
        agentApplied: true,
      }),
    );
  });

  it('reports a Foundry agent with its source path', async () => {
    const out = await createTelemetryMiddleware({
      ...base,
      agentMode: true,
      agentSourcePath:
        '/subscriptions/s/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/a/projects/p',
      model: { id: 'foundry-x', name: 'Research Agent', agentId: 'research' },
    });
    expect(out.telemetry).toEqual(
      expect.objectContaining({
        agentKind: 'foundry',
        agentName: 'Research Agent',
        agentSource: expect.stringContaining('/projects/p'),
        agentApplied: true,
      }),
    );
  });

  it('flags a stale prompt-/m365- bot the pipeline ignored as NOT applied', async () => {
    const stale = await createTelemetryMiddleware({
      ...base,
      botId: 'prompt-old',
    });
    expect(stale.telemetry).toEqual(
      expect.objectContaining({ agentKind: 'prompt', agentApplied: false }),
    );
    expect(stale.telemetry?.agentName).toBeUndefined();

    const staleM365 = await createTelemetryMiddleware({
      ...base,
      botId: 'm365-old',
    });
    expect(staleM365.telemetry).toEqual(
      expect.objectContaining({ agentKind: 'm365', agentApplied: false }),
    );
  });

  it('resolves a static org RAG agent through the registry', async () => {
    resolveOrgAgentById.mockResolvedValue({
      id: 'msf_communications',
      name: 'MSF Communications',
    });
    const out = await createTelemetryMiddleware({
      ...base,
      botId: 'msf_communications',
    });
    expect(resolveOrgAgentById).toHaveBeenCalledWith('msf_communications');
    expect(out.telemetry).toEqual(
      expect.objectContaining({
        agentKind: 'rag',
        agentName: 'MSF Communications',
        agentSource: 'static',
        agentApplied: true,
      }),
    );
  });

  it("marks admin-authored org agents as source 'admin'", async () => {
    resolveOrgAgentById.mockResolvedValue({ id: 'orgr-1', name: 'Grants' });
    accessGetOrgAgentById.mockReturnValue({ id: 'orgr-1' });
    const out = await createTelemetryMiddleware({ ...base, botId: 'orgr-1' });
    expect(out.telemetry?.agentSource).toBe('admin');
  });

  it('marks an unknown org botId as not applied', async () => {
    const out = await createTelemetryMiddleware({ ...base, botId: 'ghost' });
    expect(out.telemetry).toEqual(
      expect.objectContaining({
        botId: 'ghost',
        agentKind: 'rag',
        agentApplied: false,
      }),
    );
  });

  it('never throws — a registry failure degrades to correlation ids', async () => {
    resolveOrgAgentById.mockRejectedValue(new Error('blob down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await createTelemetryMiddleware({ ...base, botId: 'x' });
    expect(out.telemetry).toEqual(
      expect.objectContaining({ botId: 'x', requestId: 'req-1' }),
    );
    expect(out.telemetry?.agentKind).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
