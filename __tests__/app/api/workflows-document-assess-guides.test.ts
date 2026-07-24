import { Guide } from '@/lib/services/agentAccess/types';

import {
  createMockRequest,
  createMockSession,
  parseJsonResponse,
} from './helpers';

import { POST } from '@/app/api/workflows/document/assess/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const mockRunAssessment = vi.hoisted(() => vi.fn());
const mockRunProfile = vi.hoisted(() => vi.fn());
const serviceIsEnabled = vi.hoisted(() => vi.fn());
const serviceEnsureFresh = vi.hoisted(() => vi.fn());
const serviceGetGuideById = vi.hoisted(() => vi.fn());
const serviceEvaluateAccess = vi.hoisted(() => vi.fn());

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/lib/services/workflows/document/documentOrchestrator', () => ({
  runDocumentAssessment: mockRunAssessment,
  runDocumentProfile: mockRunProfile,
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
// The real budgeter pulls in tiktoken; identity-truncation keeps the test
// about resolution logic, not tokenization.
vi.mock('@/lib/services/workflows/shared/textBudget', () => ({
  truncateToTokenBudget: async (text: string) => ({
    text,
    truncated: false,
    tokens: 0,
  }),
}));

const GUIDE_ID = 'guide-abc123def456';
const GUIDE_CRITERION = `guide:${GUIDE_ID}`;

function makeGuide(overrides: Partial<Guide> = {}): Guide {
  return {
    version: 1,
    id: GUIDE_ID,
    kind: 'style',
    name: 'Nairobi French Style Guide',
    description: '',
    languages: [],
    body: '# Style rules',
    workflows: ['document'],
    createdBy: 'admin@example.com',
    createdAt: '2026-07-23T00:00:00.000Z',
    updatedBy: 'admin@example.com',
    updatedAt: '2026-07-23T00:00:00.000Z',
    ...overrides,
  };
}

function assessBody(overrides: Record<string, unknown> = {}) {
  return {
    docMarkdown: '# Title\n\nSome prose to assess.',
    criteria: [GUIDE_CRITERION],
    ...overrides,
  };
}

async function post(body: Record<string, unknown>) {
  return POST(createMockRequest({ method: 'POST', body }));
}

describe('document assess — admin guide resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(createMockSession());
    mockRunProfile.mockResolvedValue({});
    mockRunAssessment.mockResolvedValue({
      criteria: [],
      overallSummary: '',
      edits: [],
    });
    serviceIsEnabled.mockReturnValue(true);
    serviceEnsureFresh.mockResolvedValue(undefined);
    serviceGetGuideById.mockReturnValue(makeGuide());
    serviceEvaluateAccess.mockReturnValue({
      decision: 'allow',
      reason: 'public',
    });
  });

  it('resolves a guide criterion server-side and passes it to the orchestrator', async () => {
    const response = await post(assessBody());

    expect(response.status).toBe(200);
    expect(mockRunAssessment).toHaveBeenCalledWith(
      expect.objectContaining({
        criterionIds: [GUIDE_CRITERION],
        guides: [
          expect.objectContaining({
            id: GUIDE_ID,
            criterionId: GUIDE_CRITERION,
            kind: 'style',
            body: '# Style rules',
          }),
        ],
      }),
    );
  });

  it.each([
    ['unknown id', () => serviceGetGuideById.mockReturnValue(null)],
    [
      'access denied',
      () =>
        serviceEvaluateAccess.mockReturnValue({
          decision: 'deny',
          reason: 'not-allowed',
        }),
    ],
    [
      'rules unavailable',
      () =>
        serviceEvaluateAccess.mockReturnValue({
          decision: 'unavailable',
          reason: 'rules-unavailable',
        }),
    ],
    ['feature disabled', () => serviceIsEnabled.mockReturnValue(false)],
    [
      'wrong workflow',
      () =>
        serviceGetGuideById.mockReturnValue(
          makeGuide({ workflows: ['translation'] }),
        ),
    ],
    [
      'slot kind used as a criterion',
      () =>
        serviceGetGuideById.mockReturnValue(makeGuide({ kind: 'structure' })),
    ],
  ])('fails closed with one generic message on %s', async (_label, arrange) => {
    arrange();
    const response = await post(assessBody());
    const parsed = await parseJsonResponse(response);

    expect(response.status).toBe(400);
    // Every failure mode must be indistinguishable — a distinct message for
    // "denied" would be an existence oracle for restricted guides.
    expect(parsed.error).toBe('Guide is not available');
  });

  it('caps the number of guide criteria per assessment', async () => {
    const response = await post(
      assessBody({
        criteria: [
          'guide:guide-000000000001',
          'guide:guide-000000000002',
          'guide:guide-000000000003',
          'guide:guide-000000000004',
        ],
      }),
    );
    const parsed = await parseJsonResponse(response);

    expect(response.status).toBe(400);
    expect(parsed.error).toBe('Too many guides selected');
  });

  describe('spec/tone slot guides', () => {
    it('accepts a structure guide in place of a spec for specAdherence', async () => {
      serviceGetGuideById.mockReturnValue(makeGuide({ kind: 'structure' }));

      const response = await post(
        assessBody({
          criteria: ['specAdherence'],
          specGuideId: GUIDE_ID,
        }),
      );

      expect(response.status).toBe(200);
      expect(mockRunAssessment).toHaveBeenCalledWith(
        expect.objectContaining({
          structureGuide: expect.objectContaining({ kind: 'structure' }),
        }),
      );
    });

    it('rejects a spec and a structure guide together', async () => {
      const response = await post(
        assessBody({
          criteria: ['specAdherence'],
          spec: { name: 'Local spec', sections: [] },
          specGuideId: GUIDE_ID,
        }),
      );
      const parsed = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(parsed.error).toContain('not both');
    });

    it('rejects a slot guide of the wrong kind', async () => {
      // A style guide cannot fill the tone slot.
      serviceGetGuideById.mockReturnValue(makeGuide({ kind: 'style' }));

      const response = await post(
        assessBody({
          criteria: ['toneAdherence'],
          toneGuideId: GUIDE_ID,
        }),
      );
      const parsed = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(parsed.error).toBe('Guide is not available');
    });

    it('still requires SOMETHING in the slot for specAdherence', async () => {
      const response = await post(assessBody({ criteria: ['specAdherence'] }));
      expect(response.status).toBe(400);
    });
  });
});
