// ───────────────────────────────────────────────────────────────────
// AssistantMessage — TTS route pre-flight (docs/LIMITS_USER_FACING_UX.md
// §7.4). The speaker button is disabled with a reason when
// `feature.tts.charactersPerDay` reports 0 remaining, and is untouched in
// every other state (no row, usage unreadable, observe mode, flag off —
// all of which `featureRemaining` collapses to `undefined`).
// ───────────────────────────────────────────────────────────────────
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import type { FeatureRemaining } from '@/client/hooks/settings/useMyLimits';

import { AssistantMessage } from '@/components/Chat/ChatMessages/AssistantMessage';

import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/dynamic', () => ({
  default: () => {
    const Stub = (props: Record<string, unknown>) => (
      <div data-testid="markdown">{String(props.children ?? '')}</div>
    );
    return Stub;
  },
}));

vi.mock('@/client/hooks/settings/useSettings', () => ({
  useSettings: () => ({
    ttsSettings: {
      rate: 1,
      pitch: 1,
      outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
      globalVoice: '',
      languageVoices: {},
    },
  }),
}));

vi.mock('@/client/hooks/useM365Enabled', () => ({
  useM365Enabled: () => ({ enabled: false, sharingEnabled: false }),
}));

vi.mock('@/lib/services/translation', () => ({ translateText: vi.fn() }));

const budgets: Record<string, FeatureRemaining | undefined> = {};
let countdown: string | null = null;

// Counts direct `useMyLimits()` calls separately from `useLimitGates()` —
// AssistantMessage must reach `featureRemaining` only through the latter.
// A second direct subscription here would double the `['limits-me', …]`
// React Query observer count for every rendered assistant message
// (docs/LIMITS_USER_FACING_UX.md §7.4 follow-up).
const useMyLimitsSpy = vi.fn();

vi.mock('@/client/hooks/settings/useMyLimits', () => ({
  useLimitGates: () => ({
    isFeatureBlocked: () => false,
    featureRemaining: (key: string) => budgets[key],
    enforce: true,
  }),
  useMyLimits: (...args: unknown[]) => {
    useMyLimitsSpy(...args);
    return { refetch: vi.fn(), limits: [], models: {}, enforce: true };
  },
  useResetCountdown: (resetAt?: string) => (resetAt ? countdown : null),
}));

function renderMessage() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <AssistantMessage
        content="Hello there."
        messageIsStreaming={false}
        messageIndex={0}
        selectedConversation={null}
      />
    </QueryClientProvider>,
  );
}

const ttsButton = () => screen.getByTestId('tts-button');

describe('AssistantMessage — TTS budget gate', () => {
  beforeEach(() => {
    for (const key of Object.keys(budgets)) delete budgets[key];
    countdown = null;
    useMyLimitsSpy.mockClear();
  });

  it('reaches the TTS budget only through useLimitGates, never a second direct useMyLimits() subscription', () => {
    renderMessage();
    expect(useMyLimitsSpy).not.toHaveBeenCalled();
  });

  it('leaves the speaker button enabled when no TTS counter is reported (fail open)', () => {
    renderMessage();
    const button = ttsButton();
    expect(button).not.toBeDisabled();
    expect(button).not.toHaveAttribute('aria-disabled');
    expect(button).toHaveAttribute('title', 'chat.ttsRightClickHint');
  });

  it('stays enabled while budget remains, even when low', () => {
    budgets['feature.tts.charactersPerDay'] = {
      remaining: 12,
      limit: 5000,
      used: 4988,
      resetAt: '2099-01-01T00:00:00.000Z',
    };
    renderMessage();
    expect(ttsButton()).not.toBeDisabled();
  });

  it('marks the button aria-disabled (but keeps it focusable) with the exhausted reason and the reset countdown at 0 remaining', () => {
    budgets['feature.tts.charactersPerDay'] = {
      remaining: 0,
      limit: 5000,
      used: 5000,
      resetAt: '2099-01-01T00:00:00.000Z',
    };
    countdown = 'in 6 hours';
    renderMessage();
    const button = ttsButton();
    // Not natively `disabled`: keyboard and screen-reader users must still
    // be able to reach the button to learn why it's inert (native `disabled`
    // removes it from the tab order in every browser, and Firefox in
    // particular suppresses hover/`title` on disabled controls).
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    // Copy comes from limitsUx.routes (mocked next-intl echoes the key with
    // its params interpolated).
    expect(button).toHaveAttribute(
      'title',
      'limitsUx.routes.ttsExhausted limitsUx.routes.resetsIn',
    );
  });

  it('omits the countdown clause when resetAt is absent or already past', () => {
    budgets['feature.tts.charactersPerDay'] = { remaining: 0, limit: 5000 };
    renderMessage();
    const button = ttsButton();
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute('title', 'limitsUx.routes.ttsExhausted');
  });

  it('surfaces the exhausted reason on click via the aria-live loading line instead of starting synthesis, since hover/title alone misses touch and Firefox-disabled controls', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    budgets['feature.tts.charactersPerDay'] = {
      remaining: 0,
      limit: 5000,
      used: 5000,
      resetAt: '2099-01-01T00:00:00.000Z',
    };
    renderMessage();
    const button = ttsButton();

    fireEvent.click(button);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText('limitsUx.routes.ttsExhausted')).toBeVisible();
    vi.unstubAllGlobals();
  });

  it('does not gate a different feature counter', () => {
    budgets['feature.translation.jobsPerDay'] = { remaining: 0, limit: 3 };
    renderMessage();
    expect(ttsButton()).not.toBeDisabled();
  });
});
