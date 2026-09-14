// M365 file-backed agent branch of createCredentialMiddleware: the layer-2
// verdict rides the returned context AND the rest of the middleware (byom
// resolution, Foundry classification) still runs — the branch used to
// return early, leaving an M365 agent on a byom- model with no credential.
// Also pins the user-facing copy per M365 denial reason.
import { NextRequest } from 'next/server';

import { createCredentialMiddleware } from '@/lib/services/chat/pipeline/Middleware';

import { ErrorCode } from '@/types/errors';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockReq = {} as unknown as NextRequest;

const resolveCustomSourceModel = vi.hoisted(() => vi.fn());
const getArmToken = vi.hoisted(() => vi.fn());
const getFoundryToken = vi.hoisted(() => vi.fn());
const getAccessTokenForOBO = vi.hoisted(() => vi.fn());
const getFoundryEndpoint = vi.hoisted(() => vi.fn());
const accessIsEnabled = vi.hoisted(() => vi.fn());
const accessEnsureFresh = vi.hoisted(() => vi.fn());
const accessEvaluate = vi.hoisted(() => vi.fn());
const accessGetM365AgentById = vi.hoisted(() => vi.fn());
const accessGetSnapshot = vi.hoisted(() => vi.fn());
const emitAccessAudit = vi.hoisted(() => vi.fn());
const checkAgentSourceAccess = vi.hoisted(() => vi.fn());
const M365ErrorMock = vi.hoisted(
  () =>
    class M365Error extends Error {
      constructor(
        readonly kind: string,
        message = kind,
      ) {
        super(message);
      }
    },
);

vi.mock('@/lib/services/models/customModelSources', () => ({
  resolveCustomSourceModel,
}));
vi.mock('@/lib/services/agents/AgentDiscoveryService', () => ({
  AgentDiscoveryService: {
    getInstance: () => ({
      lookupUserAgentEndpoint: vi.fn(),
      cacheUserAgentEndpoint: vi.fn(),
      listUserAgents: vi.fn(),
    }),
  },
}));
vi.mock('@/lib/services/auth/UserTokenProvider', () => ({
  UserTokenProvider: {
    getInstance: () => ({ getArmToken, getFoundryToken }),
  },
}));
vi.mock('@/lib/services/auth/OfficeResolver', () => ({
  OfficeResolver: { getFoundryEndpoint },
}));
vi.mock('@/auth', () => ({ auth: vi.fn(), getAccessTokenForOBO }));
vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: {
    getInstance: () => ({
      isEnabled: accessIsEnabled,
      ensureFresh: accessEnsureFresh,
      evaluateAccess: accessEvaluate,
      getPromptAgentById: () => null,
      getM365AgentById: accessGetM365AgentById,
      getOrgAgentById: () => null,
      getSnapshot: accessGetSnapshot,
    }),
  },
  emitAccessAudit,
}));
vi.mock('@/lib/services/m365/agentSourceAccess', () => ({
  checkAgentSourceAccess,
}));
vi.mock('@/lib/services/m365/graphApi', () => ({
  M365Error: M365ErrorMock,
}));

const ACCOUNT_PATH =
  '/subscriptions/abc/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/my-acct';
const BYOM_MODEL_ID = 'byom-abc123-my-gpt';

const m365AgentRecord = {
  version: 1,
  id: 'm365-abc123def456',
  name: 'Handbook',
  description: '',
  systemPrompt: 'persona',
  chatModelId: null,
  embeddingModelId: 'text-embedding-3-small',
  ragConfig: { topK: 5 },
  sources: [
    {
      sourceId: 's1',
      driveId: 'd',
      itemId: 'i',
      kind: 'file',
      title: 'a',
      webUrl: 'https://x',
      status: 'indexed',
    },
    {
      sourceId: 's2',
      driveId: 'd',
      itemId: 'j',
      kind: 'file',
      title: 'b',
      webUrl: 'https://y',
      status: 'indexed',
    },
  ],
  createdBy: 'a',
  createdAt: 't',
  updatedBy: 'a',
  updatedAt: 't',
};

