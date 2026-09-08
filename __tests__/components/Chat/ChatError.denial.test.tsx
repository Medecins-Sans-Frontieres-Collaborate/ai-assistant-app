import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { LimitDenialMetadata } from '@/client/services/api/errors';

import { ChatError } from '@/components/Chat/ChatError';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

// Translate from the REAL messages/en.json so a missing `limitsUx.*` key
// fails here instead of rendering as a raw key in the app. (The global
// next-intl mock in vitest.setup.dom.ts has its own hand-maintained map.)
const enMessages = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  return JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'messages/en.json'), 'utf8'),
  ) as Record<string, unknown>;
});
vi.mock('next-intl', () => ({
  useTranslations: () => {
    const translate = (key: string, params?: Record<string, unknown>) => {
      const value = key
        .split('.')
        .reduce<unknown>(
          (acc, part) =>
            acc && typeof acc === 'object'
              ? (acc as Record<string, unknown>)[part]
              : undefined,
          enMessages,
        );
      if (typeof value !== 'string') {
        throw new Error(`Missing en.json key: ${key}`);
      }
      return Object.entries(params ?? {}).reduce(
        (str, [k, v]) => str.replaceAll(`{${k}}`, String(v)),
        value,
      );
    };
    translate.has = () => true;
    translate.rich = translate;
    return translate;
  },
  useLocale: () => 'en',
}));

// The countdown hook is React-Query-free but timer-driven; pin its output.
const useResetCountdown = vi.hoisted(() =>
  vi.fn((resetAt?: string) => (resetAt ? 'in 6 hours' : null)),
);
vi.mock('@/client/hooks/settings/useMyLimits', () => ({ useResetCountdown }));

const QUOTA = 'RATE_LIMIT_QUOTA_EXCEEDED';
const SERVER_SENTENCE =
  "You've reached your limit of 20 requests today. Resets Wed, 09 Sep 2026 00:00:00 GMT.";

