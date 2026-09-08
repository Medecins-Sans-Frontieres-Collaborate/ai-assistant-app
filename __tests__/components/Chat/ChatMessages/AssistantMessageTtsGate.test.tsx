// ───────────────────────────────────────────────────────────────────
// AssistantMessage — TTS route pre-flight (docs/LIMITS_USER_FACING_UX.md
// §7.4). The speaker button is disabled with a reason when
// `feature.tts.charactersPerDay` reports 0 remaining, and is untouched in
// every other state (no row, usage unreadable, observe mode, flag off —
// all of which `featureRemaining` collapses to `undefined`).
// ───────────────────────────────────────────────────────────────────
import { render, screen } from '@testing-library/react';
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
const refetch = vi.fn();
let countdown: string | null = null;

vi.mock('@/client/hooks/settings/useMyLimits', () => ({
  useLimitGates: () => ({
    isFeatureBlocked: () => false,
    featureRemaining: (key: string) => budgets[key],
    enforce: true,
  }),
  useMyLimits: () => ({ refetch, limits: [], models: {}, enforce: true }),
  useResetCountdown: (resetAt?: string) => (resetAt ? countdown : null),
}));

function renderMessage() {
  return render(
    <AssistantMessage
      content="Hello there."
      messageIsStreaming={false}
      messageIndex={0}
      selectedConversation={null}
    />,
  );
}

const ttsButton = () => screen.getByTestId('tts-button');

describe('AssistantMessage — TTS budget gate', () => {
  beforeEach(() => {
    for (const key of Object.keys(budgets)) delete budgets[key];
    countdown = null;
    refetch.mockClear();
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

  it('disables the button with the exhausted reason and the reset countdown at 0 remaining', () => {
    budgets['feature.tts.charactersPerDay'] = {
      remaining: 0,
      limit: 5000,
      used: 5000,
      resetAt: '2099-01-01T00:00:00.000Z',
    };
    countdown = 'in 6 hours';
    renderMessage();
    const button = ttsButton();
    expect(button).toBeDisabled();
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
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'limitsUx.routes.ttsExhausted');
  });

  it('does not gate a different feature counter', () => {
    budgets['feature.translation.jobsPerDay'] = { remaining: 0, limit: 3 };
    renderMessage();
    expect(ttsButton()).not.toBeDisabled();
  });
});
