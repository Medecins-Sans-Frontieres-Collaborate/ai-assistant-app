import { render } from '@testing-library/react';

import type { Props } from '@/components/Chat/ChatMessage';
import { MemoizedChatMessage } from '@/components/Chat/MemoizedChatMessage';

import { describe, expect, it, vi } from 'vitest';

const renderSpy = vi.hoisted(() => vi.fn());

vi.mock('@/components/Chat/ChatMessage', () => ({
  ChatMessage: (props: Props) => {
    renderSpy(props.message.feedback);
    return null;
  },
}));

const props = (feedback?: 'good' | 'bad'): Props =>
  ({
    message: {
      role: 'assistant',
      content: 'answer',
      messageType: undefined,
      feedback,
    },
    messageIndex: 1,
  }) as Props;

describe('MemoizedChatMessage', () => {
  it('re-renders when only the feedback changes', () => {
    const { rerender } = render(<MemoizedChatMessage {...props()} />);

    rerender(<MemoizedChatMessage {...props('good')} />);

    expect(renderSpy).toHaveBeenLastCalledWith('good');
  });

  it('skips re-rendering when nothing it compares has changed', () => {
    renderSpy.mockClear();
    const { rerender } = render(<MemoizedChatMessage {...props('bad')} />);

    rerender(<MemoizedChatMessage {...props('bad')} />);

    expect(renderSpy).toHaveBeenCalledTimes(1);
  });
});
