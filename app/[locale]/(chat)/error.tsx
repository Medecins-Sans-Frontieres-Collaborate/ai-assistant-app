'use client';

import { useEffect } from 'react';

import { ErrorDisplay } from '@/components/ErrorBoundary/ErrorDisplay';

export default function ChatError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Chat error:', error);
  }, [error]);

  return (
    <ErrorDisplay
      error={error}
      title="Something went wrong"
      description="An error occurred while loading the chat"
      onRetry={() => window.location.reload()}
      retryLabel="Reload chat"
      showSupportInfo={true}
    />
  );
}
