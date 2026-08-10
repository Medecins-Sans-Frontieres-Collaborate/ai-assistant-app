/**
 * Phishing-screen policy: each deterministic signal flags on its own (no
 * model call), the utility-model stage decides signal-free bodies, model
 * failure fails CLOSED, overrides pass through as labeled-suspicious, and
 * verdicts are cached per message id. The utility client is mocked at the
 * ServiceContainer boundary (the screen lazy-imports it).
 */
import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import {
  clearMailScreenCache,
  screenMailMessage,
} from '@/lib/services/m365/tools/mailScreen';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const modelCreateMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/services/ServiceContainer', () => ({
  ServiceContainer: {
    getInstance: () => ({
      getOpenAIClient: () => ({
        chat: { completions: { create: modelCreateMock } },
      }),
    }),
  },
}));

const req = new NextRequest('http://localhost/api/chat');
const session = {
  user: { id: 'user-1', mail: 'me@contoso.com' },
} as unknown as Session;

function modelVerdict(suspicious: boolean, reasons: string[] = []) {
  modelCreateMock.mockResolvedValue({
    choices: [
      { message: { content: JSON.stringify({ suspicious, reasons }) } },
    ],
  });
}

let idCounter = 0;

function input(
  overrides: Partial<Parameters<typeof screenMailMessage>[2]> = {},
) {
  return {
    messageId: `msg-${++idCounter}`,
    from: 'ana@vendor.com',
    subject: 'Quarterly numbers',
    bodyText: 'Hi, the report is attached to the portal as usual. Thanks!',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearMailScreenCache();
  modelVerdict(false);
});

describe('deterministic signals (no model call)', () => {
  it('flags Authentication-Results spf=fail', async () => {
    const verdict = await screenMailMessage(
      req,
      session,
      input({
        headers: [
          {
            name: 'Authentication-Results',
            value: 'spf=fail (sender IP is 1.2.3.4); dkim=pass; dmarc=pass',
          },
        ],
      }),
    );
    expect(verdict).toMatchObject({ verdict: 'suspicious', overridden: false });
    expect((verdict as { reasons: string[] }).reasons.join(' ')).toContain(
      'spf=fail',
    );
    expect(modelCreateMock).not.toHaveBeenCalled();
  });

  it('flags dkim and dmarc failures (header name case-insensitive)', async () => {
    const verdict = await screenMailMessage(
      req,
      session,
      input({
        headers: [
          {
            name: 'authentication-results',
            value: 'spf=pass; dkim=fail; dmarc=fail',
          },
        ],
      }),
    );
    expect(verdict.verdict).toBe('suspicious');
    const reasons = (verdict as { reasons: string[] }).reasons.join(' ');
    expect(reasons).toContain('dkim=fail');
    expect(reasons).toContain('dmarc=fail');
  });

  it('ignores passing Authentication-Results', async () => {
    const verdict = await screenMailMessage(
      req,
      session,
      input({
        headers: [
          {
            name: 'Authentication-Results',
            value: 'spf=pass; dkim=pass; dmarc=pass',
          },
        ],
      }),
    );
    expect(verdict.verdict).toBe('clear');
  });

  it('flags reply-to domain differing from the sender domain', async () => {
    const verdict = await screenMailMessage(
      req,
      session,
      input({ from: 'billing@vendor.com', replyTo: 'catch@evil.net' }),
    );
    expect(verdict.verdict).toBe('suspicious');
    expect((verdict as { reasons: string[] }).reasons[0]).toContain('evil.net');
    expect(modelCreateMock).not.toHaveBeenCalled();
  });

  it('flags a lookalike of the user own domain (edit distance ≤ 2)', async () => {
    const verdict = await screenMailMessage(
      req,
      session,
      input({ from: 'ceo@contos0.com' }),
    );
    expect(verdict.verdict).toBe('suspicious');
    expect((verdict as { reasons: string[] }).reasons[0]).toContain(
      'contos0.com',
    );
  });

  it('flags punycode sender domains', async () => {
    const verdict = await screenMailMessage(
      req,
      session,
      input({ from: 'ceo@xn--cntoso-wxa.com' }),
    );
    expect(verdict.verdict).toBe('suspicious');
    expect((verdict as { reasons: string[] }).reasons[0]).toContain('punycode');
  });

  it('never lookalike-flags mail from the user own domain', async () => {
    const verdict = await screenMailMessage(
      req,
      session,
      input({ from: 'colleague@contoso.com' }),
    );
    expect(verdict.verdict).toBe('clear');
  });

  it('flags anchor text naming a different domain than the href host', async () => {
    const verdict = await screenMailMessage(
      req,
      session,
      input({
        bodyText:
          'Reset here: <a href="https://evil.example.net/login">https://portal.contoso.com/reset</a>',
      }),
    );
    expect(verdict.verdict).toBe('suspicious');
    const reason = (verdict as { reasons: string[] }).reasons[0];
    expect(reason).toContain('portal.contoso.com');
    expect(reason).toContain('evil.example.net');
  });

  it('does not flag anchors whose text matches the link host', async () => {
    const verdict = await screenMailMessage(
      req,
      session,
      input({
        bodyText:
          'Docs: <a href="https://learn.contoso.com/guide">learn.contoso.com</a>',
      }),
    );
    expect(verdict.verdict).toBe('clear');
  });

  it('flags markdown links with IP-literal hosts', async () => {
    const verdict = await screenMailMessage(
      req,
      session,
      input({
        bodyText: 'Urgent: [account portal](http://192.168.4.12/reset)',
      }),
    );
    expect(verdict.verdict).toBe('suspicious');
    expect((verdict as { reasons: string[] }).reasons.join(' ')).toContain(
      '192.168.4.12',
    );
  });

  it('flags bare shortener URLs in text bodies', async () => {
    const verdict = await screenMailMessage(
      req,
      session,
      input({ bodyText: 'See https://bit.ly/3xYz for the invoice.' }),
    );
    expect(verdict.verdict).toBe('suspicious');
    expect((verdict as { reasons: string[] }).reasons.join(' ')).toContain(
      'bit.ly',
    );
  });

  it('logs categories only — never subjects or addresses', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await screenMailMessage(
      req,
      session,
      input({
        subject: 'SECRET SUBJECT',
        from: 'billing@vendor.com',
        replyTo: 'catch@evil.net',
      }),
    );
    const auditLine = log.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes('[m365-mail-screen]'));
    expect(auditLine).toBe(
      '[m365-mail-screen] flagged count=1 categories=reply-to',
    );
    expect(auditLine).not.toContain('SECRET');
    log.mockRestore();
  });
});

