'use client';

import { IconAlertTriangle, IconCopy, IconX } from '@tabler/icons-react';
import { useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import { AvailableGuide } from '@/client/hooks/settings/useAvailableGuides';

import { MAX_ORG_GLOSSARIES_PER_REQUEST } from '@/lib/utils/shared/review/guideCriteria';
import {
  findTranslationLanguage,
  translationLanguageLabel,
} from '@/lib/utils/shared/translation/languages';

import { TranslationGlossary } from '@/types/workflow';

interface GlossaryPickerProps {
  /** Organization glossaries (admin terminology guides) this user may use. */
  orgGlossaries: AvailableGuide[];
  /** The user's own glossaries (settingsStore). */
  personalGlossaries: TranslationGlossary[];
  selectedOrgIds: string[];
  selectedPersonalIds: string[];
  /** Current target: catalog id or `custom:<id>`; undefined = none chosen. */
  targetLangId: string | undefined;
  onToggleOrg: (id: string) => void;
  onTogglePersonal: (id: string) => void;
  /** Snapshots an org glossary into the user's own list; resolves when done. */
  onCopyToMine: (guide: AvailableGuide) => Promise<void>;
  onManage: () => void;
  onClose: () => void;
  disabled?: boolean;
  /**
   * Ids selected in a previous session that are no longer visible (deleted,
   * access revoked, glossary removed) — shown disabled so they can be seen
   * and cleared rather than silently dropped.
   */
  staleOrgIds: string[];
  stalePersonalIds: string[];
}

type LanguageFit = 'match' | 'any' | 'other';

/**
 * Where a glossary sits relative to the current target language. Untagged
 * glossaries apply anywhere; tagged ones match on the id (catalog ids and
 * `custom:<id>` compare as strings).
 */
export function languageFit(
  targetLang: string | undefined,
  currentTarget: string | undefined,
): LanguageFit {
  if (!targetLang) return 'any';
  if (!currentTarget) return 'any';
  return targetLang === currentTarget ? 'match' : 'other';
}

function fitRank(fit: LanguageFit): number {
  return fit === 'match' ? 0 : fit === 'any' ? 1 : 2;
}

export function languageName(id: string | undefined): string | null {
  if (!id) return null;
  const known = findTranslationLanguage(id);
  if (known) return translationLanguageLabel(known);
  // `custom:<uuid>` has no label outside the owner's settings; the caller
  // substitutes when it can.
  return id.startsWith('custom:') ? null : id;
}

/**
 * The glossary attachment popover for the translation workspace: one place
 * to attach organization glossaries and the user's own, grouped, with the
 * ones tagged for the current target language first, untagged next, and
 * other languages last (collapsed but still selectable — a tag can be
 * wrong). Modelled on the map workflow's DatasetPicker.
 */
export function GlossaryPicker({
  orgGlossaries,
  personalGlossaries,
  selectedOrgIds,
  selectedPersonalIds,
  targetLangId,
  onToggleOrg,
  onTogglePersonal,
  onCopyToMine,
  onManage,
  onClose,
  disabled,
  staleOrgIds,
  stalePersonalIds,
}: GlossaryPickerProps) {
  const t = useTranslations('workflows.translation');
  const [showOtherOrg, setShowOtherOrg] = useState(false);
  const [showOtherMine, setShowOtherMine] = useState(false);
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  const orgRows = useMemo(
    () =>
      orgGlossaries
        .map((guide) => ({
          guide,
          fit: languageFit(guide.targetLang, targetLangId),
        }))
        .sort(
          (a, b) =>
            fitRank(a.fit) - fitRank(b.fit) ||
            a.guide.name.localeCompare(b.guide.name),
        ),
    [orgGlossaries, targetLangId],
  );
  const mineRows = useMemo(
    () =>
      personalGlossaries
        .map((glossary) => ({
          glossary,
          fit: languageFit(glossary.targetLang, targetLangId),
        }))
        .sort(
          (a, b) =>
            fitRank(a.fit) - fitRank(b.fit) ||
            a.glossary.name.localeCompare(b.glossary.name),
        ),
    [personalGlossaries, targetLangId],
  );

  const orgLimitReached =
    selectedOrgIds.length >= MAX_ORG_GLOSSARIES_PER_REQUEST;

  const pairLabel = (
    source: string | undefined,
    target: string | undefined,
  ) => {
    if (!source && !target) return t('glossaryAnyLanguage');
    const s = languageName(source) ?? t('glossaryAnyLanguage');
    const tg = languageName(target) ?? t('glossaryCustomLanguage');
    return `${s} → ${tg}`;
  };

  const handleCopy = async (guide: AvailableGuide) => {
    setCopyError(null);
    setCopyingId(guide.id);
    try {
      await onCopyToMine(guide);
    } catch {
      setCopyError(t('copyToMineFailed'));
    } finally {
      setCopyingId(null);
    }
  };

  const renderOrgRow = ({
    guide,
    fit,
  }: {
    guide: AvailableGuide;
    fit: LanguageFit;
  }) => {
    const checked = selectedOrgIds.includes(guide.id);
    const blocked = !checked && orgLimitReached;
    return (
      <li key={guide.id} className="flex items-start gap-2 px-2 py-1.5">
        <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={checked}
            disabled={disabled || blocked}
            onChange={() => onToggleOrg(guide.id)}
            aria-label={guide.name}
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-sm text-gray-900 dark:text-gray-100">
                {guide.name}
              </span>
              {fit === 'other' && checked && (
                <IconAlertTriangle
                  size={13}
                  aria-label={t('glossaryLanguageMismatch')}
                  className="shrink-0 text-amber-600 dark:text-amber-400"
                />
              )}
            </span>
            <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
              {pairLabel(guide.sourceLang, guide.targetLang)}
              {guide.entryCount !== undefined &&
                ` · ${t('glossaryEntryCount', { count: String(guide.entryCount) })}`}
            </span>
          </span>
        </label>
        <button
          type="button"
          onClick={() => void handleCopy(guide)}
          disabled={disabled || copyingId !== null}
          aria-label={t('copyToMine', { name: guide.name })}
          title={t('copyToMineTitle')}
          className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-40 dark:hover:bg-surface-dark-elevated dark:hover:text-gray-200"
        >
          <IconCopy size={14} aria-hidden />
        </button>
      </li>
    );
  };

  const renderMineRow = ({
    glossary,
    fit,
  }: {
    glossary: TranslationGlossary;
    fit: LanguageFit;
  }) => {
    const checked = selectedPersonalIds.includes(glossary.id);
    return (
      <li key={glossary.id} className="px-2 py-1.5">
        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={checked}
            disabled={disabled}
            onChange={() => onTogglePersonal(glossary.id)}
            aria-label={glossary.name}
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-sm text-gray-900 dark:text-gray-100">
                {glossary.name}
              </span>
              {fit === 'other' && checked && (
                <IconAlertTriangle
                  size={13}
                  aria-label={t('glossaryLanguageMismatch')}
                  className="shrink-0 text-amber-600 dark:text-amber-400"
                />
              )}
            </span>
            <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
              {pairLabel(glossary.sourceLang, glossary.targetLang)} ·{' '}
              {t('glossaryEntryCount', {
                count: String(glossary.entries.length),
              })}
            </span>
          </span>
        </label>
      </li>
    );
  };

  const renderStaleRow = (id: string, onClear: () => void) => (
    <li
      key={id}
      className="flex items-center gap-2 px-2 py-1.5 text-xs text-gray-500 dark:text-gray-400"
    >
      <span className="flex-1 truncate">{t('glossaryUnavailable')}</span>
      <button
        type="button"
        onClick={onClear}
        disabled={disabled}
        className="rounded px-1.5 py-0.5 hover:bg-gray-100 dark:hover:bg-surface-dark-elevated"
      >
        {t('clearStaleGlossary')}
      </button>
    </li>
  );

  const section = <T,>(
    title: string,
    rows: T[],
    fitOf: (row: T) => LanguageFit,
    render: (row: T) => React.ReactNode,
    showOther: boolean,
    setShowOther: (v: boolean) => void,
    stale: React.ReactNode[],
    empty: string,
  ) => {
    const primary = rows.filter((row) => fitOf(row) !== 'other');
    const other = rows.filter((row) => fitOf(row) === 'other');
    return (
      <div className="mb-2">
        <p className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {title}
        </p>
        {rows.length === 0 && stale.length === 0 ? (
          <p className="px-2 pb-1 text-xs text-gray-500 dark:text-gray-400">
            {empty}
          </p>
        ) : (
          <ul>
            {primary.map(render)}
            {stale}
            {other.length > 0 && (
              <li className="px-2 py-1">
                <button
                  type="button"
                  onClick={() => setShowOther(!showOther)}
                  aria-expanded={showOther}
                  className="text-xs text-gray-500 underline-offset-2 hover:underline dark:text-gray-400"
                >
                  {showOther
                    ? t('hideOtherLanguages')
                    : t('showOtherLanguages', { count: String(other.length) })}
                </button>
              </li>
            )}
            {showOther && other.map(render)}
          </ul>
        )}
      </div>
    );
  };

  return (
    <div
      role="dialog"
      aria-label={t('glossaryPickerTitle')}
      className="absolute bottom-full start-0 z-[1000] mb-2 w-96 max-w-[calc(100vw-2rem)] rounded-lg border border-gray-200 bg-white p-2 shadow-lg dark:border-gray-700 dark:bg-surface-dark"
    >
      <div className="mb-1 flex items-center justify-between px-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {t('glossaryPickerTitle')}
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('glossaryPickerClose')}
          className="flex h-6 w-6 items-center justify-center rounded text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
        >
          <IconX size={13} aria-hidden />
        </button>
      </div>

      <div className="max-h-80 overflow-y-auto">
        {section(
          t('glossaryOrgSection'),
          orgRows,
          (row) => row.fit,
          renderOrgRow,
          showOtherOrg,
          setShowOtherOrg,
          staleOrgIds.map((id) => renderStaleRow(id, () => onToggleOrg(id))),
          t('noOrganizationGlossaries'),
        )}
        {orgLimitReached && (
          <p className="mb-2 px-2 text-xs text-gray-500 dark:text-gray-400">
            {t('glossaryOrgLimit', {
              max: String(MAX_ORG_GLOSSARIES_PER_REQUEST),
            })}
          </p>
        )}
        {copyError && (
          <p className="mb-2 px-2 text-xs text-red-600 dark:text-red-400">
            {copyError}
          </p>
        )}
        {section(
          t('glossaryMineSection'),
          mineRows,
          (row) => row.fit,
          renderMineRow,
          showOtherMine,
          setShowOtherMine,
          stalePersonalIds.map((id) =>
            renderStaleRow(id, () => onTogglePersonal(id)),
          ),
          t('noPersonalGlossaries'),
        )}
      </div>

      <div className="mt-1 border-t border-gray-200 pt-2 dark:border-gray-700">
        <button
          type="button"
          onClick={onManage}
          className="w-full rounded-md px-2 py-1.5 text-start text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-surface-dark-elevated"
        >
          {t('manageGlossaries')}
        </button>
      </div>
    </div>
  );
}
