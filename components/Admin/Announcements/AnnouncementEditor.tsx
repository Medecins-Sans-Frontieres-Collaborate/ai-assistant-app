'use client';

import {
  IconAlertTriangle,
  IconLanguage,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import { FC, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import { AnnouncementsAdminDelegation } from '@/client/hooks/settings/useAnnouncementsAdmin';

import {
  AnnouncementVariable,
  MAX_NON_DISMISSIBLE_HOURS,
  MAX_VARIABLES,
  SOURCE_ACTION_LABEL_CHARS,
  SOURCE_BODY_CHARS,
  SOURCE_TITLE_CHARS,
  VARIABLE_NAME_RE,
  httpsHostOf,
  placeholdersOf,
} from '@/lib/services/announcements/types';

import { formatAnnouncementText } from '@/lib/utils/app/announcements/formatVariables';
import { getSupportedLocales, localeToAutonym } from '@/lib/utils/app/locales';

import {
  AnnouncementDraft,
  LocaleState,
  currentSourceHash,
  fromLocalInput,
  localeState,
  newVariable,
  sourceOf,
  toLocalInput,
} from '@/components/Admin/Announcements/announcementDraft';
import { PredicateListEditor } from '@/components/Admin/Delegations/PredicateListEditor';
import {
  ADMIN_BANNER_WARN,
  ADMIN_BTN_ICON_DANGER,
  ADMIN_BTN_SECONDARY,
  ADMIN_CARD,
  ADMIN_CHECKBOX,
  ADMIN_CHIP_NEUTRAL,
  ADMIN_CHIP_WARN,
  ADMIN_FIELD,
  ADMIN_HINT,
  ADMIN_LABEL,
  ADMIN_MUTED,
} from '@/components/Admin/adminClasses';

const PREVIEW_ZONES = ['UTC', 'Europe/Paris', 'Asia/Dhaka', 'America/New_York'];

interface AnnouncementEditorProps {
  draft: AnnouncementDraft;
  onChange: (next: AnnouncementDraft) => void;
  delegations: AnnouncementsAdminDelegation[];
  isGlobalAdmin: boolean;
  allowedLinkHosts: string[];
  translating: boolean;
  /** Locales the last Translate run could not produce, with the reason. */
  translationFailures: Record<string, string>;
  onTranslate: (targetLocales?: string[]) => void;
}

function CharCount({ value, max }: { value: string; max: number }) {
  return (
    <span
      className={`ml-2 text-[11px] ${
        value.length > max
          ? 'text-red-600 dark:text-red-400'
          : 'text-gray-400 dark:text-gray-500'
      }`}
    >
      {value.length}/{max}
    </span>
  );
}

/**
 * The announcement form (docs/ADMIN_ANNOUNCEMENTS_DESIGN.md §4-§6, §9):
 * source text with managed lengths, typed time variables, audience, window,
 * the non-dismissible warning, AI localization with per-language review, and
 * a preview in any language and timezone. Saving and the publish
 * confirmations belong to the panel; this component only edits the draft.
 */
export const AnnouncementEditor: FC<AnnouncementEditorProps> = ({
  draft,
  onChange,
  delegations,
  isGlobalAdmin,
  allowedLinkHosts,
  translating,
  translationFailures,
  onTranslate,
}) => {
  const t = useTranslations('announcementsAdmin');
  const tBanner = useTranslations('announcements');
  const locales = useMemo(() => getSupportedLocales(), []);
  const [previewLocale, setPreviewLocale] = useState(draft.sourceLocale);
  const [previewZone, setPreviewZone] = useState(PREVIEW_ZONES[1]);
  const [openLocale, setOpenLocale] = useState<string | null>(null);

  const source = sourceOf(draft);
  const set = (change: Partial<AnnouncementDraft>) =>
    onChange({ ...draft, ...change });
  const setSource = (change: Partial<typeof source>) =>
    set({
      content: {
        ...draft.content,
        [draft.sourceLocale]: { ...source, ...change, origin: 'source' },
      },
    });

  const delegated = Boolean(draft.delegationId);
  const host = httpsHostOf(draft.actionUrl.trim());
  const hostPending =
    delegated && host !== null && !allowedLinkHosts.includes(host);
  const undeclared = placeholdersOf(
    `${source.title} ${source.body} ${source.actionLabel}`,
  ).filter((name) => !draft.variables.some((v) => v.name === name));

  const states = useMemo(() => {
    const result: Record<string, LocaleState> = {};
    for (const locale of locales) result[locale] = localeState(draft, locale);
    return result;
  }, [draft, locales]);
  const count = (state: LocaleState) =>
    Object.values(states).filter((s) => s === state).length;

  const addVariable = (type: AnnouncementVariable['type']) => {
    const variable = newVariable(
      type,
      draft.variables.map((v) => v.name),
    );
    set({
      variables: [...draft.variables, variable],
      // The first time variable is the natural "hide when the event ends".
      hideAfterVariable:
        draft.hideAfterVariable || type === 'date'
          ? draft.hideAfterVariable
          : variable.name,
    });
  };

  const updateVariable = (index: number, next: AnnouncementVariable) =>
    set({
      variables: draft.variables.map((v, i) => (i === index ? next : v)),
      hideAfterVariable:
        draft.hideAfterVariable === draft.variables[index].name
          ? next.type === 'date'
            ? ''
            : next.name
          : draft.hideAfterVariable,
    });

  const preview = draft.content[previewLocale] ?? source;
  const renderPreview = (text: string) =>
    formatAnnouncementText(text, draft.variables, {
      locale: previewLocale,
      timeZone: previewZone,
      localTimeTemplate: tBanner('localTime', { time: '{time}' }),
    });

  return (
    <div className="space-y-5">
      {/* Source text ---------------------------------------------------- */}
      <section className={`${ADMIN_CARD} space-y-3`}>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-black dark:text-white">
            {t('sourceLanguage')}
            <select
              className={ADMIN_FIELD}
              value={draft.sourceLocale}
              onChange={(e) => {
                const next = e.target.value;
                set({
                  sourceLocale: next,
                  content: {
                    ...draft.content,
                    [next]: {
                      ...(draft.content[next] ?? source),
                      origin: 'source',
                    },
                  },
                });
                setPreviewLocale(next);
              }}
            >
              {locales.map((locale) => (
                <option key={locale} value={locale}>
                  {localeToAutonym[locale]} ({locale})
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="block">
          <span className={ADMIN_LABEL}>
            {t('titleField')}
            <CharCount value={source.title} max={SOURCE_TITLE_CHARS} />
          </span>
          <input
            className={`${ADMIN_FIELD} w-full`}
            value={source.title}
            onChange={(e) => setSource({ title: e.target.value })}
          />
        </label>
        <label className="block">
          <span className={ADMIN_LABEL}>
            {t('bodyField')}
            <CharCount value={source.body} max={SOURCE_BODY_CHARS} />
          </span>
          <textarea
            className={`${ADMIN_FIELD} w-full`}
            rows={3}
            value={source.body}
            onChange={(e) => setSource({ body: e.target.value })}
          />
          <span className={ADMIN_HINT}>{t('lengthHint')}</span>
        </label>
        {undeclared.length > 0 && (
          <p className={ADMIN_BANNER_WARN} role="alert">
            {t('undeclaredVariables', {
              names: undeclared.map((n) => `{${n}}`).join(', '),
            })}
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className={ADMIN_LABEL}>{t('linkUrl')}</span>
            <input
              type="url"
              className={`${ADMIN_FIELD} w-full`}
              value={draft.actionUrl}
              placeholder="https://"
              onChange={(e) => set({ actionUrl: e.target.value })}
            />
          </label>
          <label className="block">
            <span className={ADMIN_LABEL}>
              {t('linkLabel')}
              <CharCount
                value={source.actionLabel}
                max={SOURCE_ACTION_LABEL_CHARS}
              />
            </span>
            <input
              className={`${ADMIN_FIELD} w-full`}
              value={source.actionLabel}
              onChange={(e) => setSource({ actionLabel: e.target.value })}
            />
          </label>
        </div>
        <p className={ADMIN_HINT}>{t('linkHint')}</p>
        {draft.actionUrl.trim() && host === null && (
          <p className={ADMIN_BANNER_WARN} role="alert">
            {t('linkInvalid')}
          </p>
        )}
        {hostPending && (
          <p className={ADMIN_BANNER_WARN} role="status">
            {isGlobalAdmin
              ? t('hostPendingGlobal', { host })
              : t('hostPendingDelegated', { host })}
          </p>
        )}
      </section>

      {/* Variables ------------------------------------------------------- */}
      <section className={`${ADMIN_CARD} space-y-3`}>
        <div>
          <p className={ADMIN_LABEL}>{t('variables')}</p>
          <p className={ADMIN_HINT}>{t('variablesHint')}</p>
        </div>
        {draft.variables.map((variable, index) => {
          const nameValid = VARIABLE_NAME_RE.test(variable.name);
          return (
            <div
              key={index}
              className="flex flex-wrap items-end gap-2 border-t border-gray-200 pt-3 first:border-t-0 first:pt-0 dark:border-gray-700"
            >
              <label className="block">
                <span className={ADMIN_MUTED}>{t('variableName')}</span>
                <input
                  className={`${ADMIN_FIELD} block w-28 font-mono text-xs ${
                    nameValid ? '' : 'ring-1 ring-red-500'
                  }`}
                  value={variable.name}
                  onChange={(e) =>
                    updateVariable(index, { ...variable, name: e.target.value })
                  }
                />
              </label>
              {variable.type === 'instant' && (
                <label className="block">
                  <span className={ADMIN_MUTED}>{t('variableAt')}</span>
                  <input
                    type="datetime-local"
                    className={`${ADMIN_FIELD} block`}
                    value={toLocalInput(variable.at)}
                    onChange={(e) => {
                      const at = fromLocalInput(e.target.value);
                      if (at) updateVariable(index, { ...variable, at });
                    }}
                  />
                </label>
              )}
              {variable.type === 'timeRange' && (
                <>
                  <label className="block">
                    <span className={ADMIN_MUTED}>{t('variableFrom')}</span>
                    <input
                      type="datetime-local"
                      className={`${ADMIN_FIELD} block`}
                      value={toLocalInput(variable.from)}
                      onChange={(e) => {
                        const from = fromLocalInput(e.target.value);
                        if (from) updateVariable(index, { ...variable, from });
                      }}
                    />
                  </label>
                  <label className="block">
                    <span className={ADMIN_MUTED}>{t('variableTo')}</span>
                    <input
                      type="datetime-local"
                      className={`${ADMIN_FIELD} block`}
                      value={toLocalInput(variable.to)}
                      onChange={(e) => {
                        const to = fromLocalInput(e.target.value);
                        if (to) updateVariable(index, { ...variable, to });
                      }}
                    />
                  </label>
                </>
              )}
              {variable.type === 'date' && (
                <label className="block">
                  <span className={ADMIN_MUTED}>{t('variableOn')}</span>
                  <input
                    type="date"
                    className={`${ADMIN_FIELD} block`}
                    value={variable.on.slice(0, 10)}
                    onChange={(e) => {
                      if (!e.target.value) return;
                      updateVariable(index, {
                        ...variable,
                        on: `${e.target.value}T00:00:00.000Z`,
                      });
                    }}
                  />
                </label>
              )}
              <button
                type="button"
                className={ADMIN_BTN_SECONDARY}
                onClick={() =>
                  setSource({
                    body: `${source.body}${source.body && !source.body.endsWith(' ') ? ' ' : ''}{${variable.name}}`,
                  })
                }
              >
                {t('insertVariable', { name: `{${variable.name}}` })}
              </button>
              <button
                type="button"
                className={ADMIN_BTN_ICON_DANGER}
                aria-label={t('removeVariable')}
                onClick={() =>
                  set({
                    variables: draft.variables.filter((_, i) => i !== index),
                    hideAfterVariable:
                      draft.hideAfterVariable === variable.name
                        ? ''
                        : draft.hideAfterVariable,
                  })
                }
              >
                <IconTrash size={16} />
              </button>
            </div>
          );
        })}
        {draft.variables.length > 0 && (
          <p className={ADMIN_HINT}>{t('variableTimezoneHint')}</p>
        )}
        {draft.variables.length < MAX_VARIABLES && (
          <div className="flex flex-wrap gap-2">
            {(['timeRange', 'instant', 'date'] as const).map((type) => (
              <button
                key={type}
                type="button"
                className={ADMIN_BTN_SECONDARY}
                onClick={() => addVariable(type)}
              >
                <IconPlus size={16} />
                {t(`addVariable.${type}`)}
              </button>
            ))}
          </div>
        )}
        {draft.variables.some((v) => v.type !== 'date') && (
          <label className="flex flex-wrap items-center gap-2 text-sm text-black dark:text-white">
            {t('hideAfter')}
            <select
              className={ADMIN_FIELD}
              value={draft.hideAfterVariable}
              onChange={(e) => set({ hideAfterVariable: e.target.value })}
            >
              <option value="">{t('hideAfterNever')}</option>
              {draft.variables
                .filter((v) => v.type !== 'date')
                .map((v) => (
                  <option key={v.name} value={v.name}>
                    {`{${v.name}}`}
                  </option>
                ))}
            </select>
          </label>
        )}
      </section>

      {/* Audience, window, behaviour ------------------------------------- */}
      <section className={`${ADMIN_CARD} space-y-4`}>
        {(isGlobalAdmin || delegations.length > 1) && !draft.id && (
          <label className="flex flex-wrap items-center gap-2 text-sm text-black dark:text-white">
            {t('sendAs')}
            <select
              className={ADMIN_FIELD}
              value={draft.delegationId}
              onChange={(e) => set({ delegationId: e.target.value })}
            >
              {isGlobalAdmin && <option value="">{t('sendAsOrgWide')}</option>}
              {delegations.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label || d.id}
                </option>
              ))}
            </select>
          </label>
        )}
        {delegated && (
          <p className={ADMIN_HINT}>{t('delegatedAudienceHint')}</p>
        )}

        <div>
          <p className={ADMIN_LABEL}>{t('audience')}</p>
          <div className="mt-1 flex flex-wrap gap-4 text-sm text-black dark:text-white">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="announcement-audience"
                checked={draft.everyone}
                onChange={() => set({ everyone: true })}
              />
              {delegated ? t('audienceJurisdiction') : t('audienceEveryone')}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="announcement-audience"
                checked={!draft.everyone}
                onChange={() =>
                  set({
                    everyone: false,
                    predicates: draft.predicates.length
                      ? draft.predicates
                      : [{ scope: 'domain', text: '' }],
                  })
                }
              />
              {t('audienceTargeted')}
            </label>
          </div>
          {draft.everyone && !delegated && (
            <p className={`mt-2 ${ADMIN_BANNER_WARN}`} role="note">
              <IconAlertTriangle
                size={14}
                className="mr-1 inline"
                aria-hidden
              />
              {t('everyoneWarning')}
            </p>
          )}
          {!draft.everyone && (
            <div className="mt-2">
              <PredicateListEditor
                idPrefix="announcement-audience"
                predicates={draft.predicates}
                onChange={(predicates) => set({ predicates })}
              />
            </div>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className={ADMIN_LABEL}>{t('visibleFrom')}</span>
            <input
              type="datetime-local"
              className={`${ADMIN_FIELD} w-full`}
              value={toLocalInput(draft.visibleFrom)}
              onChange={(e) => {
                const value = fromLocalInput(e.target.value);
                if (value) set({ visibleFrom: value });
              }}
            />
          </label>
          <label className="block">
            <span className={ADMIN_LABEL}>{t('expiresAt')}</span>
            <input
              type="datetime-local"
              className={`${ADMIN_FIELD} w-full`}
              value={toLocalInput(draft.expiresAt)}
              onChange={(e) => {
                const value = fromLocalInput(e.target.value);
                if (value) set({ expiresAt: value });
              }}
            />
          </label>
        </div>
        <p className={ADMIN_HINT}>{t('windowHint')}</p>

        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-black dark:text-white">
            {t('severity')}
            <select
              className={ADMIN_FIELD}
              value={draft.severity}
              onChange={(e) =>
                set({
                  severity: e.target.value as AnnouncementDraft['severity'],
                })
              }
            >
              <option value="info">{t('severityInfo')}</option>
              <option value="warning">{t('severityWarning')}</option>
              {!delegated && (
                <option value="critical">{t('severityCritical')}</option>
              )}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm text-black dark:text-white">
            <input
              type="checkbox"
              className={ADMIN_CHECKBOX}
              checked={!draft.dismissible}
              onChange={(e) => set({ dismissible: !e.target.checked })}
            />
            {t('nonDismissible')}
          </label>
          {draft.id && (
            <label className="flex items-center gap-2 text-sm text-black dark:text-white">
              <input
                type="checkbox"
                className={ADMIN_CHECKBOX}
                checked={draft.notifyAgain}
                onChange={(e) => set({ notifyAgain: e.target.checked })}
              />
              {t('notifyAgain')}
            </label>
          )}
        </div>
        {!draft.dismissible && (
          <p className={ADMIN_BANNER_WARN} role="alert">
            <IconAlertTriangle size={14} className="mr-1 inline" aria-hidden />
            {t('nonDismissibleWarning', { hours: MAX_NON_DISMISSIBLE_HOURS })}
          </p>
        )}
      </section>

      {/* Localization ---------------------------------------------------- */}
      <section className={`${ADMIN_CARD} space-y-3`}>
        <div className="flex flex-wrap items-center gap-3">
          <p className={`${ADMIN_LABEL} flex-1`}>{t('translations')}</p>
          <button
            type="button"
            className={ADMIN_BTN_SECONDARY}
            disabled={
              translating || !source.title.trim() || undeclared.length > 0
            }
            onClick={() => onTranslate()}
          >
            <IconLanguage size={16} />
            {translating ? t('translating') : t('translateAll')}
          </button>
          {count('stale') + count('missing') > 0 &&
            count('ai') + count('human') > 0 && (
              <button
                type="button"
                className={ADMIN_BTN_SECONDARY}
                disabled={translating || undeclared.length > 0}
                onClick={() =>
                  onTranslate(
                    locales.filter(
                      (l) => states[l] === 'stale' || states[l] === 'missing',
                    ),
                  )
                }
              >
                {t('translateOutdated')}
              </button>
            )}
        </div>
        <p className={ADMIN_HINT}>
          {t('translationSummary', {
            done: count('ai') + count('human'),
            stale: count('stale'),
            missing: count('missing'),
          })}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {locales
            .filter((locale) => locale !== draft.sourceLocale)
            .map((locale) => {
              const state = states[locale];
              const flagged = state === 'stale' || state === 'missing';
              return (
                <button
                  key={locale}
                  type="button"
                  title={
                    translationFailures[locale] ?? t(`localeState.${state}`)
                  }
                  className={`${flagged ? ADMIN_CHIP_WARN : ADMIN_CHIP_NEUTRAL} ${
                    openLocale === locale ? 'ring-1 ring-blue-500' : ''
                  }`}
                  onClick={() =>
                    setOpenLocale(openLocale === locale ? null : locale)
                  }
                >
                  {locale}
                  {state === 'human' ? ' ✎' : ''}
                </button>
              );
            })}
        </div>
        {openLocale && (
          <div className="space-y-2 rounded border border-gray-200 p-3 dark:border-gray-700">
            <p className="text-sm font-medium text-black dark:text-white">
              {localeToAutonym[openLocale]} ({openLocale}) —{' '}
              <span className={ADMIN_MUTED}>
                {translationFailures[openLocale] ??
                  t(`localeState.${states[openLocale]}`)}
              </span>
            </p>
            {(['title', 'body', 'actionLabel'] as const).map((field) => {
              if (field === 'actionLabel' && !source.actionLabel.trim()) {
                return null;
              }
              const value = draft.content[openLocale]?.[field] ?? '';
              const Field = field === 'body' ? 'textarea' : 'input';
              return (
                <Field
                  key={field}
                  aria-label={t(`${field}Field` as never)}
                  className={`${ADMIN_FIELD} w-full`}
                  value={value}
                  placeholder={source[field]}
                  onChange={(
                    e: React.ChangeEvent<
                      HTMLInputElement | HTMLTextAreaElement
                    >,
                  ) =>
                    set({
                      content: {
                        ...draft.content,
                        [openLocale]: {
                          ...(draft.content[openLocale] ?? {
                            title: '',
                            body: '',
                            actionLabel: '',
                          }),
                          [field]: e.target.value,
                          // A hand edit is reviewed text made from the
                          // CURRENT source.
                          origin: 'human',
                          sourceHash: currentSourceHash(draft),
                        },
                      },
                    })
                  }
                />
              );
            })}
          </div>
        )}
      </section>

      {/* Preview ---------------------------------------------------------- */}
      <section className={`${ADMIN_CARD} space-y-3`}>
        <div className="flex flex-wrap items-center gap-3">
          <p className={`${ADMIN_LABEL} flex-1`}>{t('preview')}</p>
          <select
            aria-label={t('previewLanguage')}
            className={ADMIN_FIELD}
            value={previewLocale}
            onChange={(e) => setPreviewLocale(e.target.value)}
          >
            {locales
              .filter((l) => l === draft.sourceLocale || draft.content[l])
              .map((locale) => (
                <option key={locale} value={locale}>
                  {localeToAutonym[locale]}
                </option>
              ))}
          </select>
          <select
            aria-label={t('previewTimezone')}
            className={ADMIN_FIELD}
            value={previewZone}
            onChange={(e) => setPreviewZone(e.target.value)}
          >
            {PREVIEW_ZONES.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </div>
        <div className="rounded border border-gray-200 bg-gray-50 p-3 text-sm dark:border-gray-700 dark:bg-gray-900">
          <p className="font-semibold text-black dark:text-white">
            {renderPreview(preview.title) || t('previewEmpty')}
          </p>
          {preview.body && (
            <p className="mt-1 whitespace-pre-line text-gray-700 dark:text-gray-300">
              {renderPreview(preview.body)}
            </p>
          )}
          {host !== null && preview.actionLabel && (
            <p className="mt-2 text-xs text-blue-700 dark:text-blue-300">
              [{renderPreview(preview.actionLabel)}] → {host}
            </p>
          )}
        </div>
      </section>
    </div>
  );
};
