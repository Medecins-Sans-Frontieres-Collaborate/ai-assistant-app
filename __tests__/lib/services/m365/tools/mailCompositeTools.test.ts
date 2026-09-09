/**
 * Composite (agentic) mail tools — fifth pass. Fixture-driven coverage of
 * the binding execution rules: pure conversation-join cores, the
 * 500-envelope scan cap, PARTIAL-on-timeout (fake clock), flagged-body
 * exclusion + surfacing, utility-degraded fallbacks, conversation dedupe,
 * count-bearing activity markers, Retry-After honoring, and configured-
 * mailbox enforcement. Graph is mocked at mintGraphToken + global fetch
 * (composites do targeted raw fetches to see Retry-After); the phishing
 * screen and the utility OpenAI client are mocked/injected.
 */
import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import type { M365ToolExecutionContext } from '@/lib/services/m365/tools/executor';
import {
  computeAwaitingMyReply,
  computeAwaitingTheirReply,
  heuristicDigestBucket,
  mailAwaitingMyReply,
  mailAwaitingTheirReply,
  mailCommitments,
  mailDeepSearch,
  mailDigest,
  mailThreadBrief,
} from '@/lib/services/m365/tools/mailCompositeTools';
import {
  MailEnvelopeLite,
  PARTIAL_PREFIX,
  dedupeByConversation,
  setNowFnForTests,
  setSleepFnForTests,
  setUtilityClientForTests,
} from '@/lib/services/m365/tools/mailOrchestration';
import { M365ToolInputError } from '@/lib/services/m365/tools/shared';

import type OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mintGraphTokenMock = vi.hoisted(() => vi.fn());
const screenMock = vi.hoisted(() => vi.fn());

vi.mock('@/auth', () => ({ getGraphAccessToken: vi.fn() }));

vi.mock('@/lib/services/m365/graphApi', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/services/m365/graphApi')>();
  return { ...actual, mintGraphToken: mintGraphTokenMock };
});

vi.mock('@/lib/services/m365/tools/mailScreen', () => ({
  screenMailMessage: screenMock,
  clearMailScreenCache: vi.fn(),
}));

const DAY = 86_400_000;
const FIXED_NOW = Date.parse('2026-07-31T12:00:00Z');

const req = new NextRequest('http://localhost/api/chat');
const session = {
  user: { id: 'u1', mail: 'me@contoso.com' },
} as unknown as Session;

const fetchMock = vi.fn();
const utilityCreateMock = vi.fn();
const fakeUtilityClient = {
  chat: { completions: { create: utilityCreateMock } },
} as unknown as OpenAI;

function makeCtx(
  overrides: Partial<M365ToolExecutionContext> = {},
): M365ToolExecutionContext {
  return {
    emitActivity: vi.fn(),
    screenOverrideIds: new Set<string>(),
    sharedMailboxes: [],
    ...overrides,
  };
}

