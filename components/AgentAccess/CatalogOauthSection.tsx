'use client';

import { IconCheck, IconWorld } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FC, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { unwrapApiData } from '@/client/hooks/settings/useAgentAccessAdmin';

interface CatalogOauthEntry {
  catalogKey: string;
  name: string;
  supportsDynamicRegistration: boolean;
  envConfigured: boolean;
  adminConfigured: boolean;
  clientId: string | null;
  hasClientSecret: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
  etag: string | null;
}

interface CatalogOauthResponse {
  entries: CatalogOauthEntry[];
  storageUnavailable: boolean;
  secretSealingAvailable: boolean;
}

/**
 * Global-admin management of the deployment's OAuth apps for the curated
 * catalog connectors (github, asana, …) — the Admin → Connectors
 * replacement for the MCP_OAUTH_* env vars. One row per OAuth-capable
 * catalog entry; a saved record overrides the env pair for that key, and
 * removing it falls back to env (badged so the effective layer is visible).
 * Secrets are write-only: the form never displays a stored secret.
 */
export const CatalogOauthSection: FC = () => {
  const t = useTranslations('agentAccess.catalogOauth');
  const queryClient = useQueryClient();

  const query = useQuery<CatalogOauthResponse>({
    queryKey: ['agent-access-catalog-oauth'],
    queryFn: async () => {
      const response = await fetch('/api/agent-access/catalog-oauth');
      if (!response.ok) {
        throw new Error(
          `Failed to fetch catalog OAuth apps: ${response.status}`,
        );
      }
      return unwrapApiData<CatalogOauthResponse>(await response.json());
    },
    retry: 1,
    refetchOnWindowFocus: false,
  });

  // Per-key drafts; absent = row not being edited.
  const [drafts, setDrafts] = useState<
    Record<string, { clientId: string; clientSecret: string }>
  >({});
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const setDraft = (
    key: string,
    patch: Partial<{ clientId: string; clientSecret: string }>,
    entry: CatalogOauthEntry,
  ) =>
    setDrafts((prev) => ({
      ...prev,
      [key]: {
        clientId: prev[key]?.clientId ?? entry.clientId ?? '',
        clientSecret: prev[key]?.clientSecret ?? '',
        ...patch,
      },
    }));

  const finishMutation = () => {
    void queryClient.invalidateQueries({
      queryKey: ['agent-access-catalog-oauth'],
    });
  };

  const save = async (entry: CatalogOauthEntry) => {
    const draft = drafts[entry.catalogKey];
    if (!draft?.clientId.trim()) return;
    setSavingKey(entry.catalogKey);
    try {
      const response = await fetch('/api/agent-access/catalog-oauth', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(entry.etag ? { 'If-Match': entry.etag } : {}),
        },
        body: JSON.stringify({
          catalogKey: entry.catalogKey,
          clientId: draft.clientId.trim(),
          // Omit when untouched so a stored secret is kept.
          ...(draft.clientSecret !== ''
            ? { clientSecret: draft.clientSecret }
            : {}),
        }),
      });
      if (response.status === 412 || response.status === 409) {
        toast.error(t('conflict'));
        finishMutation();
        return;
      }
      if (!response.ok) throw new Error(`save failed: ${response.status}`);
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[entry.catalogKey];
        return next;
      });
      toast.success(t('saved', { name: entry.name }));
      finishMutation();
    } catch {
      toast.error(t('saveError'));
    } finally {
      setSavingKey(null);
    }
  };

  const remove = async (entry: CatalogOauthEntry) => {
    if (!entry.etag) return;
    setSavingKey(entry.catalogKey);
    try {
      const response = await fetch(
        `/api/agent-access/catalog-oauth?catalogKey=${encodeURIComponent(entry.catalogKey)}`,
        { method: 'DELETE', headers: { 'If-Match': entry.etag } },
      );
      if (response.status === 412) {
        toast.error(t('conflict'));
        finishMutation();
        return;
      }
      if (!response.ok) throw new Error(`delete failed: ${response.status}`);
      toast.success(t('removed', { name: entry.name }));
      finishMutation();
    } catch {
      toast.error(t('saveError'));
    } finally {
      setSavingKey(null);
    }
  };

  if (query.isLoading) return null;
  if (query.error || !query.data) return null;
  const { entries, storageUnavailable, secretSealingAvailable } = query.data;

  return (
    <section className="mb-6 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
      <h3 className="text-sm font-semibold text-black dark:text-white">
        {t('title')}
      </h3>
      <p className="mt-0.5 mb-3 text-xs text-gray-500 dark:text-gray-400">
        {t('description')}
      </p>
      {storageUnavailable && (
        <p className="mb-3 text-xs text-red-600 dark:text-red-400">
          {t('storageUnavailable')}
        </p>
      )}
      {!secretSealingAvailable && (
        <p className="mb-3 text-xs text-amber-600 dark:text-amber-400">
          {t('sealingUnavailable')}
        </p>
      )}
      <ul className="space-y-3">
        {entries.map((entry) => {
          const draft = drafts[entry.catalogKey];
          const clientIdValue = draft?.clientId ?? entry.clientId ?? '';
          const dirty =
            draft !== undefined &&
            (draft.clientId !== (entry.clientId ?? '') ||
              draft.clientSecret !== '');
          return (
            <li
              key={entry.catalogKey}
              className="rounded-lg border border-gray-200 dark:border-gray-700 p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-black dark:text-white">
                  {entry.name}
                </span>
                {entry.adminConfigured ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-800 dark:bg-green-900/40 dark:text-green-300">
                    <IconCheck size={12} /> {t('badgeAdmin')}
                  </span>
                ) : entry.envConfigured ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                    {t('badgeEnv')}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                    {t('badgeNone')}
                  </span>
                )}
                {entry.supportsDynamicRegistration && (
                  <span
                    className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[11px] text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                    title={t('badgeDcrHint')}
                  >
                    <IconWorld size={12} /> {t('badgeDcr')}
                  </span>
                )}
              </div>

              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-0.5 block text-xs text-gray-600 dark:text-gray-400">
                    {t('clientIdLabel')}
                  </span>
                  <input
                    type="text"
                    autoComplete="off"
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1.5 text-sm text-black dark:text-white"
                    value={clientIdValue}
                    onChange={(e) =>
                      setDraft(
                        entry.catalogKey,
                        { clientId: e.target.value },
                        entry,
                      )
                    }
                  />
                </label>
                <label className="block">
                  <span className="mb-0.5 block text-xs text-gray-600 dark:text-gray-400">
                    {t('clientSecretLabel')}
                  </span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1.5 text-sm text-black dark:text-white placeholder:text-gray-400 dark:placeholder:text-gray-500"
                    value={draft?.clientSecret ?? ''}
                    placeholder={
                      entry.hasClientSecret
                        ? t('secretStoredPlaceholder')
                        : t('secretNewPlaceholder')
                    }
                    disabled={!secretSealingAvailable}
                    onChange={(e) =>
                      setDraft(
                        entry.catalogKey,
                        { clientSecret: e.target.value },
                        entry,
                      )
                    }
                  />
                </label>
              </div>

              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40"
                  disabled={
                    savingKey === entry.catalogKey ||
                    !dirty ||
                    clientIdValue.trim() === ''
                  }
                  onClick={() => void save(entry)}
                >
                  {t('save')}
                </button>
                {entry.adminConfigured && (
                  <button
                    type="button"
                    className="rounded-md border border-gray-300 dark:border-gray-600 px-3 py-1 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40"
                    disabled={savingKey === entry.catalogKey}
                    onClick={() => void remove(entry)}
                  >
                    {entry.envConfigured ? t('removeToEnv') : t('remove')}
                  </button>
                )}
                {entry.updatedAt && entry.updatedBy && (
                  <span className="text-[11px] text-gray-500 dark:text-gray-400">
                    {t('updatedBy', {
                      by: entry.updatedBy,
                      at: entry.updatedAt.slice(0, 10),
                    })}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
};