function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    session: { user: { id: 'uid', mail: 'u@msf.org' } },
    user: { id: 'uid', mail: 'u@msf.org', region: 'EU' as const },
    model: { id: 'gpt-5.2' },
    modelId: 'gpt-5.2',
    agentMode: false,
    botId: m365AgentRecord.id,
    m365Agent: m365AgentRecord,
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  getFoundryEndpoint.mockReturnValue(
    'https://eu.services.ai.azure.com/api/projects/default',
  );
  getAccessTokenForOBO.mockResolvedValue('app-access-token');
  getArmToken.mockResolvedValue('arm-obo-token');
  getFoundryToken.mockResolvedValue('foundry-obo-token');
  accessIsEnabled.mockReturnValue(true);
  accessEnsureFresh.mockResolvedValue(undefined);
  accessEvaluate.mockReturnValue({ decision: 'allow', reason: 'no-rule' });
  accessGetM365AgentById.mockReturnValue(m365AgentRecord);
  accessGetSnapshot.mockReturnValue({ rulesUnavailable: false });
  checkAgentSourceAccess.mockResolvedValue({
    accessibleSourceIds: ['s1'],
    accessibleFolderItems: [{ driveId: 'd', itemId: 'k' }],
  });
  resolveCustomSourceModel.mockResolvedValue({
    id: BYOM_MODEL_ID,
    name: 'my-gpt',
    deploymentName: 'my-gpt',
    sdk: 'azure-openai',
    isCustomSourceModel: true,
    modelSource: ACCOUNT_PATH,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createCredentialMiddleware — M365 agent branch', () => {
  it('carries the layer-2 verdict on a standard model', async () => {
    const result = await createCredentialMiddleware(makeContext(), mockReq);

    expect(result).toMatchObject({
      m365AccessibleSourceIds: ['s1'],
      m365AccessibleFolderItems: [{ driveId: 'd', itemId: 'k' }],
    });
  });

  it('still resolves a byom- model after the M365 guard (no early return)', async () => {
    const result = await createCredentialMiddleware(
      makeContext({
        model: { id: BYOM_MODEL_ID, name: 'my-gpt' },
        modelId: BYOM_MODEL_ID,
        modelSourcePath: ACCOUNT_PATH,
      }),
      mockReq,
    );

    expect(resolveCustomSourceModel).toHaveBeenCalledWith(
      'arm-obo-token',
      BYOM_MODEL_ID,
      ACCOUNT_PATH,
    );
    expect(result.m365AccessibleSourceIds).toEqual(['s1']);
    expect(result.modelId).toBe(BYOM_MODEL_ID);
    expect(result.foundryEndpoint).toBe(
      'https://my-acct.services.ai.azure.com',
    );
    expect(result.userCredential).toBeDefined();
  });

  it('m365-no-file-access: denial names the request-access action', async () => {
    checkAgentSourceAccess.mockResolvedValue({
      accessibleSourceIds: [],
      accessibleFolderItems: [],
    });

    await expect(
      createCredentialMiddleware(makeContext(), mockReq),
    ).rejects.toMatchObject({
      code: ErrorCode.AGENT_UNAVAILABLE,
      message: expect.stringContaining(
        "don't have access to any of this agent's files",
      ),
      metadata: { accessDecision: 'deny', accessReason: 'm365-no-file-access' },
    });
  });

  it('m365-not_connected: tells the user to sign out and back in', async () => {
    checkAgentSourceAccess.mockRejectedValue(
      new M365ErrorMock('not_connected'),
    );

    await expect(
      createCredentialMiddleware(makeContext(), mockReq),
    ).rejects.toMatchObject({
      message: expect.stringContaining('Sign out and back in'),
      metadata: {
        accessDecision: 'unavailable',
        accessReason: 'm365-not_connected',
      },
    });
  });

  it('m365-consent_missing: names the pending tenant approval', async () => {
    checkAgentSourceAccess.mockRejectedValue(
      new M365ErrorMock('consent_missing'),
    );

    await expect(
      createCredentialMiddleware(makeContext(), mockReq),
    ).rejects.toMatchObject({
      message: expect.stringContaining('not yet approved'),
      metadata: { accessReason: 'm365-consent_missing' },
    });
  });

  it('keeps the generic copy for non-M365 reasons', async () => {
    accessEvaluate.mockReturnValue({ decision: 'deny', reason: 'not-allowed' });

    await expect(
      createCredentialMiddleware(makeContext(), mockReq),
    ).rejects.toMatchObject({
      message: expect.stringContaining('Contact your administrator'),
    });
  });
});
