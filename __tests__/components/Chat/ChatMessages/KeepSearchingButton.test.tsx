import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { KeepSearchingButton } from '@/components/Chat/ChatMessages/KeepSearchingButton';

import { useChatStore } from '@/client/stores/chatStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const outcomeRecord = (outcome: string) => ({
  id: 'ws-out',
  name: 'web_search',
  server_label: 'Web Search (outcome)',
  arguments: JSON.stringify({
    searchState: {
      question: 'Is the Winter Soldier documentary available to stream?',
      queries: ['Winter Soldier documentary stream'],
      strategies: ['terms'],
      deadEndStrategies: ['terms'],
      pagesTried: [],
      outcome,
      reason: 'no listing found',
      steps: [],
    },
  }),
  status: 'completed' as const,
  output: 'Stopped',
  error: null,
});

describe('KeepSearchingButton', () => {
  let continueSearch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    continueSearch = vi.fn().mockResolvedValue(undefined);
    useChatStore.setState({ continueSearch } as never);
  });

  it('offers to keep searching after a search that ended short, once', () => {
    render(
      <KeepSearchingButton
        conversationId="c1"
        toolCalls={[outcomeRecord('limit')]}
        isLastMessage
        isStreaming={false}
      />,
    );
    const button = screen.getByRole('button', { name: /Keep searching/ });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(continueSearch).toHaveBeenCalledTimes(1);
    expect(continueSearch).toHaveBeenCalledWith(
      'c1',
      'Keep searching for this, please — try a different approach.',
    );
    expect(button).toBeDisabled();
  });

  it('is absent when the search answered, on earlier messages, while streaming, or without a record', () => {
    const cases = [
      {
        toolCalls: [outcomeRecord('answered')],
        isLastMessage: true,
        isStreaming: false,
      },
      {
        toolCalls: [outcomeRecord('limit')],
        isLastMessage: false,
        isStreaming: false,
      },
      {
        toolCalls: [outcomeRecord('limit')],
        isLastMessage: true,
        isStreaming: true,
      },
      { toolCalls: undefined, isLastMessage: true, isStreaming: false },
    ];
    for (const props of cases) {
      const { container, unmount } = render(
        <KeepSearchingButton conversationId="c1" {...props} />,
      );
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });
});
