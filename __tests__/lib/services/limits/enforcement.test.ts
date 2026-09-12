import {
  denialMessage,
  effectiveCeiling,
  meteredCells,
} from '@/lib/services/limits/enforcement';

import { describe, expect, it } from 'vitest';

/**
 * These strings are read by END USERS — the chat error card renders the
 * server's message verbatim for rate-limit codes (ApiError.getUserMessage).
 * So they must never contain an internal limit key, an override id, or the
 * policy layer that produced the cap.
 */
describe('denialMessage', () => {
  it('never leaks the internal limit key', () => {
    const message = denialMessage({
      limitKey: 'chat.messagesPerDay',
      limit: 100,
      used: 100,
      source: 'domain',
      resetAt: '2026-07-26T00:00:00.000Z',
    });
    expect(message).not.toContain('chat.messagesPerDay');
    // No dotted internal identifier anywhere (sentence periods are fine).
    expect(message).not.toMatch(/\b[a-z]+\.[a-zA-Z]+\b/);
    expect(message).toContain('100');
  });

  it('never leaks admin-facing provenance', () => {
    const message = denialMessage({
      limitKey: 'chat.messagesPerDay',
      limit: 5,
      source: 'user',
    });
    for (const leak of ['user', 'domain', 'global', 'override', 'attribute']) {
      expect(message.toLowerCase()).not.toContain(leak);
    }
  });

  it('states the reset time for a windowed limit so the user knows when to return', () => {
    const message = denialMessage({
      limitKey: 'chat.messagesPerDay',
      limit: 100,
      source: 'global',
      resetAt: '2026-07-26T00:00:00.000Z',
    });
    expect(message).toContain('Resets');
    expect(message).toContain('today');
  });

  it('says "this month" for a monthly limit', () => {
    const message = denialMessage({
      limitKey: 'chat.tokensPerMonth',
      limit: 5000,
      source: 'global',
    });
    expect(message).toContain('this month');
  });

  it('does NOT suggest retrying later for a per-request ceiling', () => {
    // Waiting changes nothing when the request itself is too big — telling
    // the user to come back later would be actively misleading.
    const message = denialMessage({
      limitKey: 'feature.tts.charactersPerRequest',
      limit: 5000,
      used: 9000,
      source: 'global',
    });
    expect(message).toContain('per request');
    expect(message).not.toContain('Resets');
  });

  it('explains a blocked model as unavailable, not as a quota', () => {
    const message = denialMessage({
      limitKey: 'model.allowed',
      limit: false,
      source: 'global',
      modelId: 'gpt-5.2',
    });
    expect(message).toContain('not available');
    expect(message).not.toContain('limit of');
  });

  it('explains a blocked feature as turned off by an administrator', () => {
    const message = denialMessage({
      limitKey: 'feature.webSearch.enabled',
      limit: false,
      source: 'domain',
    });
    expect(message).toContain('administrator');
  });

  it('names the unit so a number is not left bare', () => {
    expect(
      denialMessage({
        limitKey: 'feature.transcription.minutesPerDay',
        limit: 60,
        source: 'global',
      }),
    ).toContain('60 minutes');
  });

  it('degrades gracefully for a key with no catalog entry', () => {
    const message = denialMessage({
      limitKey: 'not.a.real.key',
      limit: 3,
      source: 'global',
    });
    expect(message).toContain('3');
    expect(message).not.toContain('not.a.real.key');
  });
});

describe('fail-closed and observe-mode contracts (review 2026-09-12)', () => {
  it('an `unavailable` denial says the counter was unreachable, never "reached"', () => {
    const message = denialMessage({
      limitKey: 'chat.messagesPerDay',
      limit: 10,
      used: 0,
      unavailable: true,
      source: 'global',
    });
    expect(message).toMatch(/temporarily unavailable/);
    expect(message).not.toMatch(/reached/);
  });

  it('effectiveCeiling clamps nothing in observe mode and everything in enforce', () => {
    const principal = { userId: 'oid-1', attributes: [], groupIds: [] };
    const base = {
      version: 1 as const,
      defaults: [
        { limitKey: 'feature.mcp.roundsPerRequest', value: 2, ceiling: false },
      ],
      overrides: [],
      delegations: [],
      failMode: 'open' as const,
      timezone: 'UTC',
      countByomUsage: false,
      countAuxiliaryUsage: false,
      updatedBy: 'x',
      updatedAt: 'x',
    };
    expect(
      effectiveCeiling(
        { ...base, mode: 'observe' },
        principal,
        'feature.mcp.roundsPerRequest',
      ),
    ).toBeUndefined();
    expect(
      effectiveCeiling(
        { ...base, mode: 'enforce' },
        principal,
        'feature.mcp.roundsPerRequest',
      ),
    ).toBe(2);
  });
});

describe('precomputed active delegations are honoured (review 2026-09-12)', () => {
  const scopedPolicy = {
    version: 1 as const,
    defaults: [{ limitKey: 'chat.messagesPerDay', value: 10, ceiling: false }],
    overrides: [
      {
        id: 'lim-0000000000a1',
        label: '',
        enabled: true,
        scope: 'domain' as const,
        targets: ['ocp.msf.org'],
        priority: 0,
        delegationId: 'del-0000000000aa',
        entries: [
          { limitKey: 'chat.messagesPerDay', value: 500, ceiling: false },
        ],
        createdBy: 'x',
        createdAt: 'x',
        updatedBy: 'x',
        updatedAt: 'x',
      },
    ],
    delegations: [
      {
        id: 'del-0000000000aa',
        label: 'OCP',
        enabled: true,
        admins: [],
        jurisdiction: [{ scope: 'domain' as const, targets: ['ocp.msf.org'] }],
        maxOverrides: 25,
        createdBy: 'x',
        createdAt: 'x',
        updatedBy: 'x',
        updatedAt: 'x',
      },
    ],
    mode: 'enforce' as const,
    failMode: 'open' as const,
    timezone: 'UTC',
    countByomUsage: false,
    countAuxiliaryUsage: false,
    updatedBy: 'x',
    updatedAt: 'x',
  };
  const principal = {
    userId: 'oid-1',
    mail: 'a@ocp.msf.org',
    domain: 'ocp.msf.org',
    attributes: [],
    groupIds: [],
  };

  it("uses the caller's set rather than rescanning: an empty set keeps the scoped record out", () => {
    const scanned = meteredCells(
      scopedPolicy,
      principal,
      'chat.messagesPerDay',
    );
    expect(scanned[0].value).toBe(500);
    const withEmpty = meteredCells(
      scopedPolicy,
      principal,
      'chat.messagesPerDay',
      undefined,
      undefined,
      new Set(),
    );
    expect(withEmpty[0].value).toBe(10);
    const withActive = meteredCells(
      scopedPolicy,
      principal,
      'chat.messagesPerDay',
      undefined,
      undefined,
      new Set(['del-0000000000aa']),
    );
    expect(withActive[0].value).toBe(500);
  });
});
