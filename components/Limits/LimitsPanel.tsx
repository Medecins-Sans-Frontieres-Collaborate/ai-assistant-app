'use client';

import { IconAlertTriangle } from '@tabler/icons-react';
import { FC } from 'react';

import { useTranslations } from 'next-intl';

import { useScopedLimits } from '@/client/hooks/settings/useLimitsAdmin';

import {
  ADMIN_BANNER_ERROR,
  ADMIN_BTN_RETRY,
} from '@/components/Admin/adminClasses';
import { GlobalLimitsPanel } from '@/components/Limits/GlobalLimitsPanel';
import { ScopedOverridesTab } from '@/components/Limits/ScopedOverridesTab';

/**
 * Admin panel for usage limits — the MODE switch.
 *
 * The panel first asks `GET /api/limits/scoped`, which answers for both
 * kinds of limits admin: `isGlobalAdmin: true` → the full panel (defaults,
 * overrides, delegations, whole-policy save); otherwise the caller is a
 * SCOPED admin and gets the confined view (design §6b) driven by that same
 * response. Mode is never inferred from a 403 on the policy GET: the global
 * panel treats every read error as "policy unavailable" (design §8), and a
 * scoped admin must never see an empty list that implies "nothing
 * configured".
 *
 * The server component gates access; this client is presentation only.
 */
export const LimitsPanel: FC = () => {
  const t = useTranslations('limits');
  const scoped = useScopedLimits();

  const scopedMode = scoped.data !== undefined && !scoped.data.isGlobalAdmin;
  const unavailable =
    scoped.isError ||
    (scoped.data !== undefined &&
      !scoped.data.isGlobalAdmin &&
      scoped.data.policyUnavailable);

  return (
    // Body only. AdminShell owns the page plane (the background that
    // globals.css's unconditional `html, body { background: #171717 }` makes
    // mandatory), the back link and the area switcher.
    <div>
      <h1 className="mb-2 text-xl font-bold text-black dark:text-white">
        {t('title')}
      </h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        {scopedMode ? t('scopedDescription') : t('description')}
      </p>

      {unavailable ? (
        <div role="alert" className={ADMIN_BANNER_ERROR}>
          <p className="flex items-center gap-2">
            <IconAlertTriangle size={18} />
            {t('policyUnavailable')}
          </p>
          <button
            type="button"
            className={`mt-3 ${ADMIN_BTN_RETRY}`}
            onClick={() => scoped.refetch()}
          >
            {t('retry')}
          </button>
        </div>
      ) : scoped.data === undefined ? (
        <p className="text-sm text-gray-500 dark:text-gray-400" role="status">
          {t('loading')}
        </p>
      ) : scoped.data.isGlobalAdmin ? (
        <GlobalLimitsPanel />
      ) : (
        <ScopedOverridesTab
          view={scoped.data}
          onRefetch={() => {
            void scoped.refetch();
          }}
        />
      )}
    </div>
  );
};
