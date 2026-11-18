// AssistantMessage — thumb feedback. One piece of feedback per answer: the
// first click is stored and sent; after that both thumbs are disabled so repeat
// clicks can't skew the feedback stats.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import type { TokenUsageMetadata } from '@/lib/utils/app/metadata';

import type { Conversation, MessageFeedback } from '@/types/chat';

import { AssistantMessage } from '@/components/Chat/ChatMessages/AssistantMessage';

import { useConversationStore } from '@/client/stores/conversationStore';
import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('@/client/hooks/settings/useMyLimits', () => ({
  useLimitGates: () => ({
    isFeatureBlocked: () => false,
    featureRemaining: () => undefined,
    enforce: true,
  }),
  useMyLimits: () => ({
    refetch: vi.fn(),
    limits: [],
    models: {},
    enforce: true,
  }),
  useResetCountdown: () => null,
}));

const conversation = {
  id: 'c1',
  model: { id: 'gpt-5.6' },
} as Conversation;

function renderMessage({
  feedback,
  usage,
}: { feedback?: MessageFeedback; usage?: TokenUsageMetadata } = {}) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AssistantMessage
        content="Hello there."
        message={{
          role: 'assistant',
          content: 'Hello there.',
          messageType: undefined,
          feedback,
          usage,
        }}
        messageIsStreaming={false}
        messageIndex={1}
        selectedConversation={conversation}
      />
    </QueryClientProvider>,
  );
}

const goodButton = () =>
  screen.getByRole('button', { name: 'chat.goodResponse' });
const badButton = () =>
  screen.getByRole('button', { name: 'chat.badResponse' });

describe('AssistantMessage — feedback', () => {
  const fetchMock = vi.fn();
  const setMessageFeedback = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(new Response(null));
    vi.stubGlobal('fetch', fetchMock);
    setMessageFeedback.mockReset();
    useConversationStore.setState({ setMessageFeedback });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const feedbackRequests = () =>
    fetchMock.mock.calls.filter(([url]) => url === '/api/chat/feedback');

  it('stores and sends the first feedback', () => {
    renderMessage();

    fireEvent.click(goodButton());

    expect(setMessageFeedback).toHaveBeenCalledWith('c1', 1, 'good');
    expect(feedbackRequests()).toHaveLength(1);
    expect(JSON.parse(feedbackRequests()[0][1].body)).toMatchObject({
      rating: 'good',
      conversationId: 'c1',
      model: 'gpt-5.6',
    });
  });

  it('credits the model that wrote the answer over the conversation model', () => {
    renderMessage({
      usage: {
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
        modelId: 'gpt-5.4',
        region: null,
      },
    });

    fireEvent.click(goodButton());

    expect(JSON.parse(feedbackRequests()[0][1].body).model).toBe('gpt-5.4');
  });

  it('locks both thumbs once the answer has feedback', () => {
    renderMessage({ feedback: 'good' });

    expect(goodButton()).toHaveAttribute('aria-pressed', 'true');
    expect(goodButton()).toHaveAttribute('aria-disabled', 'true');
    expect(badButton()).toHaveAttribute('aria-disabled', 'true');

    fireEvent.click(goodButton());
    fireEvent.click(badButton());

    expect(setMessageFeedback).not.toHaveBeenCalled();
    expect(feedbackRequests()).toHaveLength(0);
  });

  it('leaves both thumbs available on an answer without feedback', () => {
    renderMessage();

    expect(goodButton()).not.toHaveAttribute('aria-disabled');
    expect(badButton()).not.toHaveAttribute('aria-disabled');
  });
});