function jsonResponse(
  payload: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

function utilityJson(payload: unknown) {
  return { choices: [{ message: { content: JSON.stringify(payload) } }] };
}

let messageSeq = 0;
function graphMessage(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  messageSeq++;
  return {
    id: `m${messageSeq}`,
    conversationId: `c${messageSeq}`,
    subject: `Subject ${messageSeq}`,
    from: { emailAddress: { name: 'Maria', address: 'maria@contoso.com' } },
    toRecipients: [{ emailAddress: { address: 'me@contoso.com' } }],
    ccRecipients: [],
    receivedDateTime: '2026-07-30T10:00:00Z',
    bodyPreview: 'Hello there',
    importance: 'normal',
    hasAttachments: false,
    ...overrides,
  };
}

function lite(overrides: Partial<MailEnvelopeLite> = {}): MailEnvelopeLite {
  return {
    id: 'm1',
    conversationId: 'c1',
    subject: 'Subject',
    fromName: 'Maria',
    fromAddress: 'maria@contoso.com',
    toAddresses: ['me@contoso.com'],
    ccAddresses: [],
    receivedMs: FIXED_NOW - 2 * DAY,
    receivedIso: '2026-07-29T12:00:00Z',
    preview: '',
    importance: 'normal',
    hasAttachments: false,
    ...overrides,
  };
}

function activityCalls(ctx: M365ToolExecutionContext): string[] {
  return (ctx.emitActivity as ReturnType<typeof vi.fn>).mock.calls.map(
    (call) => call[0] as string,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  messageSeq = 0;
  vi.stubGlobal('fetch', fetchMock);
  mintGraphTokenMock.mockResolvedValue('token');
  screenMock.mockResolvedValue({ verdict: 'clear' });
  setSleepFnForTests(async () => {});
  setNowFnForTests(() => FIXED_NOW);
  setUtilityClientForTests(fakeUtilityClient);
  // Fresh Response per call — a Response body is single-read.
  fetchMock.mockImplementation(async () => jsonResponse({ value: [] }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  setNowFnForTests(null);
  setSleepFnForTests(null);
  // null (not undefined): never let a stray call construct the real client.
  setUtilityClientForTests(null);
});

// ---------------------------------------------------------------------------
// Pure conversation-join cores
// ---------------------------------------------------------------------------

describe('computeAwaitingMyReply (pure core)', () => {
  it('keeps conversations with no later user reply and drops answered ones', () => {
    const received = [
      lite({ id: 'r1', conversationId: 'c1', receivedMs: FIXED_NOW - 3 * DAY }),
      lite({ id: 'r2', conversationId: 'c2', receivedMs: FIXED_NOW - 2 * DAY }),
    ];
    const sent = [
      // Reply in c2 AFTER the received message → c2 is answered.
      lite({ id: 's1', conversationId: 'c2', receivedMs: FIXED_NOW - DAY }),
      // Reply in c1 BEFORE the received message → c1 still awaiting.
      lite({ id: 's2', conversationId: 'c1', receivedMs: FIXED_NOW - 5 * DAY }),
    ];
    const candidates = computeAwaitingMyReply({
      received,
      sent,
      userAddress: 'me@contoso.com',
      nowMs: FIXED_NOW,
    });
    expect(candidates.map((c) => c.envelope.id)).toEqual(['r1']);
    expect(candidates[0].reasons.join(' ')).toContain('3d without your reply');
  });

  it('scores direct-to over cc and surfaces question/rank/importance reasons', () => {
    const direct = lite({
      id: 'd1',
      conversationId: 'c1',
      preview: 'Can you review this?',
      importance: 'high',
      receivedMs: FIXED_NOW - DAY,
    });
    const ccOnly = lite({
      id: 'd2',
      conversationId: 'c2',
      toAddresses: ['other@contoso.com'],
      ccAddresses: ['me@contoso.com'],
      receivedMs: FIXED_NOW - DAY,
    });
    const candidates = computeAwaitingMyReply({
      received: [ccOnly, direct],
      sent: [],
      userAddress: 'me@contoso.com',
      peopleRank: new Map([['maria@contoso.com', 0]]),
      nowMs: FIXED_NOW,
    });
    expect(candidates[0].envelope.id).toBe('d1');
    expect(candidates[0].directTo).toBe(true);
    expect(candidates[0].score).toBeGreaterThan(candidates[1].score);
    const reasons = candidates[0].reasons.join('; ');
    expect(reasons).toContain('addressed directly to you');
    expect(reasons).toContain('contains a question');
    expect(reasons).toContain('marked high importance');
    expect(reasons).toContain('frequent correspondent');
    expect(candidates[1].reasons.join('; ')).toContain("you are cc'd");
  });
});

describe('computeAwaitingTheirReply (pure core)', () => {
  it('keeps silent threads past the threshold, drops answered and fresh ones', () => {
    const sent = [
      lite({ id: 's1', conversationId: 'c1', receivedMs: FIXED_NOW - 5 * DAY }),
      lite({ id: 's2', conversationId: 'c2', receivedMs: FIXED_NOW - 5 * DAY }),
      lite({ id: 's3', conversationId: 'c3', receivedMs: FIXED_NOW - DAY }),
    ];
    const received = [
      // Answer in c2 after the user's send → not silent.
      lite({ id: 'r1', conversationId: 'c2', receivedMs: FIXED_NOW - 4 * DAY }),
    ];
    const candidates = computeAwaitingTheirReply({
      sent,
      received,
      minDaysSilent: 3,
      nowMs: FIXED_NOW,
    });
    expect(candidates.map((c) => c.envelope.id)).toEqual(['s1']);
    expect(candidates[0].daysSilent).toBe(5);
    expect(candidates[0].reasons.join(' ')).toContain('no reply for 5d');
  });
});

describe('dedupeByConversation / heuristics', () => {
  it('keeps only the newest envelope per conversation', () => {
    const result = dedupeByConversation([
      lite({ id: 'old', conversationId: 'c1', receivedMs: 1_000 }),
      lite({ id: 'new', conversationId: 'c1', receivedMs: 2_000 }),
      lite({ id: 'other', conversationId: 'c2', receivedMs: 1_500 }),
    ]);
    expect(result.map((envelope) => envelope.id)).toEqual(['new', 'other']);
  });

  it('classifies automated senders as bulk and questions as needs_action', () => {
    expect(
      heuristicDigestBucket(lite({ fromAddress: 'no-reply@svc.com' })).bucket,
    ).toBe('bulk');
    expect(
      heuristicDigestBucket(lite({ preview: 'Can you approve this?' })).bucket,
    ).toBe('needs_action');
    expect(heuristicDigestBucket(lite({ preview: 'FYI notes' })).bucket).toBe(
      'fyi',
    );
  });
});

// ---------------------------------------------------------------------------
// mail_digest
// ---------------------------------------------------------------------------

describe('mailDigest', () => {
  it('classifies conversations in ONE batched utility call and renders buckets', async () => {
    const m1 = graphMessage({ id: 'a1', conversationId: 'conv1' });
    const m2 = graphMessage({
      id: 'a2',
      conversationId: 'conv1',
      receivedDateTime: '2026-07-31T08:00:00Z',
    });
    const m3 = graphMessage({ id: 'a3', conversationId: 'conv2' });
    fetchMock.mockResolvedValue(jsonResponse({ value: [m2, m1, m3] }));
    utilityCreateMock.mockResolvedValue(
      utilityJson({
        items: [
          { id: 'a2', bucket: 'needs_action', reason: 'direct question' },
          { id: 'a3', bucket: 'bulk', reason: 'newsletter' },
        ],
      }),
    );
    const ctx = makeCtx();
    const result = await mailDigest(req, session, {}, ctx);

    expect(utilityCreateMock).toHaveBeenCalledTimes(1);
    const params = utilityCreateMock.mock.calls[0][0];
    expect(params.model).toBe('gpt-5-mini');
    expect(params.reasoning_effort).toBe('low');
    expect(params.response_format.json_schema.strict).toBe(true);
    expect(result).toContain('3 messages in 2 conversations');
    expect(result).toContain('Needs action (1):');
    expect(result).toContain('Bulk / automated (1):');
    expect(result).toContain('direct question');
    expect(result).toContain('(2 messages)');
    // Envelope-only tool: no bodies fetched, so no screening happens.
    expect(screenMock).not.toHaveBeenCalled();
    for (const line of activityCalls(ctx)) {
      expect(line).toMatch(/\d/);
    }
  });

  it('degrades to heuristic classification with a note when the utility model is unavailable', async () => {
    setUtilityClientForTests(null);
    fetchMock.mockResolvedValue(
      jsonResponse({
        value: [
          graphMessage({
            id: 'a1',
            conversationId: 'conv1',
            bodyPreview: 'Can you approve the budget?',
          }),
          graphMessage({
            id: 'a2',
            conversationId: 'conv2',
            from: { emailAddress: { address: 'no-reply@updates.com' } },
          }),
        ],
      }),
    );
    const result = await mailDigest(req, session, {}, makeCtx());
    expect(result).toContain('analysis degraded');
    expect(result).toContain('Needs action (1):');
    expect(result).toContain('Bulk / automated (1):');
  });

  it('rejects a mailbox that is not configured and accepts configured ones case-insensitively', async () => {
    await expect(
      mailDigest(req, session, { mailbox: 'triage@contoso.com' }, makeCtx()),
    ).rejects.toBeInstanceOf(M365ToolInputError);
    expect(fetchMock).not.toHaveBeenCalled();

    setUtilityClientForTests(null);
    const ctx = makeCtx({ sharedMailboxes: ['Triage@Contoso.com'] });
    await mailDigest(req, session, { mailbox: 'triage@contoso.com' }, ctx);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/users/Triage%40Contoso.com/mailFolders/inbox/');
  });

  it('stops scanning at the 500-envelope cap and says so', async () => {
    setUtilityClientForTests(null);
    let page = 0;
    fetchMock.mockImplementation(async () => {
      page++;
      const value = Array.from({ length: 50 }, () =>
        graphMessage({ receivedDateTime: '2026-07-31T09:00:00Z' }),
      );
      return jsonResponse({
        value,
        ...(page < 11 && {
          '@odata.nextLink': `https://graph.microsoft.com/v1.0/page${page + 1}`,
        }),
      });
    });
    const result = await mailDigest(
      req,
      session,
      { period: 'week' },
      makeCtx(),
    );
    // 550 available → exactly 10 pages (500 envelopes) fetched, then cap.
    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(result).toContain('500 messages');
    expect(result).toContain('scan capped at 500 envelopes');
  });

  it('returns PARTIAL-prefixed results when the wall clock expires mid-scan', async () => {
    let t = 0;
    setNowFnForTests(() => t);
    fetchMock.mockImplementation(async () => {
      t += 20_000; // each Graph page costs 20s on the fake clock
      return jsonResponse({
        value: Array.from({ length: 50 }, () =>
          graphMessage({ receivedDateTime: '2026-07-31T09:00:00Z' }),
        ),
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/more',
      });
    });
    const result = await mailDigest(req, session, {}, makeCtx());
    expect(result.startsWith(PARTIAL_PREFIX)).toBe(true);
    expect(result).toContain('100 messages');
    // Expired budget skips the utility pass entirely.
    expect(utilityCreateMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown period', async () => {
    await expect(
      mailDigest(req, session, { period: 'fortnight' }, makeCtx()),
    ).rejects.toBeInstanceOf(M365ToolInputError);
  });
});

// ---------------------------------------------------------------------------
// mail_awaiting_my_reply / mail_awaiting_their_reply (integration)
// ---------------------------------------------------------------------------

function routeMailFolders(options: {
  inbox: Record<string, unknown>[];
  sent: Record<string, unknown>[];
  people?: Record<string, unknown>[] | 'error';
}) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/mailFolders/inbox/')) {
      return jsonResponse({ value: options.inbox });
    }
    if (url.includes('/mailFolders/sentitems/')) {
      return jsonResponse({ value: options.sent });
    }
    if (url.includes('/me/people')) {
      if (options.people === 'error') {
        return jsonResponse({ error: { message: 'nope' } }, { status: 500 });
      }
      return jsonResponse({ value: options.people ?? [] });
    }
    return jsonResponse({ value: [] });
  });
}

