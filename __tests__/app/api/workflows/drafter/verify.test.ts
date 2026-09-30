import { NextRequest } from 'next/server';

import { getChannelProfile } from '@/lib/utils/shared/drafter/channels/channelProfiles';

import { parseJsonResponse } from '../../helpers';

import { POST as verify } from '@/app/api/workflows/drafter/verify/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const loadSpecResolver = vi.hoisted(() => vi.fn());
const callStructured = vi.hoisted(() => vi.fn());
const beginWorkflowRun = vi.hoisted(() => vi.fn());

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/lib/services/workflows/policy/guard', () => ({
  isWorkflowEnabled: vi.fn().mockResolvedValue(true),
  workflowDisabledResponse: () => new Response('disabled', { status: 403 }),
}));
vi.mock('@/lib/services/workflows/drafterSpecLoaders', () => ({
  loadSpecResolver,
}));
vi.mock('@/lib/services/workflows/shared/workflowUsage', () => ({
  beginWorkflowRun,
}));
vi.mock('@/lib/services/workflows/shared/workflowLlm', () => ({
  createAzureClient: () => ({}),
  callStructured,
}));
vi.mock('@/lib/services/workflows/shared/workflowModels', () => ({
  resolveWorkflowModelId: () => 'model',
}));

const linkedin = getChannelProfile('linkedin')!;
const x = getChannelProfile('x')!;

