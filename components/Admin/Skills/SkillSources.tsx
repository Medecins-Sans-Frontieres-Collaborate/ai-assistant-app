'use client';

import { IconPlus, IconRefresh, IconTrash } from '@tabler/icons-react';
import { FC, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import {
  SkillSourcesForbidden,
  useSkillSources,
} from '@/client/hooks/settings/useSkillsAdmin';

import type { SkillSource } from '@/lib/services/skills/types';

import {
  ADMIN_BTN_ICON_DANGER,
  ADMIN_BTN_PRIMARY,
  ADMIN_BTN_SECONDARY,
  ADMIN_CHIP_DANGER,
  ADMIN_CHIP_NEUTRAL,
  ADMIN_CHIP_WARN,
  ADMIN_FIELD,
  ADMIN_HEADING,
  ADMIN_HINT,
  ADMIN_LABEL,
  ADMIN_MUTED,
  ADMIN_ROW,
} from '@/components/Admin/adminClasses';

/**
 * External skill catalogs (docs/SKILLS_DESIGN.md §12). Global admins
 * subscribe to an `index.json`; its SKILL.md files become organization
 * skills that refresh on a schedule. Hidden for local admins (the list
 * request answers 403).
 */
export const SkillSources: FC = () => {
  const t = useTranslations('skillsAdmin.sources');
  const { query, add, sync, remove } = useSkillSources();
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');

  if (query.error instanceof SkillSourcesForbidden) return null;
  const sources = query.data?.sources ?? [];

  const handleAdd = async () => {
    try {
      const result = await add.mutateAsync({
        url: url.trim(),
        ...(label.trim() ? { label: label.trim() } : {}),
      });
      setUrl('');
      setLabel('');
      toast.success(
        result.source.lastSyncStatus === 'ok'
          ? t('added', {
              count: result.source.entries.filter(
                (entry) => entry.status === 'synced',
              ).length,
            })
          : t('addedWithError'),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('addError'));
    }
  };

  const handleSync = async (source: SkillSource) => {
    try {
      await sync.mutateAsync({ id: source.id });
      toast.success(t('synced'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('syncError'));
    }
  };

  const handleRemove = async (source: SkillSource) => {
    if (!window.confirm(t('removeConfirm'))) return;
    try {
      await remove.mutateAsync({ id: source.id });
      toast.success(t('removed'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('removeError'));
    }
  };

  const statusChip = (source: SkillSource) => {
    if (!source.lastSyncAt)
      return <span className={ADMIN_CHIP_NEUTRAL}>{t('never')}</span>;
    const conflicts = source.entries.filter(
      (entry) => entry.status !== 'synced',
    ).length;
    if (source.lastSyncStatus === 'error')
      return <span className={ADMIN_CHIP_DANGER}>{t('statusError')}</span>;
    if (conflicts > 0)
      return (
        <span className={ADMIN_CHIP_WARN}>
          {t('statusPartial', { count: conflicts })}
        </span>
      );
    return <span className={ADMIN_CHIP_NEUTRAL}>{t('statusOk')}</span>;
  };

  return (
    <section className="mt-8 space-y-3" data-testid="skill-sources">
      <div>
        <h3 className={ADMIN_HEADING}>{t('title')}</h3>
        <p className={ADMIN_MUTED}>{t('description')}</p>
      </div>

      <div className={ADMIN_ROW}>
        <div className="grid gap-3 md:grid-cols-[1fr_auto_auto] md:items-end">
          <div>
            <label className={ADMIN_LABEL} htmlFor="skill-source-url">
              {t('urlLabel')}
            </label>
            <input
              id="skill-source-url"
              className={ADMIN_FIELD}
              type="url"
              inputMode="url"
              placeholder={t('urlPlaceholder')}
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
            <p className={ADMIN_HINT}>{t('urlHint')}</p>
          </div>
          <div>
            <label className={ADMIN_LABEL} htmlFor="skill-source-label">
              {t('labelLabel')}
            </label>
            <input
              id="skill-source-label"
              className={ADMIN_FIELD}
              type="text"
              maxLength={100}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </div>
          <button
            type="button"
            className={ADMIN_BTN_PRIMARY}
            disabled={!url.trim() || add.isPending}
            onClick={handleAdd}
          >
            <span className="flex items-center gap-1.5">
              <IconPlus size={16} />
              {add.isPending ? t('adding') : t('add')}
            </span>
          </button>
        </div>
      </div>

      {query.isLoading && <p className={ADMIN_MUTED}>{t('loading')}</p>}
      {query.error && !(query.error instanceof SkillSourcesForbidden) && (
        <p className={ADMIN_MUTED}>{t('loadError')}</p>
      )}
      {!query.isLoading && sources.length === 0 && (
        <p className={ADMIN_MUTED}>{t('empty')}</p>
      )}

      {sources.map((source) => (
        <div key={source.id} className={ADMIN_ROW}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-black dark:text-white">
                  {source.label ?? new URL(source.url).host}
                </span>
                {statusChip(source)}
              </div>
              <p className="mt-1 break-all text-xs text-gray-600 dark:text-gray-400">
                {source.url}
              </p>
              <p className={ADMIN_HINT}>
                {source.lastSyncAt
                  ? t('lastSync', {
                      time: new Date(source.lastSyncAt).toLocaleString(),
                    })
                  : t('never')}
                {' · '}
                {t('entryCount', { count: source.entries.length })}
              </p>
              {source.lastError && (
                <p className="mt-1 text-xs text-red-700 dark:text-red-300">
                  {source.lastError}
                </p>
              )}
              {source.entries.some((entry) => entry.status !== 'synced') && (
                <ul className="mt-2 space-y-0.5 text-xs text-gray-700 dark:text-gray-300">
                  {source.entries
                    .filter((entry) => entry.status !== 'synced')
                    .map((entry) => (
                      <li key={entry.id}>
                        <code>{entry.id}</code>:{' '}
                        {t(`entryStatus.${entry.status}`)}
                        {entry.detail ? ` — ${entry.detail}` : ''}
                      </li>
                    ))}
                </ul>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className={ADMIN_BTN_SECONDARY}
                disabled={sync.isPending}
                onClick={() => handleSync(source)}
              >
                <span className="flex items-center gap-1.5">
                  <IconRefresh size={16} />
                  {sync.isPending && sync.variables?.id === source.id
                    ? t('syncing')
                    : t('sync')}
                </span>
              </button>
              <button
                type="button"
                className={ADMIN_BTN_ICON_DANGER}
                aria-label={t('remove')}
                title={t('remove')}
                disabled={remove.isPending}
                onClick={() => handleRemove(source)}
              >
                <IconTrash size={16} />
              </button>
            </div>
          </div>
        </div>
      ))}
    </section>
  );
};
