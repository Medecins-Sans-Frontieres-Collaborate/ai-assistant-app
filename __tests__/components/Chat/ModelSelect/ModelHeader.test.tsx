import { render, screen } from '@testing-library/react';
import React from 'react';

import type { ModelAvailability } from '@/client/hooks/settings/useMyLimits';

import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import { ModelHeader } from '@/components/Chat/ModelSelect/ModelHeader';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ModelHeader's usage-limit badge (WP-C §7.4): the current model's state
 * is visible in the details header, and an agent that pins a model wears
 * that model's state with agent wording. Copy asserts on echoed keys.
 */

const flags: Record<string, unknown> = {};
vi.mock('launchdarkly-react-client-sdk', () => ({ useFlags: () => flags }));

const limitsState = vi.hoisted(() => ({
  enforce: true,
  models: {} as Record<string, ModelAvailability>,
  refetch: vi.fn(),
}));
vi.mock('@/client/hooks/settings/useMyLimits', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/client/hooks/settings/useMyLimits')
    >();
  return {
    ...actual,
    useLimitsEnabled: () => limitsState.enforce,
    useMyLimits: () => ({
      limits: [],
      mode: limitsState.enforce ? ('enforce' as const) : ('observe' as const),
      enforce: limitsState.enforce,
      isLimited: false,
      models: limitsState.models,
      usageUnavailable: false,
      policyUnavailable: false,
      isLoading: false,
      error: null,
      refetch: limitsState.refetch,
    }),
  };
});

const gpt52 = OpenAIModels[OpenAIModelID.GPT_5_2];
const promptAgentModel = {
  ...OpenAIModels[OpenAIModelID.GPT_4_1],
  id: 'org-prompt-abc',
  name: 'Gamma Persona',
  isOrganizationAgent: true,
};
const promptAgent = {
  id: 'prompt-abc',
  name: 'Gamma Persona',
  description: 'A persona',
  icon: 'IconHexagon',
  color: '#123456',
  type: 'foundry' as const,
};

const renderHeader = (
  props: Partial<React.ComponentProps<typeof ModelHeader>> = {},
) =>
  render(
    <ModelHeader
      selectedModel={gpt52}
      modelConfig={gpt52}
      setMobileView={vi.fn()}
      {...props}
    />,
  );

describe('ModelHeader usage-limit badge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limitsState.enforce = true;
    limitsState.models = {};
    // Served list: everything except o3 (hidden by the server for this user).
    useSettingsStore.setState({
      starredModelIds: [],
      models: Object.values(OpenAIModels).filter(
        (m) => !m.isDisabled && m.id !== 'o3',
      ),
    });
  });

  it('renders no badge or note when the current model is available', () => {
    renderHeader();
    expect(screen.queryByTestId('model-limit-badge')).toBeNull();
    expect(screen.queryByTestId('model-limit-header-note')).toBeNull();
  });

  it('badges the current model when it is exhausted and repeats the sentence in prose', () => {
    limitsState.models = {
      [OpenAIModelID.GPT_5_2]: {
        allowed: true,
        reason: 'exhausted',
        limit: 20,
        used: 20,
        remaining: 0,
        resetAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    };
    renderHeader();
    expect(screen.getByTestId('model-limit-badge')).toHaveAttribute(
      'aria-label',
      'exhausted',
    );
    expect(screen.getByTestId('model-limit-header-note')).toHaveTextContent(
      'exhausted',
    );
  });

  it('shows the low-remaining pill for the current model', () => {
    limitsState.models = {
      [OpenAIModelID.GPT_5_2]: {
        allowed: true,
        limit: 10,
        used: 9,
        remaining: 1,
      },
    };
    renderHeader();
    expect(screen.getByTestId('model-limit-remaining')).toBeInTheDocument();
    expect(screen.queryByTestId('model-limit-badge')).toBeNull();
  });

  it('badges an agent whose pinned catalog model the server no longer serves (agent wording)', () => {
    renderHeader({
      selectedModel: promptAgentModel,
      modelConfig: null,
      organizationAgent: promptAgent,
      pinnedModelId: 'o3',
    });
    expect(screen.getByTestId('model-limit-badge')).toHaveAttribute(
      'aria-label',
      'agentModelUnavailable',
    );
    expect(screen.getByTestId('model-limit-header-note')).toHaveTextContent(
      'agentModelUnavailable',
    );
  });

  it('badges an agent whose pinned model is exhausted', () => {
    limitsState.models = {
      [OpenAIModelID.GPT_5_2]: {
        allowed: true,
        reason: 'exhausted',
        limit: 5,
        used: 5,
        remaining: 0,
        resetAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    };
    renderHeader({
      selectedModel: promptAgentModel,
      modelConfig: null,
      organizationAgent: promptAgent,
      pinnedModelId: OpenAIModelID.GPT_5_2,
    });
    expect(screen.getByTestId('model-limit-badge')).toHaveAttribute(
      'aria-label',
      'agentModelExhausted',
    );
  });

  it('fails open for an agent pinned to an unserved model when the policy is not enforced', () => {
    limitsState.enforce = false;
    renderHeader({
      selectedModel: promptAgentModel,
      modelConfig: null,
      organizationAgent: promptAgent,
      pinnedModelId: 'o3',
    });
    expect(screen.queryByTestId('model-limit-badge')).toBeNull();
    expect(screen.queryByTestId('model-limit-header-note')).toBeNull();
  });

  it('never judges an agent-shaped pinned id by list absence (only the limits map counts)', () => {
    renderHeader({
      selectedModel: promptAgentModel,
      modelConfig: null,
      organizationAgent: promptAgent,
      pinnedModelId: 'org-some-foundry-agent',
    });
    expect(screen.queryByTestId('model-limit-badge')).toBeNull();
  });
});
