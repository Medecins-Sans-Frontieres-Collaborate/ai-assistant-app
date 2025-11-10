'use client';

import { useEffect } from 'react';

import { useTranslations } from 'next-intl';

import { ErrorDisplay } from '@/components/ErrorBoundary/ErrorDisplay';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations();

  useEffect(() => {
    console.error('Global error:', error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <ErrorDisplay
          error={error}
          title={t('errors.applicationError')}
          description={t('errors.criticalErrorReload')}
          onRetry={() => window.location.reload()}
          retryLabel={t('errors.reloadPage')}
          showSupportInfo={true}
        />
      </body>
    </html>
  );
}
