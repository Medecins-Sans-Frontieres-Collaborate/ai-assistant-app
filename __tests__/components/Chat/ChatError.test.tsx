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

describe('ChatError - model timeout (issue #130)', () => {
  const timeout = {
    kind: 'model' as const,
    modelName: 'GPT-5.2',
    seconds: 90,
    longerSeconds: 180,
  };

  it('renders localized copy naming the model and the wait, not the server string', () => {
    renderChatError({
      error: 'Stage StandardChatHandler exceeded timeout of 90000ms',
      errorCode: 'MODEL_TIMEOUT',
      timeout,
      onRetryLonger: vi.fn(),
    });

    expect(
      screen.getByText(
        "GPT-5.2 didn't start responding within 90 seconds. It may be busy — you can wait longer, or try another model.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/exceeded timeout/)).not.toBeInTheDocument();
  });

  it('replaces "Try again" with the longer-wait action and calls it with the escalated seconds', () => {
    const onRetry = vi.fn();
    const onRetryLonger = vi.fn();
    renderChatError({
      errorCode: 'MODEL_TIMEOUT',
      timeout,
      onRetry,
      onRetryLonger,
    });

    expect(screen.queryByText('Try again')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Wait up to 3 minutes and try again'));
    expect(onRetryLonger).toHaveBeenCalledWith(180);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('offers to persist the longer wait as the default', () => {
    const onAlwaysWaitLonger = vi.fn();
    renderChatError({
      errorCode: 'MODEL_TIMEOUT',
      timeout,
      onRetryLonger: vi.fn(),
      onAlwaysWaitLonger,
    });

    fireEvent.click(screen.getByText('Always wait up to 3 minutes'));
    expect(onAlwaysWaitLonger).toHaveBeenCalledWith(180);
  });

  it('falls back to plain "Try again" once the ceiling has been used', () => {
    const onRetry = vi.fn();
    renderChatError({
      errorCode: 'MODEL_TIMEOUT',
      timeout: { ...timeout, seconds: 600, longerSeconds: null },
      onRetry,
      onRetryLonger: vi.fn(),
      onAlwaysWaitLonger: vi.fn(),
    });

    expect(screen.getByText(/the longest wait available/)).toBeInTheDocument();
    expect(screen.queryByText(/Wait up to/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Always wait/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Try again'));
    expect(onRetry).toHaveBeenCalled();
  });

  it('keeps the longer-wait action off the regenerate path', () => {
    renderChatError({
      errorCode: 'MODEL_TIMEOUT',
      timeout,
      canRetry: false,
      onRetry: undefined,
      canRegenerate: true,
      onRegenerate: vi.fn(),
      onRetryLonger: vi.fn(),
    });

    expect(screen.queryByText(/Wait up to/)).not.toBeInTheDocument();
    expect(screen.getByText('Regenerate')).toBeInTheDocument();
  });

  it('uses request-level copy for a whole-request timeout', () => {
    renderChatError({
      errorCode: 'REQUEST_TIMEOUT',
      timeout: { ...timeout, kind: 'request' },
      onRetryLonger: vi.fn(),
    });

    expect(
      screen.getByText(
        /took too long to prepare and was stopped before GPT-5.2/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Wait up to 3 minutes and try again'),
    ).toBeInTheDocument();
  });
});
