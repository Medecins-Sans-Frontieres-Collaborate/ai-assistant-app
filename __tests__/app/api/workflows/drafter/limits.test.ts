import { NextRequest } from 'next/server';

import {
  SOURCE_PRE_SLICE_CHARS,
  SOURCE_TOKEN_BUDGET,
} from '@/lib/services/workflows/shared/drafter/extract';

import { getChannelProfile } from '@/lib/utils/shared/drafter/channels/channelProfiles';

import { parseJsonResponse } from '../../helpers';

import { POST as extract } from '@/app/api/workflows/drafter/extract/route';
import { POST as generate } from '@/app/api/workflows/drafter/generate/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const loadSpecResolver = vi.hoisted(() => vi.fn());
const callStructured = vi.hoisted(() => vi.fn());
const truncate = vi.hoisted(() => vi.fn());

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/lib/services/workflows/policy/guard', () => ({
  isWorkflowEnabled: vi.fn().mockResolvedValue(true),
  workflowDisabledResponse: () => new Response('disabled', { status: 403 }),
}));
vi.mock('@/lib/services/workflows/drafterSpecLoaders', () => ({
  loadSpecResolver,
}));
vi.mock('@/lib/services/workflows/shared/workflowUsage', () => ({
  beginWorkflowRun: vi
    .fn()
    .mockResolvedValue({ denied: null, usage: { fields: () => ({}) } }),
}));
vi.mock('@/lib/services/workflows/shared/workflowLlm', () => ({
  createAzureClient: () => ({}),
  callStructured,
}));
vi.mock('@/lib/services/workflows/shared/workflowModels', () => ({
  resolveWorkflowModelId: () => 'model',
}));
vi.mock('@/lib/services/workflows/shared/drafter/voices', () => ({
  VOICE_UNAVAILABLE: 'VOICE_UNAVAILABLE',
  resolveVoices: async ({ specIds }: { specIds: string[] }) =>
    Object.fromEntries(specIds.map((id) => [id, { ok: true }])),
}));
vi.mock('@/lib/services/workflows/shared/textBudget', () => ({
  truncateToTokenBudget: truncate,
}));

const linkedin = getChannelProfile('linkedin')!;
const post = (
  handler: (req: NextRequest) => Promise<Response>,
  payload: unknown,
) =>
  handler(
    new NextRequest('https://app.example.com/api/workflows/drafter', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  );

describe('drafter routes: request limits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: 'u1', mail: 'a@example.org' } });
    loadSpecResolver.mockResolvedValue({
      ok: true,
      resolve: (id: string) => (id === 'linkedin' ? linkedin : undefined),
    });
    truncate.mockImplementation(async (text: string) => ({
      text,
      truncated: false,
      tokens: 1,
    }));
  });

  it('generate shows the model at most 30 current segments of a spec', async () => {
    callStructured.mockResolvedValue({
      segments: [{ text: 'A post.', usedItemIds: [] }],
    });
    const response = await post(generate, {
      specKind: 'channel',
      specIds: ['linkedin'],
      brief: { keyMessage: 'Water is life', items: [], links: [] },
      current: {
        linkedin: Array.from({ length: 5_000 }, (_, i) => `segment ${i}`),
      },
    });
    expect(response.status).toBe(200);
    const prompt: string = callStructured.mock.calls[0][0].user;
    expect(prompt).toContain('[30] segment 29');
    expect(prompt).not.toContain('[31]');
  });

  it('generate refuses with 503 when channel settings cannot be read', async () => {
    loadSpecResolver.mockResolvedValue({
      ok: false,
      response: new Response('{}', { status: 503 }),
    });
    const response = await post(generate, {
      specKind: 'channel',
      specIds: ['linkedin'],
      brief: { keyMessage: 'Water is life', items: [], links: [] },
    });
    expect(response.status).toBe(503);
    expect(callStructured).not.toHaveBeenCalled();
  });

  it('extract never tokenises more than the character cap, and says it cut', async () => {
    callStructured.mockResolvedValue({
      keyMessage: 'k',
      callToAction: null,
      language: 'English',
      items: [],
    });
    const response = await post(extract, {
      specKind: 'channel',
      sources: [
        {
          record: { id: 'src1', name: 'Huge' },
          text: 'a'.repeat(SOURCE_PRE_SLICE_CHARS * 3),
        },
        { record: { id: 'bad id"><x', name: 'Skipped' }, text: 'text' },
      ],
      existing: [{ kind: 'x'.repeat(50_000), text: 'dropped' }],
    });
    expect(response.status).toBe(200);
    expect(truncate).toHaveBeenCalledTimes(1);
    expect(truncate.mock.calls[0][0]).toHaveLength(SOURCE_PRE_SLICE_CHARS);
    expect(truncate.mock.calls[0][1]).toBe(SOURCE_TOKEN_BUDGET);
    const prompt: string = callStructured.mock.calls[0][0].user;
    expect(prompt).toContain('[…truncated…]');
    expect(prompt).not.toContain('Skipped');
    expect(prompt).not.toContain('ALREADY IN THE BRIEF');
    expect(prompt.length).toBeLessThan(SOURCE_PRE_SLICE_CHARS + 200);
  });

  it('extract is a 400 when no source survives validation', async () => {
    const response = await post(extract, {
      specKind: 'channel',
      sources: [{ record: { id: 'no spaces allowed', name: 'n' }, text: 't' }],
      existing: [],
    });
    expect(response.status).toBe(400);
    expect((await parseJsonResponse(response)).error).toBe(
      'No readable source text',
    );
    expect(callStructured).not.toHaveBeenCalled();
  });
});
