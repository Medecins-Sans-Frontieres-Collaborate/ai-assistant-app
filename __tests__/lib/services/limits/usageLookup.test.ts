/**
 * Usage lookup for the preview (design §6c): mail → oid via the caller's
 * delegated token (filter on `mail`, never the path form), then the
 * day/month ledgers. The contract under test is "never throws" — every
 * failure becomes `usageUnavailable` with a reason.
 */
import { NextRequest } from 'next/server';

import {
  lookupUsage,
  resolveSubjectIdByMail,
} from '@/lib/services/limits/usageLookup';
import { readUsage } from '@/lib/services/limits/usageStore';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const graphJsonMock = vi.hoisted(() => vi.fn());

vi.mock('@/auth', () => ({ getGraphAccessToken: vi.fn() }));
vi.mock('@/lib/services/m365/graphApi', () => ({
  graphJson: graphJsonMock,
}));
vi.mock('@/lib/services/limits/usageStore', () => ({
  readUsage: vi.fn(),
}));

/** Structurally identical to graphApi's M365Error (classified by name + kind). */
class FakeM365Error extends Error {
  constructor(
    message: string,
    readonly kind: string,
  ) {
    super(message);
    this.name = 'M365Error';
  }
}

const req = new NextRequest('http://localhost/api/limits/me?as=x');

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('resolveSubjectIdByMail', () => {
  it('filters on `mail eq` with the caller token and returns the single hit', async () => {
    graphJsonMock.mockResolvedValueOnce({ value: [{ id: 'oid-9' }] });

    await expect(
      resolveSubjectIdByMail(req, ' Ada@Contoso.com '),
    ).resolves.toEqual({ subjectId: 'oid-9' });

    expect(graphJsonMock).toHaveBeenCalledTimes(1);
    const [, scopes, path] = graphJsonMock.mock.calls[0];
    expect(scopes).toEqual(['User.Read.All']);
    // The filter form, never `/users/{mail}` — mail ≠ UPN in real tenants.
    expect(path).toBe(
      `/users?$filter=${encodeURIComponent("mail eq 'ada@contoso.com'")}&$select=id&$top=2`,
    );
  });

  it('falls back to the UPN path when the filter finds nobody', async () => {
    graphJsonMock
      .mockResolvedValueOnce({ value: [] })
      .mockResolvedValueOnce({ id: 'oid-upn' });

    await expect(
      resolveSubjectIdByMail(req, 'ada@contoso.com'),
    ).resolves.toEqual({ subjectId: 'oid-upn' });
    expect(graphJsonMock.mock.calls[1][2]).toBe(
      `/users/${encodeURIComponent('ada@contoso.com')}?$select=id`,
    );
  });

  it('answers not_found when both lookups miss', async () => {
    graphJsonMock
      .mockResolvedValueOnce({ value: [] })
      .mockRejectedValueOnce(new FakeM365Error('nope', 'not_found'));
    await expect(
      resolveSubjectIdByMail(req, 'ghost@contoso.com'),
    ).resolves.toEqual({ reason: 'not_found' });
  });

  it('refuses to guess between two accounts sharing a mail', async () => {
    graphJsonMock.mockResolvedValueOnce({
      value: [{ id: 'a' }, { id: 'b' }],
    });
    await expect(
      resolveSubjectIdByMail(req, 'shared@contoso.com'),
    ).resolves.toEqual({ reason: 'ambiguous' });
  });

  it('maps a typed Graph failure to its kind', async () => {
    graphJsonMock.mockRejectedValueOnce(
      new FakeM365Error('no consent', 'consent_missing'),
    );
    await expect(
      resolveSubjectIdByMail(req, 'ada@contoso.com'),
    ).resolves.toEqual({ reason: 'consent_missing' });
  });

  it('maps an untyped failure to graph_error without throwing', async () => {
    graphJsonMock.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(
      resolveSubjectIdByMail(req, 'ada@contoso.com'),
    ).resolves.toEqual({ reason: 'graph_error' });
  });

  it('never interpolates an invalid mail into OData — quotes are refused up front', async () => {
    await expect(
      resolveSubjectIdByMail(req, "o'brien@contoso.com"),
    ).resolves.toEqual({ reason: 'invalid_mail' });
    await expect(resolveSubjectIdByMail(req, 'not-a-mail')).resolves.toEqual({
      reason: 'invalid_mail',
    });
    expect(graphJsonMock).not.toHaveBeenCalled();
  });
});

describe('lookupUsage', () => {
  it('reads the day and month ledgers for the resolved oid in the policy timezone and tags each cell', async () => {
    graphJsonMock.mockResolvedValueOnce({ value: [{ id: 'oid-9' }] });
    vi.mocked(readUsage).mockImplementation(async (_id, kind) =>
      kind === 'day'
        ? { 'chat.messagesPerDay': 3, 'model:gpt-5.2.requests': 1 }
        : { 'chat.tokensPerMonth': 5000 },
    );

    const result = await lookupUsage(req, 'ada@contoso.com', {
      timezone: 'Europe/Paris',
    });

    expect(result).toEqual({
      usageUnavailable: false,
      subjectId: 'oid-9',
      usage: {
        'chat.messagesPerDay': { used: 3, window: 'day' },
        'model:gpt-5.2.requests': { used: 1, window: 'day' },
        'chat.tokensPerMonth': { used: 5000, window: 'month' },
      },
    });
    expect(readUsage).toHaveBeenCalledWith('oid-9', 'day', {
      timezone: 'Europe/Paris',
    });
    expect(readUsage).toHaveBeenCalledWith('oid-9', 'month', {
      timezone: 'Europe/Paris',
    });
  });

  it('propagates the directory reason without touching storage', async () => {
    graphJsonMock.mockRejectedValueOnce(
      new FakeM365Error('forbidden', 'forbidden'),
    );
    await expect(
      lookupUsage(req, 'ada@contoso.com', { timezone: 'UTC' }),
    ).resolves.toEqual({ usageUnavailable: true, reason: 'forbidden' });
    expect(readUsage).not.toHaveBeenCalled();
  });

  it('turns a counter-storage failure into storage_error — never a throw', async () => {
    graphJsonMock.mockResolvedValueOnce({ value: [{ id: 'oid-9' }] });
    vi.mocked(readUsage).mockRejectedValue(new Error('blob down'));
    await expect(
      lookupUsage(req, 'ada@contoso.com', { timezone: 'UTC' }),
    ).resolves.toEqual({ usageUnavailable: true, reason: 'storage_error' });
  });
});
