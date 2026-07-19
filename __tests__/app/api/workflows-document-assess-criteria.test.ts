import { MAX_CRITERION_RUBRIC_CHARS } from '@/lib/utils/shared/review/customCriteria';

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

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/lib/services/workflows/document/documentOrchestrator', () => ({
  runDocumentAssessment: mockRunAssessment,
  runDocumentProfile: mockRunProfile,
}));

const CUSTOM_ID = 'custom:11111111-2222-3333-4444-555555555555';

function body(rubric: string) {
  return {
    docMarkdown: '# Title\n\nSome prose to assess.',
    criteria: [CUSTOM_ID],
    customCriteria: [{ id: CUSTOM_ID, name: 'AI detection', rubric }],
  };
}

describe('document assess — custom criterion validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(createMockSession());
    mockRunProfile.mockResolvedValue({});
    mockRunAssessment.mockResolvedValue({
      criteria: [],
      overallSummary: '',
      edits: [],
    });
  });

  it('names the criterion and the real reason when a rubric is too long', async () => {
    // Regression: an over-long rubric was dropped from the definition map and
    // then reported as "Unknown criterion" — sending the user to look for a
    // criterion that was plainly sitting in their list.
    const rubric = 'x'.repeat(MAX_CRITERION_RUBRIC_CHARS + 5000);
    const response = await POST(
      createMockRequest({ method: 'POST', body: body(rubric) }),
    );
    const parsed = await parseJsonResponse(response);

    expect(response.status).toBe(400);
    expect(parsed.error).toContain('AI detection');
    expect(parsed.error).toContain('rubric');
    expect(parsed.error).toContain(String(MAX_CRITERION_RUBRIC_CHARS));
    expect(parsed.error).not.toContain('Unknown criterion');
  });

  it('still reports genuinely unknown criteria as unknown', async () => {
    const response = await POST(
      createMockRequest({
        method: 'POST',
        body: {
          docMarkdown: '# Title\n\nProse.',
          criteria: ['custom:99999999-9999-9999-9999-999999999999'],
          customCriteria: [],
        },
      }),
    );
    const parsed = await parseJsonResponse(response);

    expect(response.status).toBe(400);
    expect(parsed.error).toBe('Unknown criterion');
  });

  it('accepts a rubric exactly at the limit', async () => {
    const rubric = 'x'.repeat(MAX_CRITERION_RUBRIC_CHARS);
    const response = await POST(
      createMockRequest({ method: 'POST', body: body(rubric) }),
    );
    expect(response.status).toBe(200);
  });
});