const post = (payload: unknown) =>
  verify(
    new NextRequest('https://app.example.com/api/workflows/drafter/verify', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  );

const BRIEF = {
  keyMessage: 'Water is life',
  links: [],
  language: 'English',
  items: [
    {
      id: 'i1',
      kind: 'quote',
      text: 'We had no clean water for eleven days.',
      attribution: { name: 'Amina Yusuf', role: 'nurse' },
      verified: 'verbatim',
    },
    {
      id: 'i2',
      kind: 'figure',
      text: 'The clinic treated 1,200 patients in March.',
      verified: 'verbatim',
    },
  ],
};

const SEGMENT = {
  id: 's1',
  text: 'The clinic treated 1,200 patients in March. Then 9,999 more came.',
};

const target = (
  specId: string,
  claims: Array<{ segmentId: string; text: string }>,
) => ({ specId, segments: [SEGMENT], claims });

describe('[verify-route] POST /api/workflows/drafter/verify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: 'u1', mail: 'a@example.org' } });
    loadSpecResolver.mockResolvedValue({
      ok: true,
      resolve: (id: string) =>
        id === 'linkedin' ? linkedin : id === 'x' ? x : undefined,
    });
    beginWorkflowRun.mockResolvedValue({
      denied: null,
      usage: { fields: () => ({ usage: { tokens: 7 } }) },
    });
    callStructured.mockResolvedValue({
      verdicts: [
        {
          claimIndex: 1,
          verdict: 'supported',
          itemIds: ['i2'],
          reason: 'Stated.',
        },
      ],
    });
  });

  it('is a 401 without a session', async () => {
    mockAuth.mockResolvedValue(null);
    const response = await post({
      specKind: 'channel',
      targets: [target('linkedin', [{ segmentId: 's1', text: 'x' }])],
      brief: BRIEF,
    });
    expect(response.status).toBe(401);
    expect(callStructured).not.toHaveBeenCalled();
  });

  it('is a 400 on an unknown specKind', async () => {
    const response = await post({
      specKind: 'nope',
      targets: [],
      brief: BRIEF,
    });
    expect(response.status).toBe(400);
    expect((await parseJsonResponse(response)).error).toBe('Unknown specKind');
  });

  it('is a 400 on a brief with no items and no key message', async () => {
    const response = await post({
      specKind: 'channel',
      targets: [target('linkedin', [{ segmentId: 's1', text: 'x' }])],
      brief: { keyMessage: '   ', links: [], items: [] },
    });
    expect(response.status).toBe(400);
    expect((await parseJsonResponse(response)).error).toBe('brief is required');
  });

  it('drops a claim whose text is not in its segment and never sends it', async () => {
    const response = await post({
      specKind: 'channel',
      targets: [
        target('linkedin', [
          { segmentId: 's1', text: 'The clinic closed in April.' },
          {
            segmentId: 's1',
            text: 'The clinic treated 1,200 patients in March.',
          },
          {
            segmentId: 'ghost',
            text: 'The clinic treated 1,200 patients in March.',
          },
          { segmentId: 's1', text: '' },
        ]),
      ],
      brief: BRIEF,
    });
    expect(response.status).toBe(200);
    const prompt: string = callStructured.mock.calls[0][0].user;
    expect(prompt).not.toContain('closed in April');
    expect(prompt).toContain(
      '<claim index="1" segment="s1">The clinic treated 1,200 patients in March.</claim>',
    );
    expect(prompt).not.toContain('index="2"');
  });

  it('drops a target with no surviving claims, and is a 400 when none is left', async () => {
    const response = await post({
      specKind: 'channel',
      targets: [
        target('linkedin', [{ segmentId: 's1', text: 'Not in the text.' }]),
        { specId: 'x', segments: [SEGMENT], claims: 'not a list' },
        { specId: 'unknown', segments: [SEGMENT], claims: [] },
      ],
      brief: BRIEF,
    });
    expect(response.status).toBe(400);
    expect((await parseJsonResponse(response)).error).toBe('No claims to cite');
    expect(callStructured).not.toHaveBeenCalled();
    expect(beginWorkflowRun).not.toHaveBeenCalled();
  });

  it('keeps the first 12 claims of a target, deduplicated', async () => {
    const words = SEGMENT.text.split(' ');
    const prefixes = words.map((_, i) => words.slice(0, i + 1).join(' '));
    const suffixes = words.map((_, i) => words.slice(i).join(' '));
    const claims = [
      { segmentId: 's1', text: 'The' },
      { segmentId: 's1', text: 'THE' },
      ...[...prefixes, ...suffixes].map((text) => ({ segmentId: 's1', text })),
    ];
    expect(claims.length).toBeGreaterThan(13);
    const response = await post({
      specKind: 'channel',
      targets: [target('linkedin', claims)],
      brief: BRIEF,
    });
    expect(response.status).toBe(200);
    const prompt: string = callStructured.mock.calls[0][0].user;
    expect(prompt).toContain('<claim index="12"');
    expect(prompt).not.toContain('<claim index="13"');
    // Case-insensitive duplicates were dropped before the cap.
    expect(prompt.match(/>The<\/claim>/gu)).toHaveLength(1);
    expect(prompt).not.toContain('>THE</claim>');
    expect(callStructured.mock.calls[0][0].maxTokens).toBe(200 + 120 * 12);
  });

  it('labels the call per spec and begins the run as drafter_verify', async () => {
    const response = await post({
      specKind: 'channel',
      conversationId: 'c1',
      targets: [
        target('linkedin', [
          {
            segmentId: 's1',
            text: 'The clinic treated 1,200 patients in March.',
          },
        ]),
      ],
      brief: BRIEF,
    });
    expect(response.status).toBe(200);
    expect(beginWorkflowRun.mock.calls[0][1]).toBe('drafter_verify');
    expect(beginWorkflowRun.mock.calls[0][2]).toBe('c1');
    const options = callStructured.mock.calls[0][0];
    expect(options.usageLabel).toBe('cite:linkedin');
    expect(options.schemaName).toBe('drafter_verify');
    expect(options.model).toBe('model');
    expect(options.system).toContain('in English');
  });

  it('returns the denial when the run is refused', async () => {
    beginWorkflowRun.mockResolvedValue({
      denied: new Response('no', { status: 429 }),
      usage: null,
    });
    const response = await post({
      specKind: 'channel',
      targets: [
        target('linkedin', [
          {
            segmentId: 's1',
            text: 'The clinic treated 1,200 patients in March.',
          },
        ]),
      ],
      brief: BRIEF,
    });
    expect(response.status).toBe(429);
    expect(callStructured).not.toHaveBeenCalled();
  });

  it('fails one spec with VERIFY_FAILED while the other returns, and spreads usage', async () => {
    callStructured.mockImplementation(
      async ({ usageLabel }: { usageLabel: string }) => {
        if (usageLabel === 'cite:x') throw new Error('boom');
        return {
          verdicts: [
            {
              claimIndex: 1,
              verdict: 'supported',
              itemIds: ['i2'],
              reason: 'Stated.',
            },
          ],
        };
      },
    );
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const claims = [
      { segmentId: 's1', text: 'The clinic treated 1,200 patients in March.' },
    ];
    const response = await post({
      specKind: 'channel',
      targets: [target('linkedin', claims), target('x', claims)],
      brief: BRIEF,
    });
    spy.mockRestore();
    expect(response.status).toBe(200);
    const data = (await parseJsonResponse(response)).data;
    expect(data.results).toEqual([
      {
        specId: 'linkedin',
        verdicts: [
          {
            segmentId: 's1',
            text: 'The clinic treated 1,200 patients in March.',
            verdict: 'supported',
            itemIds: ['i2'],
            reason: 'Stated.',
          },
        ],
      },
      { specId: 'x', verdicts: [], error: 'VERIFY_FAILED' },
    ]);
    expect(data.usage).toEqual({ tokens: 7 });
  });

  it("downgrades a 'supported' over a number the brief lacks", async () => {
    callStructured.mockResolvedValue({
      verdicts: [
        { claimIndex: 1, verdict: 'supported', itemIds: ['i2'], reason: 'A' },
        { claimIndex: 2, verdict: 'supported', itemIds: ['km'], reason: 'B' },
      ],
    });
    const response = await post({
      specKind: 'channel',
      targets: [
        target('linkedin', [
          {
            segmentId: 's1',
            text: 'The clinic treated 1,200 patients in March.',
          },
          { segmentId: 's1', text: 'Then 9,999 more came.' },
        ]),
      ],
      brief: BRIEF,
    });
    const data = (await parseJsonResponse(response)).data;
    expect(
      data.results[0].verdicts.map((v: { verdict: string }) => v.verdict),
    ).toEqual(['supported', 'unsupported']);
    expect(data.results[0].verdicts[1].itemIds).toEqual([]);
    expect(data.results[0].verdicts[1].note).toBe('ungrounded-inside');
  });

  it('keeps one target per spec: duplicates never fan out extra model calls', async () => {
    const claims = [
      { segmentId: 's1', text: 'The clinic treated 1,200 patients in March.' },
    ];
    const response = await post({
      specKind: 'channel',
      targets: [
        target('linkedin', claims),
        target('linkedin', [
          { segmentId: 's1', text: 'Then 9,999 more came.' },
        ]),
        target('linkedin', claims),
        target('x', claims),
      ],
      brief: BRIEF,
    });
    expect(response.status).toBe(200);
    expect(callStructured).toHaveBeenCalledTimes(2);
    expect(beginWorkflowRun).toHaveBeenCalledTimes(1);
    const data = (await parseJsonResponse(response)).data;
    expect(data.results.map((r: { specId: string }) => r.specId)).toEqual([
      'linkedin',
      'x',
    ]);
    // The first target for the spec is the one kept.
    expect(callStructured.mock.calls[0][0].user).not.toContain(
      '>Then 9,999 more came.</claim>',
    );
  });

  it('finds a claim on a segment whose id is longer than the stored 40 characters', async () => {
    const longId = 'x'.repeat(50);
    const response = await post({
      specKind: 'channel',
      targets: [
        {
          specId: 'linkedin',
          segments: [{ id: longId, text: SEGMENT.text }],
          claims: [
            {
              segmentId: longId,
              text: 'The clinic treated 1,200 patients in March.',
            },
          ],
        },
      ],
      brief: BRIEF,
    });
    expect(response.status).toBe(200);
    const data = (await parseJsonResponse(response)).data;
    expect(data.results[0].verdicts[0].segmentId).toBe('x'.repeat(40));
  });

  it('echoes a long claim whole, so its stored key is the one the sentence has', async () => {
    const sentence = `${Array.from({ length: 160 }, (_, i) => `word${i}`).join(' ')}.`;
    expect(sentence.length).toBeGreaterThan(600);
    const response = await post({
      specKind: 'channel',
      targets: [
        {
          specId: 'linkedin',
          segments: [{ id: 's1', text: `Intro. ${sentence}` }],
          claims: [
            { segmentId: 's1', text: sentence },
            { segmentId: 's1', text: `  ${sentence} ` },
          ],
        },
      ],
      brief: BRIEF,
    });
    expect(response.status).toBe(200);
    const prompt: string = callStructured.mock.calls[0][0].user;
    // Deduplicated by key; the prompt carries the first 600 characters.
    expect(prompt).not.toContain('index="2"');
    expect(prompt).toContain(`>${sentence.slice(0, 600)}</claim>`);
    const data = (await parseJsonResponse(response)).data;
    expect(data.results[0].verdicts[0].text).toBe(sentence);
  });
});
