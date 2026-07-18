// ───────────────────────────────────────────────────────────────────
// createModelSelectionMiddleware — prompt-agent resolution + model swap
// (docs/AGENT_ACCESS_CONTROL.md). The AgentAccessService module is mocked
// so botId → prompt-agent resolution can be driven per-test; mock scaffold
// mirrors credentialMiddleware.accessControl.test.ts (Middleware.ts pulls
// in the same server modules at import time).
// ───────────────────────────────────────────────────────────────────
import { createModelSelectionMiddleware } from '@/lib/services/chat/pipeline/Middleware';

import { Message } from '@/types/chat';
import { OpenAIModelID, OpenAIModels } from '@/types/openai';
import { SearchMode } from '@/types/searchMode';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mocks — must be declared before module imports below.

const accessIsEnabled = vi.hoisted(() => vi.fn());
const accessEnsureFresh = vi.hoisted(() => vi.fn());
const accessGetPromptAgentById = vi.hoisted(() => vi.fn());

vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: {
    getInstance: () => ({
      isEnabled: accessIsEnabled,
      ensureFresh: accessEnsureFresh,
      getPromptAgentById: accessGetPromptAgentById,
    }),
  },
  emitAccessAudit: vi.fn(),
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

vi.mock('@/auth', () => ({
  auth: vi.fn(),
  getAccessTokenForOBO: vi.fn(),
}));

// ───────────────────────────────────────────────────────────────────

const promptAgentRecord = {
  version: 1 as const,
  id: 'prompt-abc123def456',
  name: 'Persona',
  description: 'A test persona',
  systemPrompt: 'You are a persona.',
  modelId: 'gpt-5.2',
  createdBy: 'admin@msf.org',
  createdAt: '2026-07-18T00:00:00.000Z',
  updatedBy: 'admin@msf.org',
  updatedAt: '2026-07-18T00:00:00.000Z',
};

const messages: Message[] = [{ role: 'user', content: 'hello' }];

/** Client picker model for a prompt agent: org- prefixed, no agentId. */
function makeContext(overrides: Record<string, any> = {}) {
  return {
    model: {
      id: 'org-prompt-abc123def456',
      name: 'Persona',
      maxLength: 24000,
      tokenLimit: 8000,
      isOrganizationAgent: true,
    },
    messages,
    botId: promptAgentRecord.id,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  accessIsEnabled.mockReturnValue(true);
  accessEnsureFresh.mockResolvedValue(undefined);
  accessGetPromptAgentById.mockReturnValue(promptAgentRecord);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createModelSelectionMiddleware — prompt-agent resolution', () => {
  it('resolves botId and swaps the model to the admin-chosen OpenAIModels config', async () => {
    const result = await createModelSelectionMiddleware(makeContext());

    expect(accessEnsureFresh).toHaveBeenCalled();
    expect(accessGetPromptAgentById).toHaveBeenCalledWith(
      'prompt-abc123def456',
    );
    expect(result.promptAgent).toEqual(promptAgentRecord);
    // The real config executes — sdk/deploymentName/tokenLimit are genuine,
    // not the client's stripped org- placeholder.
    expect(result.modelId).toBe('gpt-5.2');
    expect(result.model).toBe(OpenAIModels[OpenAIModelID.GPT_5_2]);
    expect(result.agentMode).toBe(false);
  });

  it('forces agentMode off even under AGENT search mode (never the Foundry path)', async () => {
    // Standard configs legitimately carry an intelligent-search agentId;
    // agentMode + agentId would promote to executionStrategy='agent', so a
    // resolved prompt agent must pin agentMode to false.
    const result = await createModelSelectionMiddleware(
      makeContext({ searchMode: SearchMode.AGENT }),
    );

    expect(result.promptAgent).toEqual(promptAgentRecord);
    expect(result.agentMode).toBe(false);
  });

  it('unknown record.modelId: logs loudly and keeps the default org- behavior', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    accessGetPromptAgentById.mockReturnValue({
      ...promptAgentRecord,
      modelId: 'no-such-model',
    });

    const result = await createModelSelectionMiddleware(makeContext());

    // Persona still recorded (guard + enricher still apply)…
    expect(result.promptAgent).toEqual({
      ...promptAgentRecord,
      modelId: 'no-such-model',
    });
    // …but the model is NOT swapped: existing default behavior (the org- id
    // rides the DeploymentNotFound fallback chain) is preserved.
    expect(result.modelId).toBe('org-prompt-abc123def456');
    expect(result.model?.id).toBe('org-prompt-abc123def456');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('no-such-model'),
    );
  });

  it('botId that resolves to no record leaves the selection untouched', async () => {
    accessGetPromptAgentById.mockReturnValue(null);

    const result = await createModelSelectionMiddleware(makeContext());

    expect(result.promptAgent).toBeUndefined();
    expect(result.modelId).toBe('org-prompt-abc123def456');
    expect(result.model?.id).toBe('org-prompt-abc123def456');
  });

  it('feature disabled: never consults the service', async () => {
    accessIsEnabled.mockReturnValue(false);

    const result = await createModelSelectionMiddleware(makeContext());

    expect(accessEnsureFresh).not.toHaveBeenCalled();
    expect(accessGetPromptAgentById).not.toHaveBeenCalled();
    expect(result.promptAgent).toBeUndefined();
    expect(result.modelId).toBe('org-prompt-abc123def456');
  });

  it('no botId: standard models resolve as before with no service lookup', async () => {
    const result = await createModelSelectionMiddleware(
      makeContext({
        model: { id: 'gpt-5.2', name: 'GPT-5.2' },
        botId: undefined,
      }),
    );

    expect(accessGetPromptAgentById).not.toHaveBeenCalled();
    expect(result.promptAgent).toBeUndefined();
    expect(result.modelId).toBe('gpt-5.2');
    expect(result.model).toBe(OpenAIModels[OpenAIModelID.GPT_5_2]);
    expect(result.agentMode).toBe(false);
  });
});
