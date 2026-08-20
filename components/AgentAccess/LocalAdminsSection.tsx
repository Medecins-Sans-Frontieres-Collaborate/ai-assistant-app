'use client';

import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FC, useEffect, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { unwrapApiData } from '@/client/hooks/settings/useAgentAccessAdmin';
import { useM365PeopleSuggest } from '@/client/hooks/useM365PeopleSuggest';

import type { LocalAdminEntry } from '@/lib/services/agentAccess/types';

import { EmailAutocompleteInput } from '@/components/UI/EmailAutocompleteInput';

import { AdminConfigResponse, MergedAgentRow } from './types';

interface LocalAdminsSectionProps {
  /** Merged agent rows from the admin's own discovery + stored rules. */
  rows: MergedAgentRow[];
}

/**
 * Global-admin-only editor for config.json's delegation map: which local
 * admins may manage rules, and for which canonical agent keys. Saved as a
 * whole document with the CAS ETag (If-Match / If-None-Match: *).
 */
export const LocalAdminsSection: FC<LocalAdminsSectionProps> = ({ rows }) => {
  const t = useTranslations('agentAccess');
  const tPeople = useTranslations('peopleSuggest');
  const peopleSuggest = useM365PeopleSuggest();
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery<AdminConfigResponse>({
    queryKey: ['agent-access-config'],
    queryFn: async () => {
      const response = await fetch('/api/agent-access/config');
      if (!response.ok) {
        throw new Error(`Failed to fetch config: ${response.status}`);
      }
      return unwrapApiData<AdminConfigResponse>(await response.json());
    },
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const [localAdmins, setLocalAdmins] = useState<LocalAdminEntry[]>([]);
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isConflict, setIsConflict] = useState(false);
  const [saveError, setSaveError] = useState(false);

  // Seed the editable list from the fetched config; do not clobber unsaved
  // edits when a background refetch lands.
  useEffect(() => {
    if (data && !isDirty) {
      setLocalAdmins(data.config?.localAdmins ?? []);
    }
  }, [data, isDirty]);

  const updateAdmins = (next: LocalAdminEntry[]) => {
    setLocalAdmins(next);
    setIsDirty(true);
    setSaveError(false);
  };

  const handleReload = async () => {
    setIsConflict(false);
    setIsDirty(false);
    await queryClient.invalidateQueries({ queryKey: ['agent-access-config'] });
    await refetch();
  };

  const handleSave = async () => {
    setIsSaving(true);
    setSaveError(false);
    try {
      const response = await fetch('/api/agent-access/config', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(data?.etag
            ? { 'If-Match': data.etag }
            : { 'If-None-Match': '*' }),
        },
        body: JSON.stringify({
          localAdmins: localAdmins.filter((a) => a.email.trim().length > 0),
        }),
      });
      if (response.status === 409) {
        setIsConflict(true);
        return;
      }
      if (!response.ok) {
        setSaveError(true);
        return;
      }
      toast.success(t('configSaveSuccess'));
      setIsDirty(false);
      await queryClient.invalidateQueries({
        queryKey: ['agent-access-config'],
      });
      // Delegations changed — admin status of affected users may too.
      await queryClient.invalidateQueries({ queryKey: ['agent-access-me'] });
    } catch {
      setSaveError(true);
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">{t('loading')}</p>
    );
  }

  if (error) {
    return (
      <div className="text-sm text-red-600 dark:text-red-400">
        <p>{t('loadError')}</p>
        <button
          type="button"
          className="mt-2 rounded-md border border-gray-300 dark:border-gray-600 px-3 py-1 text-sm text-black dark:text-white hover:bg-gray-100 dark:hover:bg-gray-800"
          onClick={() => refetch()}
        >
          {t('retry')}
        </button>
      </div>
    );
  }

  const knownKeys = new Set(rows.map((row) => row.canonicalKey));

  return (
    <div>
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        {t('localAdminsDescription')}
      </p>

      {localAdmins.length === 0 && (
        <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
          {t('noLocalAdmins')}
        </p>
      )}

      <div className="space-y-4">
        {localAdmins.map((admin, index) => (
          <div
            key={index}
            className="rounded-lg border border-gray-200 dark:border-gray-700 p-4"
          >
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <label className="mb-1 block text-sm font-medium text-black dark:text-white">
                  {t('emailLabel')}
                </label>
                <EmailAutocompleteInput
                  className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm text-black dark:text-white placeholder:text-gray-400 dark:placeholder:text-gray-500"
                  value={admin.email}
                  placeholder={t('emailPlaceholder')}
                  suggest={peopleSuggest}
                  suggestionsLabel={tPeople('listLabel')}
                  onChange={(email) =>
                    updateAdmins(
                      localAdmins.map((a, i) =>
                        i === index ? { ...a, email } : a,
                      ),
                    )
                  }
                />
              </div>
              <button
                type="button"
                className="mt-6 rounded-md p-1.5 text-gray-500 hover:bg-red-50 hover:text-red-600 dark:text-gray-400 dark:hover:bg-red-900/20 dark:hover:text-red-400"
                onClick={() =>
                  updateAdmins(localAdmins.filter((_, i) => i !== index))
                }
                aria-label={t('removeAdmin')}
                title={t('removeAdmin')}
              >
                <IconTrash size={16} />
              </button>
            </div>

            <div className="mt-3">
              <span className="mb-1 block text-sm font-medium text-black dark:text-white">
                {t('delegatedAgentsLabel')}
              </span>
              {rows.length === 0 && admin.agentKeys.length === 0 ? (
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {t('noDelegatedAgents')}
                </p>
              ) : (
                <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-gray-200 dark:border-gray-700 p-2">
                  {rows.map((row) => (
                    <label
                      key={row.canonicalKey}
                      className="flex cursor-pointer items-center gap-2"
                    >
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-gray-600 dark:accent-gray-400"
                        checked={admin.agentKeys.includes(row.canonicalKey)}
                        onChange={(e) =>
                          updateAdmins(
                            localAdmins.map((a, i) =>
                              i === index
                                ? {
                                    ...a,
                                    agentKeys: e.target.checked
                                      ? [...a.agentKeys, row.canonicalKey]
                                      : a.agentKeys.filter(
                                          (k) => k !== row.canonicalKey,
                                        ),
                                  }
                                : a,
                            ),
                          )
                        }
                      />
                      <span className="truncate text-sm text-black dark:text-gray-200">
                        {row.displayName}
                      </span>
                      <span
                        className="truncate text-xs text-gray-500 dark:text-gray-400"
                        title={row.source}
                      >
                        {row.agentName}
                      </span>
                    </label>
                  ))}
                  {/* Delegated keys not present in this admin's own list
                      (agent renamed, or outside their discovery). */}
                  {admin.agentKeys
                    .filter((key) => !knownKeys.has(key))
                    .map((key) => (
                      <label
                        key={key}
                        className="flex cursor-pointer items-center gap-2"
                      >
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-gray-600 dark:accent-gray-400"
                          checked
                          onChange={() =>
                            updateAdmins(
                              localAdmins.map((a, i) =>
                                i === index
                                  ? {
                                      ...a,
                                      agentKeys: a.agentKeys.filter(
                                        (k) => k !== key,
                                      ),
                                    }
                                  : a,
                              ),
                            )
                          }
                        />
                        <span
                          className="truncate text-sm italic text-gray-500 dark:text-gray-400"
                          title={key}
                        >
                          {t('unknownAgentKey')}: {key}
                        </span>
                      </label>
                    ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <button
        type="button"
        className="mt-4 flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-black dark:text-white hover:bg-gray-100 dark:hover:bg-gray-800"
        onClick={() =>
          updateAdmins([...localAdmins, { email: '', agentKeys: [] }])
        }
      >
        <IconPlus size={16} />
        {t('addLocalAdmin')}
      </button>

      {isConflict && (
        <div className="mt-4 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-800 dark:text-amber-300">
          <p>{t('configConflictError')}</p>
          <button
            type="button"
            className="mt-2 rounded-md bg-amber-600 px-3 py-1 text-sm font-medium text-white hover:bg-amber-700"
            onClick={handleReload}
          >
            {t('reload')}
          </button>
        </div>
      )}

      {saveError && !isConflict && (
        <p className="mt-4 text-sm text-red-600 dark:text-red-400">
          {t('saveError')}
        </p>
      )}

      <div className="mt-6 flex justify-end">
        <button
          type="button"
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          onClick={handleSave}
          disabled={isSaving || isConflict || !isDirty}
        >
          {isSaving ? t('saving') : t('save')}
        </button>
      </div>
    </div>
  );
};
