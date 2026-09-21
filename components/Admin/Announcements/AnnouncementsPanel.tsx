'use client';

import { IconAlertTriangle, IconPlus, IconTrash } from '@tabler/icons-react';
import { FC, useState } from 'react';
import toast from 'react-hot-toast';

import { useLocale, useTranslations } from 'next-intl';

import {
  AnnouncementsRequestError,
  useAnnouncementsAdmin,
} from '@/client/hooks/settings/useAnnouncementsAdmin';

import {
  Announcement,
  hideAfterInstant,
  httpsHostOf,
} from '@/lib/services/announcements/types';

import { getSupportedLocales } from '@/lib/utils/app/locales';

import { AnnouncementEditor } from '@/components/Admin/Announcements/AnnouncementEditor';
import {
  AnnouncementDraft,
  currentSourceHash,
  draftFromAnnouncement,
  emptyDraft,
  localeState,
  toWriteBody,
} from '@/components/Admin/Announcements/announcementDraft';
import {
  ADMIN_BANNER_ERROR,
  ADMIN_BANNER_WARN,
  ADMIN_BTN_ICON_DANGER,
  ADMIN_BTN_PRIMARY,
  ADMIN_BTN_RETRY,
  ADMIN_BTN_SECONDARY,
  ADMIN_CARD,
  ADMIN_CHECKBOX,
  ADMIN_CHIP_NEUTRAL,
  ADMIN_CHIP_WARN,
  ADMIN_FIELD,
  ADMIN_HINT,
  ADMIN_LABEL,
  ADMIN_MUTED,
  ADMIN_ROW,
} from '@/components/Admin/adminClasses';
import Modal from '@/components/UI/Modal';

type LifeState = 'draft' | 'scheduled' | 'live' | 'ended' | 'withdrawn';

function lifeStateOf(announcement: Announcement, now: number): LifeState {
  if (announcement.status !== 'published') return announcement.status;
  if (now < Date.parse(announcement.visibleFrom)) return 'scheduled';
  const hideAfter = hideAfterInstant(announcement);
  const end = Math.min(
    Date.parse(announcement.expiresAt),
    hideAfter ?? Number.POSITIVE_INFINITY,
  );
  return now >= end ? 'ended' : 'live';
}

/**
 * Announcements admin (docs/ADMIN_ANNOUNCEMENTS_DESIGN.md). Global admins see
 * everything; a delegated sender sees only their delegations' records — the
 * server filters the list.
 *
 * Publishing is deliberate: a dialog restates the audience and the window,
 * and asks for a typed word. Publishing to EVERYONE, and publishing something
 * readers cannot close, each add their own explicit acknowledgement — the
 * second confirmation the non-dismissible option calls for.
 */