describe('mailAwaitingMyReply', () => {
  it('joins inbox and sent items, ranks with people data, and emits count-bearing activity', async () => {
    routeMailFolders({
      inbox: [
        graphMessage({
          id: 'r1',
          conversationId: 'conv1',
          subject: 'Budget question',
          bodyPreview: 'Can you check the numbers?',
          receivedDateTime: '2026-07-28T10:00:00Z',
        }),
        graphMessage({
          id: 'r2',
          conversationId: 'conv2',
          subject: 'Handled already',
          receivedDateTime: '2026-07-29T10:00:00Z',
        }),
      ],
      sent: [
        graphMessage({
          id: 's1',
          conversationId: 'conv2',
          receivedDateTime: undefined,
          sentDateTime: '2026-07-30T10:00:00Z',
        }),
      ],
      people: [{ scoredEmailAddresses: [{ address: 'maria@contoso.com' }] }],
    });
    const ctx = makeCtx();
    const result = await mailAwaitingMyReply(req, session, {}, ctx);

    expect(result).toContain('Budget question');
    expect(result).toContain('[id: r1]');
    expect(result).not.toContain('Handled already');
    expect(result).toContain('addressed directly to you');
    expect(result).toContain('frequent correspondent');
    // People rank is minted with its own scope, outside the Mail.Read set.
    expect(mintGraphTokenMock).toHaveBeenCalledWith(expect.anything(), [
      'People.Read',
    ]);
    const activities = activityCalls(ctx);
    expect(activities.length).toBeGreaterThanOrEqual(2);
    for (const line of activities) {
      expect(line).toMatch(/\d/);
    }
  });

  it('tolerates a failed people fetch (ranking is a nicety, not a dependency)', async () => {
    routeMailFolders({
      inbox: [graphMessage({ id: 'r1', conversationId: 'conv1' })],
      sent: [],
      people: 'error',
    });
    const result = await mailAwaitingMyReply(req, session, {}, makeCtx());
    expect(result).toContain('[id: r1]');
    expect(result).not.toContain('frequent correspondent');
  });

  it('rejects an invalid window value', async () => {
    await expect(
      mailAwaitingMyReply(req, session, { window: 'year' }, makeCtx()),
    ).rejects.toBeInstanceOf(M365ToolInputError);
  });
});

