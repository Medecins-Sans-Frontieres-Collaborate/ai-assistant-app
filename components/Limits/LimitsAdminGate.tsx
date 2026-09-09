'use client';

import { FC } from 'react';

import { useTranslations } from 'next-intl';

import { useLimitsEnabled } from '@/client/hooks/settings/useLimitsAdmin';

import { LimitsPanel } from '@/components/Limits/LimitsPanel';

/**
 * Client-side rollout gate for the limits admin panel.
 *
 * The `usageLimits` LaunchDarkly flag is client-side only, so the server
 * component at admin/limits/page.tsx cannot evaluate it — it enforces the
 * session + global-admin gate (the actual security control) and defers the
 * flag to this wrapper. Flag off (or LaunchDarkly not configured) renders a
 * quiet notice rather than a redirect: on a first-ever load flags may not
 * have streamed in yet, and bouncing a legitimate admin off the page for a
 * cache miss would be worse than a flash of this notice.
 */
export const LimitsAdminGate: FC = () => {
  const t = useTranslations();
  const enabled = useLimitsEnabled();

  if (!enabled) {
    return (
      <p className="p-6 text-sm text-gray-500 dark:text-gray-400">
        {t('limits.featureDisabled')}
      </p>
    );
  }

  return <LimitsPanel />;
};