export const AnnouncementsPanel: FC = () => {
  const t = useTranslations('announcementsAdmin');
  const uiLocale = useLocale();
  // Captured once per mount: list states (scheduled / live / ended) only need
  // to be right as of when the admin opened the page.
  const [now] = useState(() => Date.now());
  const { query, save, remove, translate, allowHost, removeHost } =
    useAnnouncementsAdmin();
  const [draft, setDraft] = useState<AnnouncementDraft | null>(null);
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [confirmWord, setConfirmWord] = useState('');
  const [ackNonDismissible, setAckNonDismissible] = useState(false);
  const [newHost, setNewHost] = useState('');

  const fail = (error: unknown, fallback: string) => {
    if (error instanceof AnnouncementsRequestError) {
      toast.error(
        error.details ? `${error.message} (${error.details})` : error.message,
      );
      return;
    }
    toast.error(fallback);
  };

  if (query.isLoading) {
    return <p className={`p-6 ${ADMIN_MUTED}`}>{t('loading')}</p>;
  }
  if (query.isError || !query.data) {
    return (
      <div className="p-6">
        <div className={`${ADMIN_BANNER_ERROR} flex items-center gap-3`}>
          <span className="flex-1">{t('loadError')}</span>
          <button
            type="button"
            className={ADMIN_BTN_RETRY}
            onClick={() => query.refetch()}
          >
            {t('retry')}
          </button>
        </div>
      </div>
    );
  }

  const { announcements, allowedLinkHosts, delegations, isGlobalAdmin } =
    query.data;
  const labelOf = (id: string | undefined) =>
    id ? delegations.find((d) => d.id === id)?.label || id : t('orgWide');
  const format = (iso: string) =>
    new Date(iso).toLocaleString(uiLocale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });

  const startNew = () => {
    const sourceLocale = getSupportedLocales().includes(uiLocale)
      ? uiLocale
      : 'en';
    setFailures({});
    setDraft(
      emptyDraft(sourceLocale, isGlobalAdmin ? '' : (delegations[0]?.id ?? '')),
    );
  };

  const persist = async (
    status: Announcement['status'],
    confirmations = { everyone: false, nonDismissible: false },
  ) => {
    if (!draft) return;
    try {
      const result = await save.mutateAsync({
        id: draft.id,
        body: toWriteBody(draft, status, confirmations),
      });
      toast.success(
        status === 'published' ? t('publishSuccess') : t('saveSuccess'),
      );
      setDraft(draftFromAnnouncement(result.announcement));
      setConfirming(false);
      if (status !== 'draft') setDraft(null);
    } catch (error) {
      fail(error, t('saveError'));
    }
  };

  const runTranslate = async (targetLocales?: string[]) => {
    if (!draft) return;
    const source = draft.content[draft.sourceLocale];
    try {
      const outcome = await translate.mutateAsync({
        sourceLocale: draft.sourceLocale,
        title: source.title.trim(),
        body: source.body.trim(),
        ...(source.actionLabel.trim()
          ? { actionLabel: source.actionLabel.trim() }
          : {}),
        variableNames: draft.variables.map((v) => v.name),
        ...(targetLocales ? { targetLocales } : {}),
      });
      const hash = currentSourceHash(draft);
      const content = { ...draft.content };
      for (const [locale, value] of Object.entries(outcome.translations)) {
        // A reviewed (hand-edited) translation is never overwritten by a
        // bulk run unless it was explicitly asked for as outdated.
        if (
          !targetLocales &&
          content[locale]?.origin === 'human' &&
          localeState(draft, locale) === 'human'
        ) {
          continue;
        }
        content[locale] = {
          title: value.title,
          body: value.body,
          actionLabel: value.actionLabel ?? '',
          origin: 'ai',
          sourceHash: hash,
        };
      }
      setDraft({ ...draft, content });
      setFailures(outcome.failures);
      const failed = Object.keys(outcome.failures).length;
      if (failed > 0) {
        toast.error(t('translateSomeFailed', { count: failed }));
      } else {
        toast.success(t('translateSuccess'));
      }
    } catch (error) {
      fail(error, t('translateError'));
    }
  };

  // ---- Editor view --------------------------------------------------------
  if (draft) {
    const outdated = getSupportedLocales().filter((locale) =>
      ['stale', 'missing'].includes(localeState(draft, locale)),
    ).length;
    const toEveryone = draft.everyone && !draft.delegationId;
    const publishWord = t('confirmWord');
    const canConfirm =
      confirmWord.trim().toUpperCase() === publishWord.toUpperCase() &&
      (draft.dismissible || ackNonDismissible);

    return (
      <div className="mx-auto max-w-4xl space-y-5 p-6">
        <header className="flex flex-wrap items-center gap-3">
          <h2 className="flex-1 text-lg font-semibold text-black dark:text-white">
            {draft.id ? t('editTitle') : t('newTitle')}
          </h2>
          <button
            type="button"
            className={ADMIN_BTN_SECONDARY}
            onClick={() => setDraft(null)}
          >
            {t('back')}
          </button>
        </header>

        <AnnouncementEditor
          draft={draft}
          onChange={setDraft}
          delegations={delegations}
          isGlobalAdmin={isGlobalAdmin}
          allowedLinkHosts={allowedLinkHosts}
          translating={translate.isPending}
          translationFailures={failures}
          onTranslate={runTranslate}
        />

        <div className="flex flex-wrap items-center gap-3">
          {/* Not offered on a LIVE announcement: saving it "as a draft" would
              silently unpublish it. Withdraw is the explicit way to do that. */}
          {draft.status !== 'published' && (
            <button
              type="button"
              className={ADMIN_BTN_SECONDARY}
              disabled={save.isPending}
              onClick={() => persist('draft')}
            >
              {t('saveDraft')}
            </button>
          )}
          <button
            type="button"
            className={ADMIN_BTN_PRIMARY}
            disabled={save.isPending}
            onClick={() => {
              setConfirmWord('');
              setAckNonDismissible(false);
              setConfirming(true);
            }}
          >
            {draft.status === 'published' ? t('publishChanges') : t('publish')}
          </button>
          {draft.id && draft.status === 'published' && (
            <button
              type="button"
              className={ADMIN_BTN_SECONDARY}
              disabled={save.isPending}
              onClick={() => persist('withdrawn')}
            >
              {t('withdraw')}
            </button>
          )}
        </div>

        <Modal
          isOpen={confirming}
          onClose={() => setConfirming(false)}
          title={t('confirmTitle')}
          size="sm"
        >
          <div className="space-y-3 text-sm text-gray-800 dark:text-gray-200">
            <p>
              {t('confirmAudience', {
                audience: toEveryone
                  ? t('audienceEveryone')
                  : draft.delegationId
                    ? labelOf(draft.delegationId)
                    : t('audienceTargeted'),
              })}
            </p>
            <p>
              {t('confirmWindow', {
                from: format(draft.visibleFrom),
                until: format(draft.expiresAt),
              })}
            </p>
            {toEveryone && (
              <p className={ADMIN_BANNER_WARN}>{t('confirmEveryone')}</p>
            )}
            {outdated > 0 && (
              <p className={ADMIN_BANNER_WARN}>
                {t('confirmOutdated', { count: outdated })}
              </p>
            )}
            {!draft.dismissible && (
              <label className={`${ADMIN_BANNER_WARN} flex items-start gap-2`}>
                <input
                  type="checkbox"
                  className={`${ADMIN_CHECKBOX} mt-0.5`}
                  checked={ackNonDismissible}
                  onChange={(e) => setAckNonDismissible(e.target.checked)}
                />
                <span>{t('confirmNonDismissible')}</span>
              </label>
            )}
            <label className="block">
              <span className={ADMIN_LABEL}>
                {t('confirmType', { word: publishWord })}
              </span>
              <input
                className={`${ADMIN_FIELD} w-full`}
                value={confirmWord}
                autoComplete="off"
                onChange={(e) => setConfirmWord(e.target.value)}
              />
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className={ADMIN_BTN_SECONDARY}
                onClick={() => setConfirming(false)}
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                className={ADMIN_BTN_PRIMARY}
                disabled={!canConfirm || save.isPending}
                onClick={() =>
                  persist('published', {
                    everyone: toEveryone,
                    nonDismissible: !draft.dismissible,
                  })
                }
              >
                {t('publish')}
              </button>
            </div>
          </div>
        </Modal>
      </div>
    );
  }

  // ---- List view ------------------------------------------------------------
  const sorted = [...announcements].sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-black dark:text-white">
            {t('title')}
          </h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
            {isGlobalAdmin ? t('description') : t('descriptionDelegated')}
          </p>
        </div>
        <button
          type="button"
          className={ADMIN_BTN_PRIMARY}
          disabled={!isGlobalAdmin && delegations.length === 0}
          onClick={startNew}
        >
          <IconPlus size={16} />
          {t('new')}
        </button>
      </header>

      {query.data.unavailable && (
        <div className={`${ADMIN_BANNER_WARN} flex items-center gap-3`}>
          <IconAlertTriangle size={18} className="shrink-0" aria-hidden />
          <span className="flex-1">{t('unavailable')}</span>
        </div>
      )}

      <section className={ADMIN_CARD}>
        {sorted.length === 0 && <p className={ADMIN_MUTED}>{t('empty')}</p>}
        <ul className="space-y-2">
          {sorted.map((announcement) => {
            const state = lifeStateOf(announcement, now);
            const source = announcement.content[announcement.sourceLocale];
            const host = httpsHostOf(announcement.action?.url);
            const hostPending =
              Boolean(announcement.delegationId) &&
              host !== null &&
              !allowedLinkHosts.includes(host);
            return (
              <li key={announcement.id} className={`${ADMIN_ROW} space-y-2`}>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-sm font-medium text-black hover:underline dark:text-white"
                    onClick={() => {
                      setFailures({});
                      setDraft(draftFromAnnouncement(announcement));
                    }}
                  >
                    {source?.title || announcement.id}
                  </button>
                  <span
                    className={
                      state === 'live' ? ADMIN_CHIP_WARN : ADMIN_CHIP_NEUTRAL
                    }
                  >
                    {t(`state.${state}`)}
                  </span>
                  <span className={ADMIN_CHIP_NEUTRAL}>
                    {labelOf(announcement.delegationId)}
                  </span>
                  {!announcement.dismissible && (
                    <span className={ADMIN_CHIP_WARN}>
                      {t('nonDismissibleChip')}
                    </span>
                  )}
                  <button
                    type="button"
                    className={ADMIN_BTN_ICON_DANGER}
                    aria-label={t('delete')}
                    disabled={remove.isPending}
                    onClick={async () => {
                      if (!window.confirm(t('deleteConfirm'))) return;
                      try {
                        await remove.mutateAsync(announcement.id);
                        toast.success(t('deleteSuccess'));
                      } catch (error) {
                        fail(error, t('saveError'));
                      }
                    }}
                  >
                    <IconTrash size={16} />
                  </button>
                </div>
                <p className={ADMIN_MUTED}>
                  {t('windowSummary', {
                    from: format(announcement.visibleFrom),
                    until: format(announcement.expiresAt),
                  })}{' '}
                  ·{' '}
                  {announcement.audience.kind === 'everyone'
                    ? announcement.delegationId
                      ? t('audienceJurisdiction')
                      : t('audienceEveryone')
                    : t('audienceTargeted')}{' '}
                  · {announcement.updatedBy}
                </p>
                {hostPending && (
                  <div
                    className={`${ADMIN_BANNER_WARN} flex flex-wrap items-center gap-3`}
                  >
                    <span className="flex-1">
                      {t('hostPendingRow', { host })}
                    </span>
                    {isGlobalAdmin && (
                      <button
                        type="button"
                        className={ADMIN_BTN_SECONDARY}
                        disabled={allowHost.isPending}
                        onClick={async () => {
                          try {
                            const result = await allowHost.mutateAsync({
                              announcementId: announcement.id,
                            });
                            toast.success(
                              t('hostAllowed', { host: result.host }),
                            );
                          } catch (error) {
                            fail(error, t('saveError'));
                          }
                        }}
                      >
                        {t('allowHost', { host })}
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section className={`${ADMIN_CARD} space-y-3`}>
        <div>
          <p className={ADMIN_LABEL}>{t('allowedHosts')}</p>
          <p className={ADMIN_HINT}>{t('allowedHostsHint')}</p>
        </div>
        {allowedLinkHosts.length === 0 && (
          <p className={ADMIN_MUTED}>{t('allowedHostsEmpty')}</p>
        )}
        <div className="flex flex-wrap gap-1.5">
          {allowedLinkHosts.map((host) => (
            <span key={host} className={ADMIN_CHIP_NEUTRAL}>
              {host}
              {isGlobalAdmin && (
                <button
                  type="button"
                  className="ml-1"
                  aria-label={t('removeHost', { host })}
                  onClick={async () => {
                    try {
                      await removeHost.mutateAsync(host);
                    } catch (error) {
                      fail(error, t('saveError'));
                    }
                  }}
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
        {isGlobalAdmin && (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!newHost.trim()) return;
              try {
                await allowHost.mutateAsync({ host: newHost.trim() });
                setNewHost('');
              } catch (error) {
                fail(error, t('saveError'));
              }
            }}
          >
            <input
              aria-label={t('addHost')}
              className={`${ADMIN_FIELD} min-w-[14rem] flex-1`}
              value={newHost}
              placeholder="intranet.example.org"
              onChange={(e) => setNewHost(e.target.value)}
            />
            <button
              type="submit"
              className={ADMIN_BTN_SECONDARY}
              disabled={allowHost.isPending}
            >
              {t('addHost')}
            </button>
          </form>
        )}
      </section>
    </div>
  );
};
