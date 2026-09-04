/**
 * Server-side artifact probe for the filtered meeting listing.
 *
 * The probe exists to answer one question honestly — "does this meeting have
 * anything attachable?" — so the cases below pin the distinctions that make
 * the answer trustworthy: a 403 is not an empty result, half an answer is not
 * proof of nothing, and anything the probe never reached (cap, wall clock,
 * throttle) is 'unprobed' rather than hidden.
 *
 * Graph is mocked at getGraphAccessToken (the real mintGraphToken runs, so
 * the consent throw is exercised for real) plus raw global fetch, because the
 * fan-out deliberately bypasses graphFetch to mint exactly one token.
 */
import { NextRequest } from 'next/server';

import { GRAPH_V1 } from '@/lib/services/m365/graphApi';
import {
  MAX_ARTIFACT_PROBES,
  PROBE_BUDGET_MS,
  PROBE_CONCURRENCY,
  probeMeetingArtifacts,
  setNowFnForTests,
} from '@/lib/services/m365/meetingArtifacts';

import type { M365MeetingEntry } from '@/types/m365';

import { getGraphAccessToken } from '@/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({ getGraphAccessToken: vi.fn() }));

const req = new NextRequest('http://localhost/api/m365/meetings');

const fetchMock = vi.fn();

function jsonResponse(
  payload: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

function errorResponse(status: number, message = 'nope'): Response {
  return jsonResponse({ error: { message } }, { status });
}

/** A calendarView-shaped candidate keyed by a short join-URL slug. */
function candidate(
  key: string,
  overrides: Partial<M365MeetingEntry> = {},
): M365MeetingEntry {
  return {
    eventId: `evt-${key}`,
    subject: `Meeting ${key}`,
    joinWebUrl: `https://teams.microsoft.com/l/meetup-join/${key}`,
    start: '2026-07-31T09:00:00Z',
    end: '2026-07-31T10:00:00Z',
    ...overrides,
  };
}

function onlineMeeting(key: string, organizer?: Record<string, unknown>) {
  return {
    value: [
      {
        id: `om-${key}`,
        ...(organizer ? { participants: { organizer } } : {}),
      },
    ],
  };
}

interface Legs {
  resolve?: () => Response;
  transcripts?: () => Response;
  recordings?: () => Response;
}

/**
 * Routes a probe fetch to a per-meeting fixture. Unrouted meetings resolve to
 * an empty match, which is the cheapest "nothing here" the probe understands.
 */
function routeByKey(map: Record<string, Legs>) {
  return async (input: unknown): Promise<Response> => {
    const url = String(input);
    const leg =
      /onlineMeetings\/om-([A-Za-z0-9]+)\/(transcripts|recordings)/.exec(url);
    if (leg) {
      const [, key, kind] = leg;
      const handler = map[key]?.[kind as 'transcripts' | 'recordings'];
      return handler ? handler() : jsonResponse({ value: [] });
    }
    const resolve = /meetup-join%2F([A-Za-z0-9]+)/.exec(url);
    const key = resolve?.[1] ?? '';
    const handler = map[key]?.resolve;
    return handler ? handler() : jsonResponse({ value: [] });
  };
}

/** Drains microtasks and a few macrotask turns without touching the clock. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function statusOf(
  result: Awaited<ReturnType<typeof probeMeetingArtifacts>>,
  key: string,
) {
  return result.outcomes.find((o) => o.eventId === `evt-${key}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(getGraphAccessToken).mockResolvedValue({
    accessToken: 'tok',
    grantedScopes: [],
  });
  fetchMock.mockImplementation(routeByKey({}));
});

afterEach(() => {
  vi.unstubAllGlobals();
  setNowFnForTests(null);
});

// ---------------------------------------------------------------------------
// Token economy
// ---------------------------------------------------------------------------

describe('token minting', () => {
  it('mints exactly one token for the whole fan-out', async () => {
    const candidates = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'].map((k) =>
      candidate(k),
    );

    const result = await probeMeetingArtifacts(req, candidates);

    expect(getGraphAccessToken).toHaveBeenCalledTimes(1);
    expect(result.outcomes).toHaveLength(6);
    // One resolve per candidate, and no token call in between.
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('sends the minted token as a bearer on every probe fetch', async () => {
    fetchMock.mockImplementation(
      routeByKey({
        k1: {
          resolve: () => jsonResponse(onlineMeeting('k1')),
          transcripts: () => jsonResponse({ value: [{ id: 't1' }] }),
        },
      }),
    );

    await probeMeetingArtifacts(req, [candidate('k1')]);

    for (const call of fetchMock.mock.calls) {
      expect(
        (call[1] as RequestInit & { headers: Record<string, string> }).headers
          .Authorization,
      ).toBe('Bearer tok');
    }
  });

  it('does not mint or fetch at all for an empty candidate list', async () => {
    const result = await probeMeetingArtifacts(req, []);

    expect(result).toEqual({
      outcomes: [],
      budgetExhausted: false,
      throttled: false,
    });
    expect(getGraphAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws (rather than returning outcomes) when consent is missing', async () => {
    vi.mocked(getGraphAccessToken).mockResolvedValue({
      accessToken: null,
      grantedScopes: [],
      error: 'AADSTS65001: The user or administrator has not consented…',
    });

    await expect(
      probeMeetingArtifacts(req, [candidate('k1'), candidate('k2')]),
    ).rejects.toMatchObject({ kind: 'consent_missing', status: 403 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe('artifact classification', () => {
  it('reports available with resources mapped from both legs', async () => {
    fetchMock.mockImplementation(
      routeByKey({
        k1: {
          resolve: () =>
            jsonResponse(
              onlineMeeting('k1', {
                upn: 'ada@contoso.com',
                identity: { user: { displayName: 'Ada Lovelace' } },
              }),
            ),
          transcripts: () =>
            jsonResponse({
              value: [
                { id: 't1', createdDateTime: '2026-07-31T10:05:00Z' },
                // No id — not addressable, so it is not an artifact.
                { createdDateTime: '2026-07-31T10:06:00Z' },
              ],
            }),
          recordings: () => jsonResponse({ value: [] }),
        },
      }),
    );

    const result = await probeMeetingArtifacts(req, [candidate('k1')]);

    expect(result.outcomes).toEqual([
      {
        eventId: 'evt-k1',
        status: 'available',
        resources: {
          meetingId: 'om-k1',
          organizer: 'Ada Lovelace',
          transcripts: [{ id: 't1', created: '2026-07-31T10:05:00Z' }],
          recordings: [],
        },
      },
    ]);
    expect(result.budgetExhausted).toBe(false);
    expect(result.throttled).toBe(false);
  });

  it('falls back to the organizer upn when no display name is present', async () => {
    fetchMock.mockImplementation(
      routeByKey({
        k1: {
          resolve: () =>
            jsonResponse(onlineMeeting('k1', { upn: 'grace@contoso.com' })),
          recordings: () =>
            jsonResponse({
              value: [{ id: 'r1', createdDateTime: '2026-07-31T10:07:00Z' }],
            }),
        },
      }),
    );

    const result = await probeMeetingArtifacts(req, [candidate('k1')]);

    expect(statusOf(result, 'k1')?.resources).toEqual({
      meetingId: 'om-k1',
      organizer: 'grace@contoso.com',
      transcripts: [],
      recordings: [{ id: 'r1', created: '2026-07-31T10:07:00Z' }],
    });
  });

  it('reports none when both artifact listings come back empty', async () => {
    fetchMock.mockImplementation(
      routeByKey({
        k1: {
          resolve: () => jsonResponse(onlineMeeting('k1')),
          transcripts: () => jsonResponse({ value: [] }),
          recordings: () => jsonResponse({ value: [] }),
        },
      }),
    );

    const result = await probeMeetingArtifacts(req, [candidate('k1')]);

    expect(statusOf(result, 'k1')).toEqual({
      eventId: 'evt-k1',
      status: 'none',
    });
  });

  it('reports unresolved when the join URL matches no online meeting', async () => {
    // Delegated /me/onlineMeetings answers for meetings the user organized,
    // so this is the ordinary shape for one they merely attended — and it
    // is distinct from 'none', which can still be waiting on Teams.
    fetchMock.mockImplementation(
      routeByKey({ k1: { resolve: () => jsonResponse({ value: [] }) } }),
    );

    const result = await probeMeetingArtifacts(req, [candidate('k1')]);

    expect(statusOf(result, 'k1')?.status).toBe('unresolved');
    // Nothing to list once the resolve came back empty.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports unprobed — not none — when the resolve 404s', async () => {
    // Only a clean answer may hide a meeting. A 404 is an error, and
    // inferring "nothing attached" from one would hide a row with no
    // counter and nothing for "Show all" to explain.
    fetchMock.mockImplementation(
      routeByKey({ k1: { resolve: () => errorResponse(404) } }),
    );

    const result = await probeMeetingArtifacts(req, [candidate('k1')]);

    expect(statusOf(result, 'k1')?.status).toBe('unprobed');
  });

  it('reports forbidden — never none — when the transcripts listing 403s', async () => {
    // The bug this feature fixes: the lazy resolve path collapsed a 403 into
    // an empty artifact array, which would hide a meeting the user can see.
    fetchMock.mockImplementation(
      routeByKey({
        k1: {
          resolve: () => jsonResponse(onlineMeeting('k1')),
          transcripts: () => errorResponse(403),
          recordings: () => jsonResponse({ value: [] }),
        },
      }),
    );

    const result = await probeMeetingArtifacts(req, [candidate('k1')]);

    expect(statusOf(result, 'k1')).toEqual({
      eventId: 'evt-k1',
      status: 'forbidden',
    });
    expect(statusOf(result, 'k1')?.status).not.toBe('none');
  });

  it('reports forbidden when the join URL resolve itself 403s', async () => {
    fetchMock.mockImplementation(
      routeByKey({ k1: { resolve: () => errorResponse(403) } }),
    );

    const result = await probeMeetingArtifacts(req, [candidate('k1')]);

    expect(statusOf(result, 'k1')?.status).toBe('forbidden');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a partial result when one leg fails and the other finds artifacts', async () => {
    fetchMock.mockImplementation(
      routeByKey({
        k1: {
          resolve: () => jsonResponse(onlineMeeting('k1')),
          transcripts: () => errorResponse(500, 'transient'),
          recordings: () =>
            jsonResponse({
              value: [{ id: 'r1', createdDateTime: '2026-07-31T10:07:00Z' }],
            }),
        },
      }),
    );

    const result = await probeMeetingArtifacts(req, [candidate('k1')]);

    expect(statusOf(result, 'k1')).toEqual({
      eventId: 'evt-k1',
      status: 'available',
      partial: true,
      resources: {
        meetingId: 'om-k1',
        organizer: undefined,
        // Only the leg that answered is represented.
        transcripts: [],
        recordings: [{ id: 'r1', created: '2026-07-31T10:07:00Z' }],
      },
    });
  });

  it('reports unprobed when both artifact legs fail transiently', async () => {
    fetchMock.mockImplementation(
      routeByKey({
        k1: {
          resolve: () => jsonResponse(onlineMeeting('k1')),
          transcripts: () => errorResponse(500),
          recordings: () => errorResponse(503),
        },
      }),
    );

    const result = await probeMeetingArtifacts(req, [candidate('k1')]);

    expect(statusOf(result, 'k1')).toEqual({
      eventId: 'evt-k1',
      status: 'unprobed',
    });
  });

  it('reports unprobed — not none — when one leg fails and the other is empty', async () => {
    // Half the answer and nothing found is not proof of nothing.
    fetchMock.mockImplementation(
      routeByKey({
        k1: {
          resolve: () => jsonResponse(onlineMeeting('k1')),
          transcripts: () => errorResponse(500),
          recordings: () => jsonResponse({ value: [] }),
        },
      }),
    );

    const result = await probeMeetingArtifacts(req, [candidate('k1')]);

    expect(statusOf(result, 'k1')?.status).toBe('unprobed');
    expect(statusOf(result, 'k1')?.status).not.toBe('none');
  });
});

// ---------------------------------------------------------------------------
// OData shaping
// ---------------------------------------------------------------------------

describe('join URL filter', () => {
  it('doubles single quotes and percent-encodes the literal', async () => {
    const joinWebUrl = "https://teams.microsoft.com/l/meetup-join/it's/19:a b";

    await probeMeetingArtifacts(req, [candidate('k1', { joinWebUrl })]);

    const url = String(fetchMock.mock.calls[0][0]);
    const encoded = encodeURIComponent(
      "https://teams.microsoft.com/l/meetup-join/it''s/19:a b",
    );
    expect(url).toBe(
      `${GRAPH_V1}/me/onlineMeetings?$filter=JoinWebUrl%20eq%20'${encoded}'`,
    );
    // The doubled quote survives encoding; the spaces and slashes do not.
    expect(url).toContain("it''s");
    expect(url).toContain('%20');
    expect(url).not.toContain('meetup-join/it');
  });
});

// ---------------------------------------------------------------------------
// Budget, cap, throttling, concurrency
// ---------------------------------------------------------------------------

describe('probe budget', () => {
  it('never probes past MAX_ARTIFACT_PROBES and marks the excess unprobed', async () => {
    const candidates = Array.from({ length: MAX_ARTIFACT_PROBES + 3 }, (_, i) =>
      candidate(`k${i}`),
    );

    const result = await probeMeetingArtifacts(req, candidates);

    expect(result.outcomes).toHaveLength(MAX_ARTIFACT_PROBES + 3);
    expect(result.budgetExhausted).toBe(true);
    expect(result.throttled).toBe(false);
    // Exactly one resolve per probed candidate; the excess issued nothing.
    expect(fetchMock).toHaveBeenCalledTimes(MAX_ARTIFACT_PROBES);
    for (let i = MAX_ARTIFACT_PROBES; i < candidates.length; i++) {
      expect(statusOf(result, `k${i}`)).toEqual({
        eventId: `evt-k${i}`,
        status: 'unprobed',
      });
    }
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(
      urls.some((url) => url.includes(`meetup-join%2Fk${MAX_ARTIFACT_PROBES}`)),
    ).toBe(false);
  });

  it('stops probing when the wall-clock budget expires mid-fan-out', async () => {
    // The clock is call-counted, not time-based: the startedAt read plus the
    // first PROBE_CONCURRENCY probe checks land inside the budget; every
    // later check is past it.
    let calls = 0;
    setNowFnForTests(() => {
      calls++;
      return calls <= PROBE_CONCURRENCY + 1 ? 0 : PROBE_BUDGET_MS;
    });
    const keys = Array.from(
      { length: PROBE_CONCURRENCY + 2 },
      (_, i) => `k${i}`,
    );

    const result = await probeMeetingArtifacts(
      req,
      keys.map((k) => candidate(k)),
    );

    expect(result.budgetExhausted).toBe(true);
    expect(result.throttled).toBe(false);
    for (let i = 0; i < PROBE_CONCURRENCY; i++) {
      expect(statusOf(result, `k${i}`)?.status).toBe('unresolved');
    }
    for (let i = PROBE_CONCURRENCY; i < keys.length; i++) {
      expect(statusOf(result, `k${i}`)?.status).toBe('unprobed');
    }
    expect(fetchMock).toHaveBeenCalledTimes(PROBE_CONCURRENCY);
  });

  it('short-circuits the remaining candidates once Graph throttles', async () => {
    const deferred: Array<{ url: string; resolve: (r: Response) => void }> = [];
    fetchMock.mockImplementation(
      async (input: unknown) =>
        new Promise<Response>((resolve) => {
          deferred.push({ url: String(input), resolve });
        }),
    );
    const keys = Array.from(
      { length: PROBE_CONCURRENCY + 4 },
      (_, i) => `k${i}`,
    );

    const pending = probeMeetingArtifacts(
      req,
      keys.map((k) => candidate(k)),
    );
    await flush();
    // The limiter admitted exactly one window of probes.
    expect(fetchMock).toHaveBeenCalledTimes(PROBE_CONCURRENCY);

    deferred[0].resolve(errorResponse(429, 'throttled'));
    await flush();
    // The freed slot did not start a new probe.
    expect(fetchMock).toHaveBeenCalledTimes(PROBE_CONCURRENCY);

    for (const entry of deferred.slice(1)) {
      entry.resolve(jsonResponse({ value: [] }));
    }
    const result = await pending;

    expect(result.throttled).toBe(true);
    // Throttling is not a budget overrun: the two flags drive different
    // copy in the modal footer and must stay distinguishable.
    expect(result.budgetExhausted).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(PROBE_CONCURRENCY);
    expect(statusOf(result, 'k0')?.status).toBe('unprobed');
    for (let i = PROBE_CONCURRENCY; i < keys.length; i++) {
      expect(statusOf(result, `k${i}`)?.status).toBe('unprobed');
    }
    // Nothing was hidden on the strength of a throttled fan-out: the
    // probes already in flight answered for themselves.
    expect(
      result.outcomes.filter((o) => o.status === 'unresolved'),
    ).toHaveLength(PROBE_CONCURRENCY - 1);
    expect(result.outcomes.filter((o) => o.status === 'none')).toHaveLength(0);
  });

  it('reports unprobed and throttled when an artifact leg returns 429', async () => {
    fetchMock.mockImplementation(
      routeByKey({
        k1: {
          resolve: () => jsonResponse(onlineMeeting('k1')),
          transcripts: () => errorResponse(429, 'throttled'),
          recordings: () => jsonResponse({ value: [] }),
        },
      }),
    );

    const result = await probeMeetingArtifacts(req, [candidate('k1')]);

    expect(statusOf(result, 'k1')?.status).toBe('unprobed');
    expect(result.throttled).toBe(true);
    expect(result.budgetExhausted).toBe(false);
  });

  it('admits at most PROBE_CONCURRENCY probes at a time', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const pendingResolvers: Array<() => void> = [];
    fetchMock.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<Response>((resolve) => {
        pendingResolvers.push(() => {
          inFlight--;
          resolve(jsonResponse({ value: [] }));
        });
      });
    });

    const pending = probeMeetingArtifacts(
      req,
      Array.from({ length: 12 }, (_, i) => candidate(`k${i}`)),
    );
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(PROBE_CONCURRENCY);

    while (pendingResolvers.length > 0) {
      pendingResolvers.shift()!();
      await flush();
    }
    const result = await pending;

    expect(result.outcomes).toHaveLength(12);
    expect(maxInFlight).toBe(PROBE_CONCURRENCY);
    expect(maxInFlight).toBeLessThanOrEqual(PROBE_CONCURRENCY);
    expect(fetchMock).toHaveBeenCalledTimes(12);
  });

  it('fans the two artifact legs out inside a probe slot (2x Graph calls)', async () => {
    // PROBE_CONCURRENCY bounds PROBES, not Graph calls: the transcripts and
    // recordings listings run under Promise.all inside one admitted slot, so
    // the real ceiling on simultaneous Graph requests is twice the limit.
    // Pinned deliberately — it is what a throttling budget has to assume.
    let inFlight = 0;
    let maxInFlight = 0;
    const pendingResolvers: Array<() => void> = [];
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<Response>((resolve) => {
        pendingResolvers.push(() => {
          inFlight--;
          const key = /meetup-join%2F([A-Za-z0-9]+)/.exec(url)?.[1];
          resolve(
            key
              ? jsonResponse(onlineMeeting(key))
              : jsonResponse({ value: [] }),
          );
        });
      });
    });

    const pending = probeMeetingArtifacts(
      req,
      Array.from({ length: 12 }, (_, i) => candidate(`k${i}`)),
    );
    await flush();
    while (pendingResolvers.length > 0) {
      // Release the whole outstanding batch so both legs overlap.
      const batch = pendingResolvers.splice(0, pendingResolvers.length);
      for (const release of batch) release();
      await flush();
    }
    const result = await pending;

    expect(result.outcomes.every((o) => o.status === 'none')).toBe(true);
    expect(maxInFlight).toBe(PROBE_CONCURRENCY * 2);
  });
});

// ---------------------------------------------------------------------------
// Half an answer: a failing leg must not erase what its sibling found
// ---------------------------------------------------------------------------

describe('surviving artifact legs', () => {
  it('keeps a found transcript when the recordings listing 403s', async () => {
    // A denial on one leg used to decide the whole probe: the meeting came
    // back 'forbidden' and the transcript the other leg had already read was
    // thrown away, so a row with a proven, importable transcript rendered as
    // "no access" instead of offering it.
    fetchMock.mockImplementation(
      routeByKey({
        k1: {
          resolve: () => jsonResponse(onlineMeeting('k1')),
          transcripts: () => jsonResponse({ value: [{ id: 't1' }] }),
          recordings: () => errorResponse(403),
        },
      }),
    );

    const result = await probeMeetingArtifacts(req, [candidate('k1')]);

    const outcome = statusOf(result, 'k1');
    expect(outcome?.status).toBe('available');
    expect(outcome?.status).not.toBe('forbidden');
    expect(outcome?.partial).toBe(true);
    expect(outcome?.resources?.transcripts).toEqual([
      { id: 't1', created: undefined },
    ]);
    // The denied leg contributes nothing rather than being invented.
    expect(outcome?.resources?.recordings).toEqual([]);
  });

  it('keeps a found transcript, and still reports throttled, when the recordings listing 429s', async () => {
    // A 429 used to demote the probe to 'unprobed', which the route hides —
    // so the fan-out hid a meeting whose transcript it had already listed.
    // The throttle flag still has to survive, because it is what stops the
    // remaining probes and explains the short listing in the footer.
    fetchMock.mockImplementation(
      routeByKey({
        k1: {
          resolve: () => jsonResponse(onlineMeeting('k1')),
          transcripts: () => jsonResponse({ value: [{ id: 't1' }] }),
          recordings: () => errorResponse(429, 'throttled'),
        },
      }),
    );

    const result = await probeMeetingArtifacts(req, [candidate('k1')]);

    const outcome = statusOf(result, 'k1');
    expect(outcome?.status).toBe('available');
    expect(outcome?.status).not.toBe('unprobed');
    expect(outcome?.partial).toBe(true);
    expect(outcome?.resources?.transcripts).toEqual([
      { id: 't1', created: undefined },
    ]);
    expect(result.throttled).toBe(true);
    expect(result.budgetExhausted).toBe(false);
  });

  it('keeps a found recording when the transcripts listing 403s', async () => {
    // Mirror of the first case: neither leg is privileged, so the denial must
    // lose to a real artifact no matter which side answered.
    fetchMock.mockImplementation(
      routeByKey({
        k1: {
          resolve: () => jsonResponse(onlineMeeting('k1')),
          transcripts: () => errorResponse(403),
          recordings: () =>
            jsonResponse({
              value: [{ id: 'r1', createdDateTime: '2026-07-31T10:07:00Z' }],
            }),
        },
      }),
    );

    const result = await probeMeetingArtifacts(req, [candidate('k1')]);

    expect(statusOf(result, 'k1')).toEqual({
      eventId: 'evt-k1',
      status: 'available',
      partial: true,
      resources: {
        meetingId: 'om-k1',
        organizer: undefined,
        transcripts: [],
        recordings: [{ id: 'r1', created: '2026-07-31T10:07:00Z' }],
      },
    });
  });

  it('prefers forbidden over a generic failure when nothing was found', async () => {
    // Nothing to show, so the verdict is only about which failure to report:
    // a denial names something the user can act on (ask the organizer), a
    // 500 names nothing at all.
    fetchMock.mockImplementation(
      routeByKey({
        k1: {
          resolve: () => jsonResponse(onlineMeeting('k1')),
          transcripts: () => errorResponse(500, 'transient'),
          recordings: () => errorResponse(403),
        },
      }),
    );

    const result = await probeMeetingArtifacts(req, [candidate('k1')]);

    expect(statusOf(result, 'k1')).toEqual({
      eventId: 'evt-k1',
      status: 'forbidden',
    });
  });
});

// ---------------------------------------------------------------------------
// 'unresolved' is its own verdict
// ---------------------------------------------------------------------------

describe('unresolved versus none', () => {
  it('separates an unmatched join URL from a meeting with nothing attached', async () => {
    // Both used to come back 'none'. They mean opposite things: k2 ended and
    // may still be processing (the route may badge it 'pending' and wait),
    // while k1 resolves to no addressable online meeting at all — attended,
    // not organized — so there is nothing to wait for and never will be.
    fetchMock.mockImplementation(
      routeByKey({
        k1: { resolve: () => jsonResponse({ value: [] }) },
        k2: {
          resolve: () => jsonResponse(onlineMeeting('k2')),
          transcripts: () => jsonResponse({ value: [] }),
          recordings: () => jsonResponse({ value: [] }),
        },
      }),
    );

    const result = await probeMeetingArtifacts(req, [
      candidate('k1'),
      candidate('k2'),
    ]);

    expect(statusOf(result, 'k1')).toEqual({
      eventId: 'evt-k1',
      status: 'unresolved',
    });
    expect(statusOf(result, 'k2')).toEqual({
      eventId: 'evt-k2',
      status: 'none',
    });
    // Same run, two verdicts: the distinction is real, not a rename.
    expect(statusOf(result, 'k1')?.status).not.toBe(
      statusOf(result, 'k2')?.status,
    );
    // k1 stopped at the resolve; k2 spent all three calls.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
