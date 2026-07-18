// ───────────────────────────────────────────────────────────────────
// Invocation guard for app-layer agent access control
// (docs/AGENT_ACCESS_CONTROL.md). Mocking setup mirrors
// credentialMiddleware.test.ts; the AgentAccessService module is mocked
// here so the guard's decisions can be driven per-test.
// ───────────────────────────────────────────────────────────────────
import { NextRequest } from 'next/server';

import { createCredentialMiddleware } from '@/lib/services/chat/pipeline/Middleware';

import { ErrorCode, PipelineError } from '@/types/errors';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// getAccessTokenForOBO is mocked, so the request is only forwarded, never read.
const mockReq = {} as unknown as NextRequest;

// Hoisted mocks — must be declared before module imports below.

const lookupUserAgentEndpoint = vi.hoisted(() => vi.fn());
const cacheUserAgentEndpoint = vi.hoisted(() => vi.fn());
const listUserAgents = vi.hoisted(() => vi.fn());
const getArmToken = vi.hoisted(() => vi.fn());
const getFoundryToken = vi.hoisted(() => vi.fn());
const getAccessTokenForOBO = vi.hoisted(() => vi.fn());
const getFoundryEndpoint = vi.hoisted(() => vi.fn());
const accessIsEnabled = vi.hoisted(() => vi.fn());
const accessEnsureFresh = vi.hoisted(() => vi.fn());
const accessEvaluate = vi.hoisted(() => vi.fn());
const accessGetPromptAgentById = vi.hoisted(() => vi.fn());
const emitAccessAudit = vi.hoisted(() => vi.fn());

vi.mock('@/lib/services/agents/AgentDiscoveryService', () => ({
  AgentDiscoveryService: {
    getInstance: () => ({
      lookupUserAgentEndpoint,
      cacheUserAgentEndpoint,
      listUserAgents,
    }),
  },
}));

vi.mock('@/lib/services/auth/UserTokenProvider', () => ({
  UserTokenProvider: {
    getInstance: () => ({
      getArmToken,
      getFoundryToken,
    }),
  },
}));

vi.mock('@/lib/services/auth/OfficeResolver', () => ({
  OfficeResolver: {
    getFoundryEndpoint,
  },
}));

vi.mock('@/auth', () => ({
  auth: vi.fn(),
  getAccessTokenForOBO,
}));

// Middleware imports both the service and emitAccessAudit from this module.
vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: {
    getInstance: () => ({
      isEnabled: accessIsEnabled,
      ensureFresh: accessEnsureFresh,
      evaluateAccess: accessEvaluate,
      getPromptAgentById: accessGetPromptAgentById,
    }),
  },
  emitAccessAudit,
}));

// ───────────────────────────────────────────────────────────────────

const VALID_PATH =
  '/subscriptions/abc/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/my-acct/projects/default';
const ALLOWED_ENDPOINT =
  'https://my-acct.services.ai.azure.com/api/projects/default';
const REGIONAL_FALLBACK =
  'https://eu.services.ai.azure.com/api/projects/default';

