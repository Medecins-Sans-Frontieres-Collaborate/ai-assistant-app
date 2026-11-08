import { createLimitsMiddleware } from '@/lib/services/chat/pipeline/Middleware';

import { DEFAULT_DOCUMENTS_PER_MESSAGE } from '@/config/limits';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Middleware.ts pulls the whole chat service graph; the same stubs the
// telemetry middleware test uses keep it importable.
vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: {
    getInstance: () => ({
      isEnabled: vi.fn(),
      ensureFresh: vi.fn(),
      getPromptAgentById: vi.fn(),
      getM365AgentById: vi.fn(),
      getOrgAgentById: vi.fn(),
    }),
  },
  emitAccessAudit: vi.fn(),
}));
vi.mock('@/lib/services/orgAgents/orgAgentRegistry', () => ({
  resolveOrgAgentById: vi.fn(),
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

const policyRef = vi.hoisted(() => ({
  current: null as null | Record<string, unknown>,
}));

// Real resolution (resolver + checkCeiling); only the stored policy is faked.
vi.mock('@/lib/services/limits/enforcement', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/services/limits/enforcement')>();
  return { ...actual, currentPolicy: vi.fn(async () => policyRef.current) };
});
vi.mock('@/lib/services/limits/principal', () => ({
  buildPrincipal: vi.fn((session: { user: { id: string; mail: string } }) => ({
    userId: session.user.id,
    mail: session.user.mail,
    domain: session.user.mail.split('@')[1],
    attributes: [],
    groupIds: [],
  })),
}));
vi.mock('@/lib/services/limits/modelAvailability', () => ({
  isModelBlocked: vi.fn(() => false),
}));
vi.mock('@/lib/services/limits/tokenDebit', () => ({
  checkTokenBudget: vi.fn(async () => null),
}));
vi.mock('@/lib/services/limits/usageStore', () => ({
  reserve: vi.fn(async () => ({ allowed: true, debited: [] })),
}));

const NOW = '2026-11-07T00:00:00.000Z';

/** An enforcing policy, optionally raising the limit for one person. */
function policy(
  mode: 'observe' | 'enforce',
  override?: { mail: string; value: number },
) {
  return {
    version: 1,
    mode,
    failMode: 'open',
    timezone: 'UTC',
    countByomUsage: false,
    countAuxiliaryUsage: false,
    defaults: [],
    delegations: [],
    modelAccess: [],
    overrides: override
      ? [
          {
            id: 'lim-0123456789ab',
            label: 'Evaluation team',
            enabled: true,
            scope: 'user',
            targets: [override.mail],
            priority: 0,
            entries: [
              {
                limitKey: 'feature.upload.documentsPerMessage',
                value: override.value,
                ceiling: false,
              },
            ],
            createdBy: 'admin',
            createdAt: NOW,
            updatedBy: 'admin',
            updatedAt: NOW,
          },
        ]
      : [],
    updatedBy: 'admin',
    updatedAt: NOW,
  };
}

/** A turn whose newest message carries `documents` PDFs and one audio file. */
function turn(documents: number, mail = 'someone@msf.org') {
  return {
    user: { id: 'oid-1', mail },
    modelId: 'gpt-5.2',
    model: { id: 'gpt-5.2' },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Review these' },
          ...Array.from({ length: documents }, (_, i) => ({
            type: 'file_url',
            url: `/api/file/r${i}.pdf`,
            originalFilename: `Rapport_${i}.pdf`,
          })),
          // Audio/video has its own cap and never counts as a document.
          {
            type: 'file_url',
            url: '/api/file/call.mp3',
            originalFilename: 'call.mp3',
          },
        ],
      },
    ],
  } as never;
}

describe('createLimitsMiddleware — documents per message', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('admits exactly the default and refuses one more when enforcing', async () => {
    policyRef.current = policy('enforce');
    await expect(
      createLimitsMiddleware(turn(DEFAULT_DOCUMENTS_PER_MESSAGE)),
    ).resolves.toBeDefined();
    await expect(
      createLimitsMiddleware(turn(DEFAULT_DOCUMENTS_PER_MESSAGE + 1)),
    ).rejects.toThrow();
  });

  it('lets an admin raise the limit for a specific person only', async () => {
    policyRef.current = policy('enforce', {
      mail: 'evaluator@msf.org',
      value: 8,
    });
    await expect(
      createLimitsMiddleware(turn(8, 'evaluator@msf.org')),
    ).resolves.toBeDefined();
    await expect(
      createLimitsMiddleware(turn(9, 'evaluator@msf.org')),
    ).rejects.toThrow();
    await expect(createLimitsMiddleware(turn(8))).rejects.toThrow();
  });

  it('never blocks in observe mode', async () => {
    policyRef.current = policy('observe');
    await expect(createLimitsMiddleware(turn(12))).resolves.toBeDefined();
  });
});