describe('utility-model stage', () => {
  it('clears a signal-free message when the model says clear', async () => {
    modelVerdict(false);
    const verdict = await screenMailMessage(req, session, input());
    expect(verdict).toEqual({ verdict: 'clear' });
    expect(modelCreateMock).toHaveBeenCalledTimes(1);
  });

  it('flags on a model-suspicious verdict with the model reasons', async () => {
    modelVerdict(true, ['credential-harvest framing']);
    const verdict = await screenMailMessage(req, session, input());
    expect(verdict).toMatchObject({
      verdict: 'suspicious',
      reasons: ['credential-harvest framing'],
      overridden: false,
    });
  });

  it('fails CLOSED when the model stage errors and no signal fired', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    modelCreateMock.mockRejectedValue(new Error('boom'));
    const verdict = await screenMailMessage(req, session, input());
    expect(verdict.verdict).toBe('suspicious');
    expect((verdict as { reasons: string[] }).reasons[0]).toContain(
      'screening unavailable',
    );
    warn.mockRestore();
  });

  it('does not cache the fail-closed unavailable verdict', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const message = input();
    modelCreateMock.mockRejectedValueOnce(new Error('transient'));
    expect((await screenMailMessage(req, session, message)).verdict).toBe(
      'suspicious',
    );
    modelVerdict(false);
    expect((await screenMailMessage(req, session, message)).verdict).toBe(
      'clear',
    );
    warn.mockRestore();
  });
});

describe('overrides and cache', () => {
  it('returns overridden:true (still suspicious) for an overridden id', async () => {
    const message = input({
      from: 'billing@vendor.com',
      replyTo: 'x@evil.net',
    });
    const verdict = await screenMailMessage(req, session, message, {
      overrideIds: new Set([message.messageId]),
    });
    expect(verdict).toMatchObject({ verdict: 'suspicious', overridden: true });
  });

  it('applies overrides per request on top of a cached verdict', async () => {
    const message = input({
      from: 'billing@vendor.com',
      replyTo: 'x@evil.net',
    });
    const first = await screenMailMessage(req, session, message);
    expect(first).toMatchObject({ verdict: 'suspicious', overridden: false });
    const second = await screenMailMessage(req, session, message, {
      overrideIds: new Set([message.messageId]),
    });
    expect(second).toMatchObject({ verdict: 'suspicious', overridden: true });
  });

  it('screens each id once — the second call makes no model call', async () => {
    modelVerdict(false);
    const message = input();
    await screenMailMessage(req, session, message);
    await screenMailMessage(req, session, message);
    expect(modelCreateMock).toHaveBeenCalledTimes(1);
  });

  it('clearMailScreenCache forces a re-screen', async () => {
    modelVerdict(false);
    const message = input();
    await screenMailMessage(req, session, message);
    clearMailScreenCache();
    await screenMailMessage(req, session, message);
    expect(modelCreateMock).toHaveBeenCalledTimes(2);
  });
});
