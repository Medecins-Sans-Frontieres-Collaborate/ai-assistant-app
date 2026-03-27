'use client';

import { useEffect } from 'react';

import { useTranslations } from 'next-intl';

import { ErrorDisplay } from '@/components/ErrorBoundary/ErrorDisplay';

export default function ChatError({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations();

  useEffect(() => {
    console.error('Chat error:', error);
  }, [error]);

  return (
    <ErrorDisplay
      error={error}
      title={t('errors.somethingWentWrong')}
      description={t('errors.chatLoadError')}
      onRetry={() => window.location.reload()}
      retryLabel={t('errors.reloadPage')}
      showSupportInfo={true}
      showDataExport={true}
      showStorageReset={true}
    />
  );
}
