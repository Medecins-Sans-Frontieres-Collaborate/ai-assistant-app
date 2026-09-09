import { render, screen } from '@testing-library/react';
import React from 'react';

import type { ModelAvailabilityView } from '@/client/hooks/settings/useMyLimits';

import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import { MobileChatHeader } from '@/components/Chat/MobileChatHeader';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * MobileChatHeader parity with the picker's ModelHeader (WP-C §7.4): the
 * current model's usage-limit badge sits next to its name on mobile too,
 * and nothing changes while the model is available.
 */

vi.mock('@/client/hooks/ui/useUI', () => ({
  useUI: () => ({ toggleChatbar: vi.fn() }),
}));
vi.mock('@/client/hooks/conversation/useClearConversation', () => ({
  useClearConversation: () => ({ clearConversation: vi.fn() }),
}));
vi.mock('@/components/Workflows/WorkflowTabs', () => ({
  WorkflowTabs: () => null,
}));

const conversationState = vi.hoisted(() => ({
  model: { id: 'gpt-5.2', name: 'GPT-5.2' } as { id: string; name: string },
}));
vi.mock('@/client/hooks/conversation/useConversations', () => ({
  useConversations: () => ({
    isLoaded: true,
    selectedConversation: {
      id: 'conv-1',
      messages: [],
      model: conversationState.model,
    },
  }),
}));

const availability = vi.hoisted(() => ({
  view: { state: 'available' } as ModelAvailabilityView,
  askedFor: undefined as string | undefined,
}));
vi.mock('@/client/hooks/settings/useMyLimits', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/client/hooks/settings/useMyLimits')
    >();
  return {
    ...actual,
    useModelAvailability: (id?: string) => {
      availability.askedFor = id;
      return availability.view;
    },
  };
});

describe('MobileChatHeader usage-limit badge', () => {
  beforeEach(() => {
    availability.view = { state: 'available' };
    availability.askedFor = undefined;
    conversationState.model = OpenAIModels[OpenAIModelID.GPT_5_2];
  });

  it('renders the model name without a badge while the model is available', () => {
    render(<MobileChatHeader onModelSelectChange={vi.fn()} />);
    expect(screen.getByText('GPT-5.2')).toBeInTheDocument();
    expect(screen.queryByTestId('model-limit-badge')).toBeNull();
    expect(availability.askedFor).toBe('gpt-5.2');
  });

  it('shows the clock badge with the exhausted sentence next to the name', () => {
    availability.view = {
      state: 'exhausted',
      reason: 'exhausted',
      limit: 20,
      used: 20,
      remaining: 0,
      resetAt: new Date(Date.now() + 3600_000).toISOString(),
    };
    render(<MobileChatHeader onModelSelectChange={vi.fn()} />);
    const badge = screen.getByTestId('model-limit-badge');
    expect(badge).toHaveAttribute('aria-label', 'exhausted');
    // Inside the model-select trigger, beside the name.
    expect(badge.closest('button')).toHaveTextContent('GPT-5.2');
  });

  it('uses the family sentence for a family-envelope exhaustion', () => {
    availability.view = {
      state: 'exhausted',
      reason: 'familyExhausted',
      limit: 50,
      used: 50,
      remaining: 0,
    };
    render(<MobileChatHeader onModelSelectChange={vi.fn()} />);
    expect(screen.getByTestId('model-limit-badge')).toHaveAttribute(
      'aria-label',
      'familyExhaustedNoReset',
    );
  });
});
