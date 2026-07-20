import { render, screen } from '@testing-library/react';

import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import { UsageImpactSection } from '@/components/Settings/Sections/UsageImpactSection';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The section reads models via useSettings — back it with the static registry.
vi.mock('@/client/hooks/settings/useSettings', () => ({
  useSettings: () => ({ models: Object.values(OpenAIModels) }),
}));

describe('UsageImpactSection', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      tokenUsageStats: {},
      tokenUsageFirstTrackedAt: null,
      estimatedUsageStats: {},
      historicalUsageBackfilledAt: null,
    });
  });

  it('shows the empty state when nothing is tracked', () => {
    render(<UsageImpactSection />);
    expect(screen.getByText(/No usage tracked yet/i)).toBeInTheDocument();
  });

  it('renders totals and a CO2e estimate from accumulated stats', () => {
    useSettingsStore.setState({
      tokenUsageStats: {
        [`${OpenAIModelID.GPT_5_2}|US|none`]: {
          promptTokens: 1000,
          completionTokens: 2000,
          requests: 3,
        },
        [`${OpenAIModelID.DEEPSEEK_R1}|EU|none`]: {
          promptTokens: 500,
          completionTokens: 1500,
          requests: 2,
        },
      },
      tokenUsageFirstTrackedAt: '2026-07-01T00:00:00.000Z',
    });

    render(<UsageImpactSection />);

    // Totals: 5 requests, 1500 prompt, 3500 completion tokens.
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('1,500')).toBeInTheDocument();
    expect(screen.getByText('3,500')).toBeInTheDocument();
    // A gCO2e headline is rendered.
    expect(screen.getByText(/g CO/i)).toBeInTheDocument();
    // Per-model + per-region sections present.
    expect(screen.getByText('GPT-5.2')).toBeInTheDocument();
    expect(screen.getByText('DeepSeek-R1')).toBeInTheDocument();
    // Everyday activity equivalents present.
    expect(screen.getByText(/the same carbon as/i)).toBeInTheDocument();
    expect(screen.getByText('Netflix HD streaming')).toBeInTheDocument();
    expect(screen.getByText('Spotify audio')).toBeInTheDocument();
  });

  it('includes back-calculated buckets in totals and labels the estimated portion', () => {
    useSettingsStore.setState({
      tokenUsageStats: {
        [`${OpenAIModelID.GPT_5_2}|US|none`]: {
          promptTokens: 1000,
          completionTokens: 2000,
          requests: 3,
        },
      },
      estimatedUsageStats: {
        [`${OpenAIModelID.GPT_5_2}|default|none`]: {
          promptTokens: 500,
          completionTokens: 500,
          requests: 2,
        },
      },
      tokenUsageFirstTrackedAt: '2026-07-01T00:00:00.000Z',
    });

    render(<UsageImpactSection />);

    // Totals include both records: 5 requests, 1500 prompt, 2500 completion.
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('1,500')).toBeInTheDocument();
    expect(screen.getByText('2,500')).toBeInTheDocument();
    // The estimated portion is labeled.
    expect(
      screen.getByText(/estimated from chats that predate tracking/i),
    ).toBeInTheDocument();
  });

  it('does not label an estimated portion when there are no back-calculated buckets', () => {
    useSettingsStore.setState({
      tokenUsageStats: {
        [`${OpenAIModelID.GPT_5_2}|US|none`]: {
          promptTokens: 1000,
          completionTokens: 2000,
          requests: 3,
        },
      },
      tokenUsageFirstTrackedAt: '2026-07-01T00:00:00.000Z',
    });

    render(<UsageImpactSection />);
    expect(
      screen.queryByText(/estimated from chats that predate tracking/i),
    ).not.toBeInTheDocument();
  });

  it('leaves the empty state when only estimated stats exist', () => {
    useSettingsStore.setState({
      estimatedUsageStats: {
        [`${OpenAIModelID.GPT_5_2}|default|none`]: {
          promptTokens: 500,
          completionTokens: 500,
          requests: 2,
        },
      },
    });

    render(<UsageImpactSection />);
    expect(screen.queryByText(/No usage tracked yet/i)).not.toBeInTheDocument();
    expect(
      screen.getByText(/estimated from chats that predate tracking/i),
    ).toBeInTheDocument();
  });

  it('renders a retired/unknown model id by falling back to standard class', () => {
    useSettingsStore.setState({
      tokenUsageStats: {
        'retired-model-x|default|none': {
          promptTokens: 100,
          completionTokens: 100,
          requests: 1,
        },
      },
      tokenUsageFirstTrackedAt: '2026-07-01T00:00:00.000Z',
    });

    render(<UsageImpactSection />);
    // The raw id is shown (no metadata name), and it doesn't crash.
    expect(screen.getByText('retired-model-x')).toBeInTheDocument();
  });
});
