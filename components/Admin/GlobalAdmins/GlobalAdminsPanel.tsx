'use client';

import {
  IconAlertTriangle,
  IconPlus,
  IconShieldLock,
  IconTrash,
} from '@tabler/icons-react';
import { FC, KeyboardEvent, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import {
  GlobalAdminsConflict,
  GlobalAdminsLockout,
  GlobalAdminsResponse,
  useGlobalAdmins,
} from '@/client/hooks/settings/useGlobalAdmins';
import { useM365PeopleSuggest } from '@/client/hooks/useM365PeopleSuggest';

import { normalizeAdminMail } from '@/lib/services/admin/globalAdminsTypes';

import {
  ADMIN_BANNER_ERROR,
  ADMIN_BANNER_WARN,
  ADMIN_BTN_ICON_DANGER,
  ADMIN_BTN_PRIMARY,
  ADMIN_BTN_RETRY,
  ADMIN_BTN_SECONDARY,
  ADMIN_CARD,
  ADMIN_CHIP_NEUTRAL,
  ADMIN_FIELD,
  ADMIN_HEADING,
  ADMIN_HINT,
  ADMIN_LABEL,
  ADMIN_MUTED,
  ADMIN_ROW,
} from '@/components/Admin/adminClasses';
import { EmailAutocompleteInput } from '@/components/UI/EmailAutocompleteInput';

interface GlobalAdminsPanelProps {
  /**
   * The editing admin's own mail (from the server session), so the panel can
   * warn BEFORE Save when a draft removes them. null when the session has no
   * mail — the warning is then simply not shown.
   */
  currentMail: string | null;
}

/**
 * Editor for the config-based global admin roster
 * (docs/LIMITS_SCOPED_ADMINS_DESIGN.md §13; `system/admin/global-admins.json`).
 *
 * Two lists, one editable:
 *  - env admins (`AGENT_ACCESS_ADMINS`) are shown READ-ONLY as "set by
 *    deployment" — they are the un-lockable bootstrap and no runtime write can
 *    remove them;
 *  - config admins are the editable list, saved as a whole document under
 *    `If-Match`. A 409 means another admin saved first: toast + refetch, the
 *    draft is replaced by the current roster. A lockout (both lists empty) is
 *    predicted client-side (Save disabled + banner) and, if it still reaches
 *    the server, its `GLOBAL_ADMINS_LOCKOUT` is surfaced as its own message.
 *
 * The server component gates access on the EFFECTIVE identity; this client is
 * presentation only. No synchronous setState in effects: the draft is seeded
 * from each NEW server response during render (the WorkflowPolicyPanel
 * pattern), so a reload after a 409 replaces the stale draft in the same pass.
 */
export const GlobalAdminsPanel: FC<GlobalAdminsPanelProps> = ({
  currentMail,
}) => {
  const t = useTranslations('globalAdmins');
  const tPeople = useTranslations('peopleSuggest');
  const peopleSuggest = useM365PeopleSuggest();
  const { query, save } = useGlobalAdmins();

  const [draft, setDraft] = useState<string[]>([]);
  const [etag, setEtag] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [newMail, setNewMail] = useState('');
  const [addError, setAddError] = useState<'invalid' | 'duplicate' | null>(
    null,
  );
  const [seededFrom, setSeededFrom] = useState<GlobalAdminsResponse | null>(
    null,
  );
  if (query.data && query.data !== seededFrom) {
    setSeededFrom(query.data);
    setEtag(query.data.etag);
    setDraft(query.data.roster?.admins ?? []);
    setDirty(false);
  }

  const envAdmins = query.data?.envAdmins ?? [];
  const normalizedCurrent = currentMail
    ? normalizeAdminMail(currentMail)
    : null;
  const wouldLockOut = draft.length === 0 && envAdmins.length === 0;
  const removesSelf =
    normalizedCurrent !== null &&
    !envAdmins.includes(normalizedCurrent) &&
    !draft.includes(normalizedCurrent);

  const addMail = () => {
    const mail = normalizeAdminMail(newMail);
    if (mail.length < 3 || !mail.includes('@')) {
      setAddError('invalid');
      return;
    }
    if (draft.includes(mail)) {
      setAddError('duplicate');
      return;
    }
    setDraft([...draft, mail]);
    setDirty(true);
    setNewMail('');
    setAddError(null);
  };

  const removeMail = (mail: string) => {
    setDraft(draft.filter((m) => m !== mail));
    setDirty(true);
  };

  const handleAddKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // The autocomplete swallows Enter only while its listbox is open, so a
    // plain Enter here commits the typed address.
    if (e.key === 'Enter') {
      e.preventDefault();
      addMail();
    }
  };

  const handleSave = async () => {
    try {
      const result = await save.mutateAsync({ admins: draft, etag });
      setEtag(result.etag);
      setDirty(false);
      toast.success(t('saved'));
    } catch (error) {
      if (error instanceof GlobalAdminsConflict) {
        toast.error(t('conflict'));
        await query.refetch();
        return;
      }
      if (error instanceof GlobalAdminsLockout) {
        toast.error(t('lockout'));
        return;
      }
      toast.error(t('saveFailed'));
    }
  };

  const handleDiscard = () => {
    setDraft(query.data?.roster?.admins ?? []);
    setDirty(false);
    setNewMail('');
    setAddError(null);
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

  const roster = query.data.roster;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-black dark:text-white">
          <IconShieldLock size={20} aria-hidden />
          {t('title')}
        </h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
          {t('description')}
        </p>
        <p className={ADMIN_HINT}>{t('propagationNote')}</p>
      </header>

      <section className={ADMIN_CARD}>
        <h3 className={ADMIN_HEADING}>{t('envSection')}</h3>
        <p className={ADMIN_HINT}>{t('envHint')}</p>
        {envAdmins.length === 0 ? (
          <p className={`mt-2 ${ADMIN_MUTED}`}>{t('envEmpty')}</p>
        ) : (
          <ul
            className="mt-2 flex flex-wrap gap-2"
            aria-label={t('envSection')}
          >
            {envAdmins.map((mail) => (
              <li key={mail} className={`${ADMIN_CHIP_NEUTRAL} font-mono`}>
                {mail}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={ADMIN_CARD}>
        <h3 className={ADMIN_HEADING}>{t('configSection')}</h3>
        <p className={ADMIN_HINT}>{t('configHint')}</p>

        {draft.length === 0 ? (
          <p className={`mt-3 ${ADMIN_MUTED}`}>{t('configEmpty')}</p>
        ) : (
          <ul className="mt-3 space-y-2" aria-label={t('configSection')}>
            {draft.map((mail) => (
              <li
                key={mail}
                className={`${ADMIN_ROW} flex items-center justify-between gap-3`}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-sm text-black dark:text-white">
                  {mail}
                </span>
                {envAdmins.includes(mail) && (
                  <span className={ADMIN_CHIP_NEUTRAL}>{t('alsoInEnv')}</span>
                )}
                <button
                  type="button"
                  className={ADMIN_BTN_ICON_DANGER}
                  aria-label={`${t('remove')} ${mail}`}
                  onClick={() => removeMail(mail)}
                  disabled={save.isPending}
                >
                  <IconTrash size={16} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4">
          <label htmlFor="global-admins-add" className={ADMIN_LABEL}>
            {t('addLabel')}
          </label>
          <div className="flex items-start gap-2">
            <EmailAutocompleteInput
              id="global-admins-add"
              className={ADMIN_FIELD}
              placeholder={t('addPlaceholder')}
              value={newMail}
              onChange={(value) => {
                setNewMail(value);
                setAddError(null);
              }}
              onKeyDown={handleAddKeyDown}
              suggest={peopleSuggest}
              suggestionsLabel={tPeople('listLabel')}
              disabled={save.isPending}
              aria-invalid={addError !== null || undefined}
              aria-describedby={
                addError ? 'global-admins-add-error' : undefined
              }
            />
            <button
              type="button"
              className={ADMIN_BTN_SECONDARY}
              onClick={addMail}
              disabled={save.isPending || newMail.trim().length === 0}
            >
              <IconPlus size={16} aria-hidden />
              {t('add')}
            </button>
          </div>
          {addError && (
            <p
              id="global-admins-add-error"
              role="alert"
              className="mt-1 text-xs text-red-600 dark:text-red-400"
            >
              {addError === 'invalid' ? t('invalidMail') : t('duplicateMail')}
            </p>
          )}
          <p className={ADMIN_HINT}>{t('addHint')}</p>
        </div>

        {roster && (
          <p className={`mt-3 ${ADMIN_MUTED}`}>
            {t('updatedByLine', {
              user: roster.updatedBy,
              date: new Date(roster.updatedAt).toLocaleString(),
            })}
          </p>
        )}
      </section>

      {wouldLockOut && (
        <div
          role="alert"
          className={`${ADMIN_BANNER_ERROR} flex items-center gap-3`}
        >
          <IconAlertTriangle size={18} className="shrink-0" aria-hidden />
          <span className="flex-1">{t('lockoutWarning')}</span>
        </div>
      )}

      {!wouldLockOut && removesSelf && dirty && (
        <div
          role="status"
          className={`${ADMIN_BANNER_WARN} flex items-center gap-3`}
        >
          <IconAlertTriangle size={18} className="shrink-0" aria-hidden />
          <span className="flex-1">{t('selfRemovalWarning')}</span>
        </div>
      )}

      <footer className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={ADMIN_BTN_PRIMARY}
          disabled={!dirty || save.isPending || wouldLockOut}
          onClick={handleSave}
        >
          {save.isPending ? t('saving') : t('save')}
        </button>
        <button
          type="button"
          className={ADMIN_BTN_SECONDARY}
          disabled={!dirty || save.isPending}
          onClick={handleDiscard}
        >
          {t('discard')}
        </button>
        {dirty && <span className={ADMIN_MUTED}>{t('unsavedChanges')}</span>}
      </footer>
    </div>
  );
};