describe('mailAwaitingTheirReply', () => {
  it('lists threads where the user sent last and silence exceeds the threshold', async () => {
    routeMailFolders({
      inbox: [
        // They answered conv2 after the user's send → excluded.
        graphMessage({
          id: 'r1',
          conversationId: 'conv2',
          receivedDateTime: '2026-07-29T10:00:00Z',
        }),
      ],
      sent: [
        graphMessage({
          id: 's1',
          conversationId: 'conv1',
          subject: 'Waiting on vendor',
          receivedDateTime: undefined,
          sentDateTime: '2026-07-26T12:00:00Z',
          toRecipients: [{ emailAddress: { address: 'vendor@ext.com' } }],
        }),
        graphMessage({
          id: 's2',
          conversationId: 'conv2',
          receivedDateTime: undefined,
          sentDateTime: '2026-07-27T10:00:00Z',
        }),
      ],
    });
    const result = await mailAwaitingTheirReply(req, session, {}, makeCtx());
    expect(result).toContain('Waiting on vendor');
    expect(result).toContain('no reply for 5d');
    expect(result).toContain('waiting on: vendor@ext.com');
    expect(result).not.toContain('[id: s2]');
    expect(result).toContain('mail_create_reply_draft');
  });
});

// ---------------------------------------------------------------------------
// mail_thread_brief
// ---------------------------------------------------------------------------