function makeContext(overrides: Record<string, any> = {}) {
  return {
    session: { user: { mail: 'u@msf.org' } },
    user: { mail: 'u@msf.org', region: 'EU' as const },
    model: {
      isOrganizationAgent: true,
      agentId: 'my-agent',
    },
    modelId: 'foundry-deadbeef-my-agent',
    agentSourcePath: VALID_PATH,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getFoundryEndpoint.mockReturnValue(REGIONAL_FALLBACK);
  getAccessTokenForOBO.mockResolvedValue('app-access-token');
  getFoundryToken.mockResolvedValue('foundry-obo-token');
  getArmToken.mockResolvedValue('arm-obo-token');
  lookupUserAgentEndpoint.mockReturnValue(ALLOWED_ENDPOINT);
  accessIsEnabled.mockReturnValue(true);
  accessEnsureFresh.mockResolvedValue(undefined);
  accessEvaluate.mockReturnValue({ decision: 'allow', reason: 'no-rule' });
  accessGetPromptAgentById.mockReturnValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('createCredentialMiddleware — agent access invocation guard', () => {
  describe('feature disabled', () => {
    it('never consults the access service and binds the credential', async () => {
      accessIsEnabled.mockReturnValue(false);

      const result = await createCredentialMiddleware(makeContext(), mockReq);

      expect(accessEnsureFresh).not.toHaveBeenCalled();
      expect(accessEvaluate).not.toHaveBeenCalled();
      expect(emitAccessAudit).not.toHaveBeenCalled();
      expect(result.foundryEndpoint).toBe(ALLOWED_ENDPOINT);
      expect(result.userCredential).toBeDefined();
    });
  });

  describe('allow', () => {
    it('refreshes the ruleset, audits the decision, and proceeds to bind', async () => {
      accessEvaluate.mockReturnValue({ decision: 'allow', reason: 'public' });

      const result = await createCredentialMiddleware(makeContext(), mockReq);

      expect(accessEnsureFresh).toHaveBeenCalled();
      // Endpoint resolution verified the agent under the user's ARM RBAC, so
      // the client-supplied source path is trusted for rule matching.
      expect(accessEvaluate).toHaveBeenCalledWith({
        userMail: 'u@msf.org',
        source: VALID_PATH,
        agentName: 'my-agent',
      });
      expect(emitAccessAudit).toHaveBeenCalledWith({
        userMail: 'u@msf.org',
        agentName: 'my-agent',
        source: VALID_PATH,
        decision: 'allow',
        reason: 'public',
      });
      expect(result.foundryEndpoint).toBe(ALLOWED_ENDPOINT);
      expect(result.userCredential).toBeDefined();
      expect(getFoundryToken).toHaveBeenCalled();
    });
  });

  describe('deny', () => {
    it('blocks with an explicit access-denied error in non-production (regression: dev used to return {} and execute via app identity)', async () => {
      accessEvaluate.mockReturnValue({
        decision: 'deny',
        reason: 'not-allowed',
      });

      // A denial is POLICY, not credential plumbing — it must block in EVERY
      // environment (NODE_ENV=test here), not inherit failClosedResult's dev
      // carve-out.
      await expect(
        createCredentialMiddleware(makeContext(), mockReq),
      ).rejects.toMatchObject({
        code: ErrorCode.AGENT_UNAVAILABLE,
        metadata: { accessDecision: 'deny', accessReason: 'not-allowed' },
      });

      // Crucially the OBO Foundry token was never even requested.
      expect(getFoundryToken).not.toHaveBeenCalled();
      expect(emitAccessAudit).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'deny', reason: 'not-allowed' }),
      );
    });

    it('blocks with the same explicit error in production', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      accessEvaluate.mockReturnValue({
        decision: 'deny',
        reason: 'not-allowed',
      });

      const err = await createCredentialMiddleware(makeContext(), mockReq).then(
        () => null,
        (e) => e,
      );

      expect(err).toBeInstanceOf(PipelineError);
      expect(err.code).toBe(ErrorCode.AGENT_UNAVAILABLE);
      expect(err.message).toMatch(/restricted/i);
      expect(getFoundryToken).not.toHaveBeenCalled();
    });

    it('guards the dev app-identity fallback path (no OBO token available)', async () => {
      // With OBO unavailable AND an allow decision, dev returns an undefined
      // credential so the handler's DefaultAzureCredential fallback runs —
      // the guard must therefore fire BEFORE that fallback is reachable.
      getAccessTokenForOBO.mockResolvedValue(null);

      const allowed = await createCredentialMiddleware(makeContext(), mockReq);
      expect(allowed.foundryEndpoint).toBe(ALLOWED_ENDPOINT);
      expect(allowed.userCredential).toBeUndefined();

      accessEvaluate.mockReturnValue({
        decision: 'deny',
        reason: 'not-allowed',
      });

      // Denied: the middleware throws, so the handler never runs and the
      // app-identity fallback has nothing to run against.
      await expect(
        createCredentialMiddleware(makeContext(), mockReq),
      ).rejects.toMatchObject({ code: ErrorCode.AGENT_UNAVAILABLE });

      expect(accessEvaluate).toHaveBeenCalledTimes(2);
      expect(emitAccessAudit).toHaveBeenLastCalledWith(
        expect.objectContaining({ decision: 'deny' }),
      );
    });
  });

  describe('unavailable (enabled + no last-known-good ruleset)', () => {
    it('blocks like a deny and audits the decision (non-production)', async () => {
      accessEvaluate.mockReturnValue({
        decision: 'unavailable',
        reason: 'rules-unavailable',
      });

      await expect(
        createCredentialMiddleware(makeContext(), mockReq),
      ).rejects.toMatchObject({
        code: ErrorCode.AGENT_UNAVAILABLE,
        metadata: {
          accessDecision: 'unavailable',
          accessReason: 'rules-unavailable',
        },
      });
      expect(getFoundryToken).not.toHaveBeenCalled();
      expect(emitAccessAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: 'unavailable',
          reason: 'rules-unavailable',
        }),
      );
    });

    it('blocks with the same explicit error in production', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      accessEvaluate.mockReturnValue({
        decision: 'unavailable',
        reason: 'rules-unavailable',
      });

      await expect(
        createCredentialMiddleware(makeContext(), mockReq),
      ).rejects.toMatchObject({
        code: ErrorCode.AGENT_UNAVAILABLE,
        metadata: { accessDecision: 'unavailable' },
      });
      expect(getFoundryToken).not.toHaveBeenCalled();
    });
  });

  describe('unresolved-source semantics', () => {
    it('evaluates with source=null when the endpoint was not verified for the source path', async () => {
      // Cache miss + failed lazy discovery → regional fallback endpoint; the
      // client-supplied source path was never verified under the user's ARM
      // RBAC, so the guard must apply unresolved-source semantics (#4).
      lookupUserAgentEndpoint.mockReturnValue(null);
      listUserAgents.mockRejectedValue(new Error('ARM 403'));

      const result = await createCredentialMiddleware(makeContext(), mockReq);

      expect(accessEvaluate).toHaveBeenCalledWith({
        userMail: 'u@msf.org',
        source: null,
        agentName: 'my-agent',
      });
      expect(result.foundryEndpoint).toBe(REGIONAL_FALLBACK);
    });
  });

  describe('guard ordering', () => {
    it('does not consult the access service when the host allow-list already refused', async () => {
      lookupUserAgentEndpoint.mockReturnValue('https://attacker.example/x');

      const result = await createCredentialMiddleware(makeContext(), mockReq);

      expect(result).toEqual({});
      expect(accessEvaluate).not.toHaveBeenCalled();
    });

    it('skips the guard for non-foundry models', async () => {
      const ctx = makeContext({
        model: { isOrganizationAgent: false, agentId: undefined },
        modelId: 'gpt-5.2',
      });

      const result = await createCredentialMiddleware(ctx, mockReq);

      expect(result).toEqual({});
      expect(accessEvaluate).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Regression: guard bypass via org-/custom- model ids. A client can POST
  // model={id:'org-x', agentId:'...'} WITHOUT isOrganizationAgent — the
  // Foundry classification misses it, yet model selection sets agentMode,
  // AgentEnricher promotes it to executionStrategy='agent', and the handler
  // falls back to env endpoint + DefaultAzureCredential (app identity). The
  // guard must therefore also evaluate these invocations, with
  // unresolved-source semantics (source: null).
  // ───────────────────────────────────────────────────────────────────
  describe('non-Foundry-classified agent invocations (org-/custom- ids)', () => {
    /** Context mimicking post-model-selection state for an org- model whose
     *  client-supplied model object omitted isOrganizationAgent. */
    function makeNonFoundryAgentContext(
      modelId: string,
      overrides: Record<string, any> = {},
    ) {
      return makeContext({
        model: { agentId: 'finance-bot' }, // no isOrganizationAgent
        modelId,
        agentMode: true,
        agentSourcePath: undefined,
        ...overrides,
      });
    }

    it('org- id + deny rule: blocked, evaluated with source null, audited', async () => {
      accessEvaluate.mockReturnValue({
        decision: 'deny',
        reason: 'not-allowed',
      });

      await expect(
        createCredentialMiddleware(
          makeNonFoundryAgentContext('org-finance-bot'),
          mockReq,
        ),
      ).rejects.toMatchObject({
        code: ErrorCode.AGENT_UNAVAILABLE,
        metadata: { accessDecision: 'deny', accessReason: 'not-allowed' },
      });

      expect(accessEnsureFresh).toHaveBeenCalled();
      // Unresolved-source semantics: this path never resolves a verified
      // source path, so the guard must pass source: null.
      expect(accessEvaluate).toHaveBeenCalledWith({
        userMail: 'u@msf.org',
        source: null,
        agentName: 'finance-bot',
      });
      expect(emitAccessAudit).toHaveBeenCalledWith({
        userMail: 'u@msf.org',
        agentName: 'finance-bot',
        source: null,
        decision: 'deny',
        reason: 'not-allowed',
      });
      // No credential machinery was touched on this path.
      expect(getAccessTokenForOBO).not.toHaveBeenCalled();
      expect(getFoundryToken).not.toHaveBeenCalled();
      expect(lookupUserAgentEndpoint).not.toHaveBeenCalled();
    });

    it('custom- id + deny rule: blocked the same way', async () => {
      accessEvaluate.mockReturnValue({
        decision: 'deny',
        reason: 'not-allowed',
      });

      await expect(
        createCredentialMiddleware(
          makeNonFoundryAgentContext('custom-finance-bot'),
          mockReq,
        ),
      ).rejects.toMatchObject({ code: ErrorCode.AGENT_UNAVAILABLE });

      expect(accessEvaluate).toHaveBeenCalledWith({
        userMail: 'u@msf.org',
        source: null,
        agentName: 'finance-bot',
      });
      expect(emitAccessAudit).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'deny', source: null }),
      );
    });

    it("'unavailable' blocks these invocations too", async () => {
      accessEvaluate.mockReturnValue({
        decision: 'unavailable',
        reason: 'rules-unavailable',
      });

      await expect(
        createCredentialMiddleware(
          makeNonFoundryAgentContext('org-finance-bot'),
          mockReq,
        ),
      ).rejects.toMatchObject({
        code: ErrorCode.AGENT_UNAVAILABLE,
        metadata: { accessDecision: 'unavailable' },
      });
      expect(emitAccessAudit).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'unavailable' }),
      );
    });

    it('allow keeps the path byte-identical to before the guard ({} returned)', async () => {
      accessEvaluate.mockReturnValue({ decision: 'allow', reason: 'no-rule' });

      const result = await createCredentialMiddleware(
        makeNonFoundryAgentContext('org-finance-bot'),
        mockReq,
      );

      expect(result).toEqual({});
      expect(accessEvaluate).toHaveBeenCalledWith({
        userMail: 'u@msf.org',
        source: null,
        agentName: 'finance-bot',
      });
      expect(emitAccessAudit).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'allow' }),
      );
      expect(getAccessTokenForOBO).not.toHaveBeenCalled();
      expect(getFoundryToken).not.toHaveBeenCalled();
    });

    it('flag DISABLED: untouched behavior — {} returned, no service calls at all', async () => {
      accessIsEnabled.mockReturnValue(false);

      const result = await createCredentialMiddleware(
        makeNonFoundryAgentContext('org-finance-bot'),
        mockReq,
      );

      expect(result).toEqual({});
      expect(accessEnsureFresh).not.toHaveBeenCalled();
      expect(accessEvaluate).not.toHaveBeenCalled();
      expect(emitAccessAudit).not.toHaveBeenCalled();
      expect(getAccessTokenForOBO).not.toHaveBeenCalled();
    });

    it('agentMode without an agentId never consults the service', async () => {
      const result = await createCredentialMiddleware(
        makeNonFoundryAgentContext('org-finance-bot', {
          model: {},
        }),
        mockReq,
      );

      expect(result).toEqual({});
      expect(accessEvaluate).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Prompt-agent invocations (docs/AGENT_ACCESS_CONTROL.md). botId is
  // client-controlled and discovery filtering is UX only, so every botId
  // that resolves to a stored prompt agent must be re-evaluated here under
  // the synthetic PROMPT_AGENT_SOURCE ('prompt-agent'), in EVERY
  // environment. An unknown/deleted prompt- botId resolves to no record and
  // falls through silently (same silent-degrade as removed static agents).
  // ───────────────────────────────────────────────────────────────────
  describe('prompt-agent invocations', () => {
    const promptAgentRecord = {
      version: 1,
      id: 'prompt-abc123def456',
      name: 'Persona',
      description: '',
      systemPrompt: 'You are a persona.',
      modelId: 'gpt-5.2',
      createdBy: 'admin@msf.org',
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedBy: 'admin@msf.org',
      updatedAt: '2026-07-18T00:00:00.000Z',
    };

    /** Context mimicking post-model-selection state for a resolved prompt
     *  agent: swapped standard model, agentMode false, no agentId. */
    function makePromptAgentContext(overrides: Record<string, any> = {}) {
      return makeContext({
        model: { id: 'gpt-5.2' },
        modelId: 'gpt-5.2',
        agentMode: false,
        agentSourcePath: undefined,
        botId: promptAgentRecord.id,
        promptAgent: promptAgentRecord,
        ...overrides,
      });
    }

    it('deny rule: blocked, evaluated under the prompt-agent source, audited', async () => {
      accessEvaluate.mockReturnValue({
        decision: 'deny',
        reason: 'not-allowed',
      });

      await expect(
        createCredentialMiddleware(makePromptAgentContext(), mockReq),
      ).rejects.toMatchObject({
        code: ErrorCode.AGENT_UNAVAILABLE,
        metadata: { accessDecision: 'deny', accessReason: 'not-allowed' },
      });

      expect(accessEnsureFresh).toHaveBeenCalled();
      expect(accessEvaluate).toHaveBeenCalledWith({
        userMail: 'u@msf.org',
        source: 'prompt-agent',
        agentName: 'prompt-abc123def456',
      });
      expect(emitAccessAudit).toHaveBeenCalledWith({
        userMail: 'u@msf.org',
        agentName: 'prompt-abc123def456',
        source: 'prompt-agent',
        decision: 'deny',
        reason: 'not-allowed',
      });
      // No credential machinery was touched on this path.
      expect(getAccessTokenForOBO).not.toHaveBeenCalled();
      expect(getFoundryToken).not.toHaveBeenCalled();
      expect(lookupUserAgentEndpoint).not.toHaveBeenCalled();
    });

    it('blocks the same way in production', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      accessEvaluate.mockReturnValue({
        decision: 'deny',
        reason: 'not-allowed',
      });

      await expect(
        createCredentialMiddleware(makePromptAgentContext(), mockReq),
      ).rejects.toMatchObject({ code: ErrorCode.AGENT_UNAVAILABLE });
      expect(getFoundryToken).not.toHaveBeenCalled();
    });

    it("'unavailable' (no last-known-good ruleset) blocks too", async () => {
      accessEvaluate.mockReturnValue({
        decision: 'unavailable',
        reason: 'rules-unavailable',
      });

      await expect(
        createCredentialMiddleware(makePromptAgentContext(), mockReq),
      ).rejects.toMatchObject({
        code: ErrorCode.AGENT_UNAVAILABLE,
        metadata: { accessDecision: 'unavailable' },
      });
      expect(emitAccessAudit).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'unavailable' }),
      );
    });

    it('allow proceeds with {} and audits the decision', async () => {
      accessEvaluate.mockReturnValue({ decision: 'allow', reason: 'no-rule' });

      const result = await createCredentialMiddleware(
        makePromptAgentContext(),
        mockReq,
      );

      expect(result).toEqual({});
      expect(emitAccessAudit).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'allow', source: 'prompt-agent' }),
      );
      expect(getAccessTokenForOBO).not.toHaveBeenCalled();
    });

    it('re-resolves from botId when context.promptAgent is absent', async () => {
      accessGetPromptAgentById.mockReturnValue(promptAgentRecord);
      accessEvaluate.mockReturnValue({
        decision: 'deny',
        reason: 'not-allowed',
      });

      await expect(
        createCredentialMiddleware(
          makePromptAgentContext({ promptAgent: undefined }),
          mockReq,
        ),
      ).rejects.toMatchObject({ code: ErrorCode.AGENT_UNAVAILABLE });

      expect(accessGetPromptAgentById).toHaveBeenCalledWith(
        'prompt-abc123def456',
      );
      expect(accessEvaluate).toHaveBeenCalledWith({
        userMail: 'u@msf.org',
        source: 'prompt-agent',
        agentName: 'prompt-abc123def456',
      });
    });

    it('unknown prompt- botId falls through silently (no guard, no audit)', async () => {
      accessGetPromptAgentById.mockReturnValue(null);

      const result = await createCredentialMiddleware(
        makePromptAgentContext({ promptAgent: undefined }),
        mockReq,
      );

      expect(result).toEqual({});
      expect(accessEvaluate).not.toHaveBeenCalled();
      expect(emitAccessAudit).not.toHaveBeenCalled();
    });

    it('static rag botId (non-prompt-agent) never triggers the guard', async () => {
      accessGetPromptAgentById.mockReturnValue(null);

      const result = await createCredentialMiddleware(
        makePromptAgentContext({
          promptAgent: undefined,
          botId: 'msf_communications',
        }),
        mockReq,
      );

      expect(result).toEqual({});
      expect(accessGetPromptAgentById).toHaveBeenCalledWith(
        'msf_communications',
      );
      expect(accessEvaluate).not.toHaveBeenCalled();
    });

    it('flag DISABLED: untouched behavior — no service calls at all', async () => {
      accessIsEnabled.mockReturnValue(false);

      const result = await createCredentialMiddleware(
        makePromptAgentContext(),
        mockReq,
      );

      expect(result).toEqual({});
      expect(accessEnsureFresh).not.toHaveBeenCalled();
      expect(accessGetPromptAgentById).not.toHaveBeenCalled();
      expect(accessEvaluate).not.toHaveBeenCalled();
      expect(emitAccessAudit).not.toHaveBeenCalled();
    });
  });
});
