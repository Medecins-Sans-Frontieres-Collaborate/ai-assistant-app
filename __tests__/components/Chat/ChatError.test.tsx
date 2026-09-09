import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { ChatError } from '@/components/Chat/ChatError';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

// Translations come from the global next-intl mock in vitest.setup.dom.ts
// (mockMessages) — the strings asserted below live there.

function renderChatError(
  props: Partial<React.ComponentProps<typeof ChatError>> = {},
) {
  const defaults: React.ComponentProps<typeof ChatError> = {
    error: 'boom',
    onClearError: vi.fn(),
    onRetry: vi.fn(),
    canRetry: true,
  };
  return render(<ChatError {...defaults} {...props} />);
}

describe('ChatError', () => {
  it('renders nothing when there is no error', () => {
    const { container } = renderChatError({ error: null });
    expect(container).toBeEmptyDOMElement();
  });

  it('shows no escalation row below the threshold', () => {
    renderChatError({
      failureStreakCount: 2,
      onStartNewConversation: vi.fn(),
      onDownloadDebugInfo: vi.fn(),
    });

    expect(screen.getByText('boom')).toBeInTheDocument();
    expect(
      screen.queryByText('Start a new conversation'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Download debug info')).not.toBeInTheDocument();
  });

  it('escalates at the threshold: notice + both actions, Try again kept', () => {
    renderChatError({
      failureStreakCount: 3,
      onStartNewConversation: vi.fn(),
      onDownloadDebugInfo: vi.fn(),
    });

    expect(
      screen.getByText(/conversation may have become corrupted/),
    ).toBeInTheDocument();
    expect(screen.getByText('Start a new conversation')).toBeInTheDocument();
    expect(screen.getByText('Download debug info')).toBeInTheDocument();
    // Escalation never removes the retry action.
    expect(screen.getByText('Try again')).toBeInTheDocument();
  });

  it('invokes onStartNewConversation', () => {
    const onStartNewConversation = vi.fn();
    renderChatError({
      failureStreakCount: 3,
      onStartNewConversation,
      onDownloadDebugInfo: vi.fn(),
    });

    fireEvent.click(screen.getByText('Start a new conversation'));

    expect(onStartNewConversation).toHaveBeenCalledOnce();
  });

  it('downloads metadata-only by default, full after opting in', () => {
    const onDownloadDebugInfo = vi.fn();
    renderChatError({
      failureStreakCount: 3,
      onStartNewConversation: vi.fn(),
      onDownloadDebugInfo,
    });

    fireEvent.click(screen.getByText('Download debug info'));
    expect(onDownloadDebugInfo).toHaveBeenLastCalledWith(false);

    fireEvent.click(screen.getByLabelText('Include message text'));
    fireEvent.click(screen.getByText('Download debug info'));
    expect(onDownloadDebugInfo).toHaveBeenLastCalledWith(true);
  });

  it('does not escalate when the escalation handlers are absent', () => {
    renderChatError({ failureStreakCount: 5 });

    expect(
      screen.queryByText(/conversation may have become corrupted/),
    ).not.toBeInTheDocument();
  });
});