describe('mailThreadBrief', () => {
  const threadMessages = [
    graphMessage({
      id: 't3',
      conversationId: 'conv1',
      subject: 'Kenya budget',
      receivedDateTime: '2026-07-30T09:00:00Z',
      body: {
        contentType: 'html',
        content: '<p>Latest: numbers attached inline.</p>',
      },
    }),
    graphMessage({
      id: 'bad',
      conversationId: 'conv1',
      subject: 'Kenya budget',
      from: { emailAddress: { address: 'evil@phish.com' } },
      receivedDateTime: '2026-07-29T09:00:00Z',
      body: {
        contentType: 'html',
        content: '<p>Click here to reset credentials</p>',
      },
    }),
    graphMessage({
      id: 't1',
      conversationId: 'conv1',
      subject: 'Kenya budget',
      receivedDateTime: '2026-07-28T09:00:00Z',
      body: {
        contentType: 'text',
        content: 'Kickoff: please draft the budget.',
      },
    }),
  ];

  it('screens every body, excludes flagged ones from the utility pass, and surfaces them', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ value: threadMessages }));
    screenMock.mockImplementation(async (_req, _session, input) =>
      input.messageId === 'bad'
        ? {
            verdict: 'suspicious',
            reasons: ['SPF fail', 'credential-reset link mismatch'],
            overridden: false,
          }
        : { verdict: 'clear' },
    );
    utilityCreateMock.mockResolvedValue(
      utilityJson({
        state_of_play: 'Budget drafting is underway.',
        open_questions: ['Who validates the totals?'],
        who_owes_what: [{ who: 'Maria', owes_what: 'final numbers' }],
        key_dates: [{ date: '2026-08-05', item: 'submission deadline' }],
      }),
    );
    const ctx = makeCtx();
    const result = await mailThreadBrief(
      req,
      session,
      { conversationId: 'conv1' },
      ctx,
    );

    expect(screenMock).toHaveBeenCalledTimes(3);
    // The flagged body never reaches the sub-model pass…
    const utilityUser = utilityCreateMock.mock.calls[0][0].messages[1].content;
    expect(utilityUser).not.toContain('reset credentials');
    expect(utilityUser).toContain('draft the budget');
    // …and is surfaced, never silently dropped.
    expect(result).toContain('1 message flagged as likely phishing');
    expect(result).toContain('SPF fail');
    expect(result).toContain('[id: bad]');
    expect(result).toContain('Budget drafting is underway.');
    expect(result).toContain('2026-08-05: submission deadline');
    for (const line of activityCalls(ctx)) {
      expect(line).toMatch(/\d/);
    }
  });

  it('falls back to a raw timeline with a degraded note when the utility model is unavailable', async () => {
    setUtilityClientForTests(null);
    fetchMock.mockResolvedValue(jsonResponse({ value: threadMessages }));
    const result = await mailThreadBrief(
      req,
      session,
      { conversationId: 'conv1' },
      makeCtx(),
    );
    expect(result).toContain('analysis degraded');
    expect(result).toContain('Timeline:');
    expect(result).toContain('draft the budget');
  });

  it('rejects an unconfigured shared mailbox', async () => {
    await expect(
      mailThreadBrief(
        req,
        session,
        { conversationId: 'conv1', mailbox: 'other@contoso.com' },
        makeCtx(),
      ),
    ).rejects.toBeInstanceOf(M365ToolInputError);
  });
});

