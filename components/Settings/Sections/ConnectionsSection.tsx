'use client';

import {
  IconBrandOffice,
  IconCheck,
  IconClock,
  IconExclamationCircle,
} from '@tabler/icons-react';
import { FC, useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { useM365Enabled } from '@/client/hooks/useM365Enabled';

import { fetchM365Status } from '@/client/services/m365/m365Client';

import type {
  M365FeatureKey,
  M365FeatureStatus,
  M365Status,
} from '@/types/m365';

import { useSettingsStore } from '@/client/stores/settingsStore';

/**
 * Settings → Connections: the per-user Microsoft 365 opt-in.
 *
 * Connecting flips a local preference only — the tenant-wide admin consent
 * already covers the OAuth side, so there is no extra consent screen. The
 * panel shows, per feature area, whether the tenant grant has actually
 * landed (from /api/m365/status), so "connected but pending admin consent"
 * is visible instead of features just silently missing.
 */

const FEATURE_LABEL_KEYS: Record<M365FeatureKey, string> = {
  files: 'features.files',
  sharepoint: 'features.sharepoint',
  sharepointWrite: 'features.sharepointWrite',
  mail: 'features.mail',
};

const StatusBadge: FC<{ status: M365FeatureStatus }> = ({ status }) => {
  const t = useTranslations('m365.connections');
  if (status === 'granted') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 dark:text-green-400">
        <IconCheck size={14} /> {t('statusGranted')}
      </span>
    );
  }
  if (status === 'consent_missing') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400">
        <IconClock size={14} /> {t('statusPending')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700 dark:text-red-400">
      <IconExclamationCircle size={14} /> {t('statusError')}
    </span>
  );
};

export const ConnectionsSection: FC = () => {
  const t = useTranslations('m365.connections');
  const m365Connected = useSettingsStore((s) => s.m365Connected);
  const setM365Connected = useSettingsStore((s) => s.setM365Connected);
  const { filesEnabled, mailEnabled } = useM365Enabled();

  const [status, setStatus] = useState<M365Status | null>(null);
  const [loading, setLoading] = useState(false);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await fetchM365Status());
    } catch {
      setStatus(null);
      toast.error(t('statusLoadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (m365Connected) {
      void loadStatus();
    }
  }, [m365Connected, loadStatus]);

  // Only feature areas whose capability is on are worth showing —
  // a granted scope behind an off flag still does nothing in the UI.
  const visibleFeatures: M365FeatureKey[] = [
    ...(filesEnabled
      ? (['files', 'sharepoint', 'sharepointWrite'] as M365FeatureKey[])
      : []),
    ...(mailEnabled ? (['mail'] as M365FeatureKey[]) : []),
  ];

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('title')}
        </h3>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          {t('description')}
        </p>
      </div>

      <div className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-800">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <IconBrandOffice
              size={28}
              className="mt-0.5 flex-shrink-0 text-blue-600 dark:text-blue-400"
            />
            <div>
              <div className="font-medium text-gray-900 dark:text-gray-100">
                {t('microsoft365')}
              </div>
              <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
                {t('microsoft365Description')}
              </p>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-500">
                {t('delegatedNote')}
              </p>
            </div>
          </div>
          {m365Connected ? (
            <button
              type="button"
              onClick={() => setM365Connected(false)}
              className="min-h-[36px] flex-shrink-0 rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:border-neutral-600 dark:text-gray-200 dark:hover:bg-neutral-700"
            >
              {t('disconnect')}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setM365Connected(true)}
              className="min-h-[36px] flex-shrink-0 rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
            >
              {t('connect')}
            </button>
          )}
        </div>

        {m365Connected && (
          <div className="mt-4 border-t border-neutral-200 pt-3 dark:border-neutral-700">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                {t('featureStatus')}
              </span>
              <button
                type="button"
                onClick={() => void loadStatus()}
                disabled={loading}
                className="text-xs text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
              >
                {loading ? t('checking') : t('recheck')}
              </button>
            </div>
            <ul className="space-y-1.5">
              {visibleFeatures.map((feature) => (
                <li
                  key={feature}
                  className="flex items-center justify-between text-sm text-gray-800 dark:text-gray-200"
                >
                  <span>{t(FEATURE_LABEL_KEYS[feature])}</span>
                  {status ? (
                    <StatusBadge status={status.features[feature]} />
                  ) : (
                    <span className="text-xs text-gray-400">…</span>
                  )}
                </li>
              ))}
            </ul>
            {status &&
              visibleFeatures.some(
                (f) => status.features[f] === 'consent_missing',
              ) && (
                <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                  {t('consentPendingHint')}
                </p>
              )}
          </div>
        )}
      </div>
    </div>
  );
};
