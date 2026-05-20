'use client';

import { useEffect } from 'react';

import { useTranslations } from 'next-intl';

import { ErrorDisplay } from '@/components/ErrorBoundary/ErrorDisplay';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations();

  useEffect(() => {
    console.error('Page error:', error);
  }, [error]);

  return (
    <ErrorDisplay
      error={error}
      title={t('errors.somethingWentWrong')}
      description={t('errors.unexpectedErrorOccurred')}
      onRetry={reset}
      retryLabel={t('common.tryAgain')}
      showSupportInfo={true}
    />
  );
}
