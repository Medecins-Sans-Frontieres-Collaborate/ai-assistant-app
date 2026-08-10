import { Guide } from '@/lib/services/agentAccess/types';

import {
  createMockRequest,
  createMockSession,
  parseJsonResponse,
} from './helpers';

import { POST } from '@/app/api/workflows/translation/assess/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const mockRunAssessment = vi.hoisted(() => vi.fn());
const serviceIsEnabled = vi.hoisted(() => vi.fn());
const serviceEnsureFresh = vi.hoisted(() => vi.fn());
const serviceGetGuideById = vi.hoisted(() => vi.fn());
const serviceEvaluateAccess = vi.hoisted(() => vi.fn());

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/lib/services/workflows/translation/translationOrchestrator', () => ({
  runTranslationAssessment: mockRunAssessment,
}));
vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: {
    getInstance: () => ({
      isEnabled: serviceIsEnabled,
      ensureFresh: serviceEnsureFresh,
      getGuideById: serviceGetGuideById,
      evaluateAccess: serviceEvaluateAccess,
    }),
  },
  emitAccessAudit: vi.fn(),
}));
vi.mock('@/lib/services/workflows/shared/textBudget', () => ({
  truncateToTokenBudget: async (text: string) => ({
    text,
    truncated: false,
    tokens: 0,
  }),
}));

const GUIDE_ID = 'guide-abc123def456';

function makeTerminologyGuide(overrides: Partial<Guide> = {}): Guide {
  return {
    version: 1,
    id: GUIDE_ID,
    kind: 'terminology',
    name: 'Org terminology',
    description: '',
    languages: [],
    entries: [
      { source: 'IDP', target: 'personne déplacée' },
      { source: 'NFI', target: 'article non alimentaire' },
    ],
    workflows: ['translation'],
    createdBy: 'admin@example.com',
    createdAt: '2026-07-23T00:00:00.000Z',
    updatedBy: 'admin@example.com',
    updatedAt: '2026-07-23T00:00:00.000Z',
    ...overrides,
  };
}

function assessBody(overrides: Record<string, unknown> = {}) {
  return {
    sourceText: 'The IDP camp needs NFI kits.',
    translation: 'Le camp a besoin de kits.',
    targetLanguage: 'French',
    criteria: ['accuracy'],
    ...overrides,
  };
}

async function post(body: Record<string, unknown>) {
  return POST(createMockRequest({ method: 'POST', body }));
}

describe('translation assess — organization terminology guide', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(createMockSession());
    mockRunAssessment.mockResolvedValue({
      criteria: [],
      overallSummary: '',
      edits: [],
    });
    serviceIsEnabled.mockReturnValue(true);
    serviceEnsureFresh.mockResolvedValue(undefined);
    serviceGetGuideById.mockReturnValue(makeTerminologyGuide());
    serviceEvaluateAccess.mockReturnValue({
      decision: 'allow',
      reason: 'public',
    });
  });

  it('merges guide entries with local entries, guide first and winning on duplicates', async () => {
    const response = await post(
      assessBody({
        glossaryGuideId: GUIDE_ID,
        glossaryEntries: [
          // Case-insensitive duplicate of the guide's IDP entry — the
          // guide's translation must win.
          { source: 'idp', target: 'déplacé interne' },
          { source: 'WASH', target: 'EAH' },
        ],
      }),
    );

    expect(response.status).toBe(200);
    expect(mockRunAssessment).toHaveBeenCalledWith(
      expect.objectContaining({
        glossaryEntries: [
          { source: 'IDP', target: 'personne déplacée' },
          { source: 'NFI', target: 'article non alimentaire' },
          { source: 'WASH', target: 'EAH' },
        ],
      }),
    );
  });

  it.each([
    ['unknown guide', () => serviceGetGuideById.mockReturnValue(null)],
    [
      'access denied',
      () =>
        serviceEvaluateAccess.mockReturnValue({
          decision: 'deny',
          reason: 'not-allowed',
        }),
    ],
    [
      'wrong kind',
      () =>
        serviceGetGuideById.mockReturnValue(
          makeTerminologyGuide({
            kind: 'style',
            entries: undefined,
            body: '# Style',
            workflows: ['translation'],
          }),
        ),
    ],
    [
      'document-only guide',
      () =>
        serviceGetGuideById.mockReturnValue(
          makeTerminologyGuide({ workflows: ['document'] }),
        ),
    ],
  ])('fails closed on %s', async (_label, arrange) => {
    arrange();
    const response = await post(assessBody({ glossaryGuideId: GUIDE_ID }));
    const parsed = await parseJsonResponse(response);

    expect(response.status).toBe(400);
    expect(parsed.error).toBe('Guide is not available');
  });

  it('runs without any guide exactly as before', async () => {
    const response = await post(
      assessBody({ glossaryEntries: [{ source: 'WASH', target: 'EAH' }] }),
    );
    expect(response.status).toBe(200);
    expect(mockRunAssessment).toHaveBeenCalledWith(
      expect.objectContaining({
        glossaryEntries: [{ source: 'WASH', target: 'EAH' }],
      }),
    );
  });
});