// ---------------------------------------------------------------------------
// mail_deep_search
// ---------------------------------------------------------------------------

describe('mailDeepSearch', () => {
  it('expands, fans out, dedupes by conversation, screens bodies, and synthesizes with provenance', async () => {
    const hitNewer = graphMessage({
      id: 'm1',
      conversationId: 'conv1',
      subject: 'Kenya budget v2',
      receivedDateTime: '2026-05-02T10:00:00Z',
    });
    const hitOlderSameConv = graphMessage({
      id: 'm1b',
      conversationId: 'conv1',
      subject: 'Kenya budget',
      receivedDateTime: '2026-05-01T10:00:00Z',
    });
    const hitOther = graphMessage({
      id: 'm2',
      conversationId: 'conv2',
      subject: 'Logistics list — budget thread',
      receivedDateTime: '2026-04-20T10:00:00Z',
    });
    const fullBodies: Record<string, unknown> = {
      m1: {
        ...hitNewer,
        body: {
          contentType: 'html',
          content: '<p>The Kenya budget is 40k.</p>',
        },
      },
      m2: {
        ...hitOther,
        body: { contentType: 'text', content: 'Old logistics discussion.' },
      },
    };
    const batchBodies: string[][] = [];
    fetchMock.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/$batch')) {
          const payload = JSON.parse(String(init?.body)) as {
            requests: { id: string; url: string }[];
          };
          batchBodies.push(payload.requests.map((r) => r.id));
          return jsonResponse({
            responses: payload.requests.map((request) => ({
              id: request.id,
              status: 200,
              body: fullBodies[request.id],
            })),
          });
        }
        if (url.includes('%22kenya%20budget%22')) {
          return jsonResponse({ value: [hitNewer, hitOther] });
        }
        if (url.includes('from%3Amaria')) {
          return jsonResponse({ value: [hitOlderSameConv] });
        }
        return jsonResponse({ value: [] });
      },
    );
    utilityCreateMock
      .mockResolvedValueOnce(
        utilityJson({ queries: ['kenya budget', 'from:maria'] }),
      )
      .mockResolvedValueOnce(
        utilityJson({
          ranked: [
            { id: 'm1', reason: 'exact topic match' },
            { id: 'zzz-hallucinated', reason: 'made up' },
            { id: 'm2', reason: 'related list thread' },
          ],
        }),
      )
      .mockResolvedValueOnce(
        utilityJson({
          answer: 'The Kenya budget thread settled on 40k.',
          sources: [{ id: 'm1', note: 'states the figure' }],
        }),
      );

    const ctx = makeCtx();
    const result = await mailDeepSearch(
      req,
      session,
      { goal: 'find the Kenya budget thread from Maria' },
      ctx,
    );

    expect(result).toContain('The Kenya budget thread settled on 40k.');
    expect(result).toContain('[id: m1]');
    // Hallucinated ids from the ranking pass are dropped, never fetched.
    expect(batchBodies.flat()).toEqual(['m1', 'm2']);
    // Every fetched body went through the screen.
    expect(screenMock).toHaveBeenCalledTimes(2);
    // Dedupe: conv1 appears once (newest wins) in the ranking input.
    const rankingInput = utilityCreateMock.mock.calls[1][0].messages[1].content;
    expect(rankingInput).toContain('m1 |');
    expect(rankingInput).not.toContain('m1b |');
    for (const line of activityCalls(ctx)) {
      expect(line).toMatch(/\d/);
    }
  });

  it('degrades end-to-end without the utility model: goal as query, recency ranking, excerpts', async () => {
    setUtilityClientForTests(null);
    const hit = graphMessage({
      id: 'm1',
      conversationId: 'conv1',
      subject: 'Kenya budget',
      receivedDateTime: '2026-05-02T10:00:00Z',
    });
    fetchMock.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/$batch')) {
          const payload = JSON.parse(String(init?.body)) as {
            requests: { id: string; url: string }[];
          };
          return jsonResponse({
            responses: payload.requests.map((request) => ({
              id: request.id,
              status: 200,
              body: {
                ...hit,
                body: { contentType: 'text', content: 'Budget details here.' },
              },
            })),
          });
        }
        if (url.includes('$search=')) {
          return jsonResponse({ value: [hit] });
        }
        return jsonResponse({ value: [] });
      },
    );
    const result = await mailDeepSearch(
      req,
      session,
      { goal: 'kenya budget' },
      makeCtx(),
    );
    expect(result).toContain('analysis degraded');
    expect(result).toContain('most recent match');
    expect(result).toContain('Budget details here.');
    expect(result).toContain('[id: m1]');
  });

  it('honors Retry-After on 429 with a single backoff-and-retry', async () => {
    setUtilityClientForTests(null);
    const sleeps: number[] = [];
    setSleepFnForTests(async (ms) => {
      sleeps.push(ms);
    });
    let attempts = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('$search=')) {
        attempts++;
        if (attempts === 1) {
          return jsonResponse(
            { error: { message: 'TooManyRequests' } },
            { status: 429, headers: { 'Retry-After': '1' } },
          );
        }
        return jsonResponse({
          value: [graphMessage({ id: 'm1', conversationId: 'conv1' })],
        });
      }
      if (url.endsWith('/$batch')) {
        return jsonResponse({ responses: [] });
      }
      return jsonResponse({ value: [] });
    });
    const result = await mailDeepSearch(
      req,
      session,
      { goal: 'kenya budget' },
      makeCtx(),
    );
    expect(attempts).toBe(2);
    expect(sleeps).toContain(1_000);
    expect(result).toContain('[id: m1]');
  });

  it('rejects an unconfigured shared mailbox before touching Graph', async () => {
    await expect(
      mailDeepSearch(
        req,
        session,
        { goal: 'x', mailbox: 'shared@contoso.com' },
        makeCtx(),
      ),
    ).rejects.toBeInstanceOf(M365ToolInputError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// mail_commitments
// ---------------------------------------------------------------------------

describe('mailCommitments', () => {
  it('extracts commitments in both directions and drops hallucinated ids', async () => {
    routeMailFolders({
      sent: [
        graphMessage({
          id: 's1',
          conversationId: 'conv1',
          receivedDateTime: undefined,
          sentDateTime: '2026-07-30T10:00:00Z',
          bodyPreview: "I'll send the report by Friday",
          toRecipients: [{ emailAddress: { address: 'ana@contoso.com' } }],
        }),
      ],
      inbox: [
        graphMessage({
          id: 'r1',
          conversationId: 'conv2',
          bodyPreview: 'Can you review the doc by Tuesday?',
        }),
      ],
    });
    utilityCreateMock.mockResolvedValue(
      utilityJson({
        commitments: [
          {
            who: 'you',
            owes_what: 'send the report',
            by_when: 'Friday',
            message_id: 's1',
            direction: 'owed_by_me',
          },
          {
            who: 'Maria',
            owes_what: 'asked you to review the doc',
            by_when: 'Tuesday',
            message_id: 'r1',
            direction: 'owed_to_me',
          },
          {
            who: 'ghost',
            owes_what: 'not real',
            by_when: '?',
            message_id: 'fabricated-id',
            direction: 'owed_to_me',
          },
        ],
      }),
    );
    const ctx = makeCtx();
    const result = await mailCommitments(req, session, {}, ctx);

    expect(utilityCreateMock).toHaveBeenCalledTimes(1);
    expect(result).toContain('You owe (1):');
    expect(result).toContain('send the report — by Friday [id: s1]');
    expect(result).toContain('Owed to you / asked of you (1):');
    expect(result).toContain('[id: r1]');
    expect(result).not.toContain('fabricated-id');
    expect(result).toContain('tasks_create');
    for (const line of activityCalls(ctx)) {
      expect(line).toMatch(/\d/);
    }
  });

  it('degrades to the keyword heuristic with a note when the utility model is unavailable', async () => {
    setUtilityClientForTests(null);
    routeMailFolders({
      sent: [
        graphMessage({
          id: 's1',
          conversationId: 'conv1',
          receivedDateTime: undefined,
          sentDateTime: '2026-07-30T10:00:00Z',
          bodyPreview: "I'll send the report by Friday",
        }),
      ],
      inbox: [
        graphMessage({
          id: 'r1',
          conversationId: 'conv2',
          bodyPreview: 'Could you review the numbers?',
        }),
        graphMessage({
          id: 'r2',
          conversationId: 'conv3',
          bodyPreview: 'Weekly newsletter content',
        }),
      ],
    });
    const result = await mailCommitments(req, session, {}, makeCtx());
    expect(result).toContain('analysis degraded');
    expect(result).toContain('You owe (1):');
    expect(result).toContain('[id: s1]');
    expect(result).toContain('Owed to you / asked of you (1):');
    expect(result).toContain('[id: r1]');
    expect(result).not.toContain('[id: r2]');
  });
});