function renderDenial(
  denial: LimitDenialMetadata | null,
  props: Partial<React.ComponentProps<typeof ChatError>> = {},
) {
  const handlers = {
    onClearError: vi.fn(),
    onRetry: vi.fn(),
    onRegenerate: vi.fn(),
    onRetryFallback: vi.fn(),
    onChooseModel: vi.fn(),
    onResendWithoutFeature: vi.fn(),
    onStartNewConversation: vi.fn(),
    onDownloadDebugInfo: vi.fn(),
  };
  render(
    <ChatError
      error={SERVER_SENTENCE}
      errorCode={QUOTA}
      canRetry
      canRegenerate
      canRetryFallback
      fallbackModelName="GPT-5.2"
      denial={denial}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

const noRetryActions = () => {
  expect(screen.queryByText('Try again')).not.toBeInTheDocument();
  expect(screen.queryByText('Regenerate')).not.toBeInTheDocument();
  expect(screen.queryByText(/Try with/)).not.toBeInTheDocument();
};

/**
 * docs/LIMITS_USER_FACING_UX.md §3d/§7.4: localized copy per denial shape,
 * a relative reset time, no "Try again" (it cannot help until the period
 * resets), and the one action that can — another model, or dropping the
 * gated feature.
 */
describe('ChatError — usage-limit denials', () => {
  it('per-model block: localized copy + "Choose another model", no retry', () => {
    const h = renderDenial({ limitKey: 'model.allowed', limit: false });

    expect(
      screen.getByText(/This model isn't available on your account/),
    ).toBeInTheDocument();
    noRetryActions();
    fireEvent.click(screen.getByText('Choose another model'));
    expect(h.onChooseModel).toHaveBeenCalledOnce();
    // Never the server's UTC instant, never a limit key.
    expect(screen.queryByText(/GMT/)).not.toBeInTheDocument();
    expect(screen.queryByText(/model\.allowed/)).not.toBeInTheDocument();
  });

  it('per-model exhaustion: shows the cap and a relative reset', () => {
    renderDenial({
      limitKey: 'model.requests',
      limit: 20,
      used: 20,
      resetAt: '2026-09-09T00:00:00.000Z',
      modelId: 'o3',
      series: 'o-series',
    });

    const text = screen.getByTitle(/requests for this model/).textContent;
    expect(text).toContain('20');
    expect(text).toContain('Resets in 6 hours.');
    expect(useResetCountdown).toHaveBeenCalledWith('2026-09-09T00:00:00.000Z');
    expect(screen.getByText('Choose another model')).toBeInTheDocument();
    noRetryActions();
  });

  it('family envelope exhaustion (series without modelId) gets the family copy', () => {
    renderDenial({
      limitKey: 'model.requests',
      limit: 50,
      resetAt: '2026-09-09T00:00:00.000Z',
      series: 'gpt',
    });

    expect(screen.getByText(/model family/)).toBeInTheDocument();
    expect(screen.getByText('Choose another model')).toBeInTheDocument();
  });

  it('web-search gate: "Turn off web search and resend" flips the feature', () => {
    const h = renderDenial({
      limitKey: 'feature.webSearch.enabled',
      limit: false,
    });

    expect(screen.getByText(/Web search is turned off/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Turn off web search and resend'));
    expect(h.onResendWithoutFeature).toHaveBeenCalledWith('webSearch');
    expect(screen.queryByText('Choose another model')).not.toBeInTheDocument();
    noRetryActions();
  });

  it('code-interpreter gate: resend action names the interpreter', () => {
    const h = renderDenial({
      limitKey: 'feature.codeInterpreter.enabled',
      limit: false,
    });

    fireEvent.click(screen.getByText('Turn off code interpreter and resend'));
    expect(h.onResendWithoutFeature).toHaveBeenCalledWith('codeInterpreter');
  });

  it('connector (MCP) gate: copy only — no one-click resend', () => {
    renderDenial({ limitKey: 'feature.mcp.enabled', limit: false });

    expect(screen.getByText(/Connectors are turned off/)).toBeInTheDocument();
    expect(screen.queryByText(/and resend/)).not.toBeInTheDocument();
    noRetryActions();
  });

  it('overall message cap: countdown only, no actions besides dismiss', () => {
    const h = renderDenial({
      limitKey: 'chat.messagesPerDay',
      limit: 100,
      used: 100,
      resetAt: '2026-09-09T00:00:00.000Z',
    });

    const text = screen.getByTitle(/100 messages/).textContent;
    expect(text).toContain('Resets in 6 hours.');
    expect(screen.queryByText('Choose another model')).not.toBeInTheDocument();
    expect(screen.queryByText(/and resend/)).not.toBeInTheDocument();
    noRetryActions();
    fireEvent.click(screen.getByLabelText('Dismiss error'));
    expect(h.onClearError).toHaveBeenCalledOnce();
  });

  it('token caps name the window', () => {
    const { unmount } = render(
      <ChatError
        error={SERVER_SENTENCE}
        errorCode={QUOTA}
        onClearError={vi.fn()}
        denial={{ limitKey: 'chat.tokensPerMonth', limit: 1_000_000 }}
      />,
    );
    expect(screen.getByText(/this month/)).toBeInTheDocument();
    unmount();

    render(
      <ChatError
        error={SERVER_SENTENCE}
        errorCode={QUOTA}
        onClearError={vi.fn()}
        denial={{ limitKey: 'chat.tokensPerDay', limit: 50_000 }}
      />,
    );
    expect(screen.getByText(/for today/)).toBeInTheDocument();
  });

  it('per-request ceiling: "too big" copy, no reset line', () => {
    renderDenial({ limitKey: 'feature.mcp.roundsPerRequest', limit: 6 });

    const text = screen.getByTitle(/per request/).textContent ?? '';
    expect(text).toContain('6');
    expect(text).not.toContain('Resets');
    noRetryActions();
  });

  it('omits the reset line once the window has rolled over', () => {
    useResetCountdown.mockReturnValueOnce(null);
    renderDenial({
      limitKey: 'chat.messagesPerDay',
      limit: 100,
      resetAt: '2020-01-01T00:00:00.000Z',
    });

    expect(screen.queryByText(/Resets/)).not.toBeInTheDocument();
  });

  it('unknown limit key: keeps the server sentence but still withholds retry', () => {
    renderDenial({ limitKey: 'feature.future.thing', limit: 3 });

    expect(screen.getByTitle(SERVER_SENTENCE)).toBeInTheDocument();
    noRetryActions();
  });

  it('quota code without metadata: server sentence, no retry', () => {
    renderDenial(null);

    expect(screen.getByTitle(SERVER_SENTENCE)).toBeInTheDocument();
    noRetryActions();
    expect(screen.queryByText('Choose another model')).not.toBeInTheDocument();
  });

  it('never shows the corrupted-conversation escalation for a quota', () => {
    renderDenial(
      { limitKey: 'chat.messagesPerDay', limit: 100 },
      { failureStreakCount: 3 },
    );

    expect(
      screen.queryByText(/conversation may have become corrupted/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('Start a new conversation'),
    ).not.toBeInTheDocument();
  });

  it('leaves non-quota errors on the existing path even with the new handlers wired', () => {
    renderDenial(null, { errorCode: 'SOMETHING_ELSE', error: 'boom' });

    expect(screen.getByText('boom')).toBeInTheDocument();
    expect(screen.getByText('Try again')).toBeInTheDocument();
    expect(screen.getByText('Try with GPT-5.2')).toBeInTheDocument();
    expect(screen.queryByText('Choose another model')).not.toBeInTheDocument();
    expect(useResetCountdown).toHaveBeenLastCalledWith(undefined);
  });
});
