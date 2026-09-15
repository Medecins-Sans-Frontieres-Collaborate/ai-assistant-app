'use client';

import { IconPlus, IconX } from '@tabler/icons-react';
import { useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  isAcronymLike,
  resolveEntryKind,
} from '@/lib/utils/shared/translation/glossaryMatch';

import { GlossaryEntry, GlossaryEntryKind } from '@/types/workflow';

interface GlossaryEntriesEditorProps {
  value: GlossaryEntry[];
  onChange: (value: GlossaryEntry[]) => void;
  disabled?: boolean;
}

/**
 * Controlled editor for glossary entries (table + add-entry row) — extracted
 * from GlossaryManager's editor pane so admin terminology guides edit the
 * exact same shape through the exact same UI. Uses the existing
 * workflows.translation strings. The add-entry draft is editor-local state;
 * committed entries flow through onChange with the full next list.
 *
 * Entry kind (issue #131): the type selector follows the typed source term
 * (all-caps → acronym) until the user picks explicitly. Acronym entries
 * expose the optional full-name fields. The committed entry always carries
 * an explicit `kind`, so a later change to the auto-detection heuristic
 * can never silently re-type what the user saved.
 */
export function GlossaryEntriesEditor({
  value,
  onChange,
  disabled,
}: GlossaryEntriesEditorProps) {
  const t = useTranslations('workflows.translation');

  const [newSource, setNewSource] = useState('');
  const [newTarget, setNewTarget] = useState('');
  const [newNote, setNewNote] = useState('');
  const [kindChoice, setKindChoice] = useState<'auto' | GlossaryEntryKind>(
    'auto',
  );
  const [newSourceExpansion, setNewSourceExpansion] = useState('');
  const [newTargetExpansion, setNewTargetExpansion] = useState('');

  const effectiveKind: GlossaryEntryKind =
    kindChoice === 'auto'
      ? isAcronymLike(newSource)
        ? 'acronym'
        : 'term'
      : kindChoice;

  const handleAddEntry = () => {
    if (!newSource.trim() || !newTarget.trim()) return;
    const entry: GlossaryEntry = {
      source: newSource.trim(),
      target: newTarget.trim(),
      kind: effectiveKind,
      ...(newNote.trim() ? { note: newNote.trim() } : {}),
      ...(effectiveKind === 'acronym' && newSourceExpansion.trim()
        ? { sourceExpansion: newSourceExpansion.trim() }
        : {}),
      ...(effectiveKind === 'acronym' && newTargetExpansion.trim()
        ? { targetExpansion: newTargetExpansion.trim() }
        : {}),
    };
    onChange([...value, entry]);
    setNewSource('');
    setNewTarget('');
    setNewNote('');
    setNewSourceExpansion('');
    setNewTargetExpansion('');
    setKindChoice('auto');
  };

  const inputClass =
    'rounded-lg border border-gray-300 bg-gray-50 px-2 py-1.5 text-sm text-gray-900 placeholder-gray-500 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100 dark:placeholder-gray-400';

  return (
    <fieldset disabled={disabled}>
      {value.length > 0 && (
        <table className="mb-3 w-full text-sm">
          <thead>
            <tr className="text-start text-xs text-gray-500 dark:text-gray-400">
              <th className="pb-1 pe-2 font-medium">{t('sourceTerm')}</th>
              <th className="pb-1 pe-2 font-medium">{t('targetTerm')}</th>
              <th className="pb-1 pe-2 font-medium">{t('note')}</th>
              <th className="pb-1" />
            </tr>
          </thead>
          <tbody>
            {value.map((entry, index) => {
              const kind = resolveEntryKind(entry);
              return (
                <tr
                  key={`${entry.source}-${index}`}
                  className="border-t border-gray-100 text-gray-800 dark:border-gray-800 dark:text-gray-200"
                >
                  <td className="py-1.5 pe-2">
                    {entry.source}
                    {kind === 'acronym' && (
                      <span
                        className="ms-1.5 rounded bg-gray-100 px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-600 dark:bg-surface-dark-elevated dark:text-gray-300"
                        title={t('acronymHint')}
                      >
                        {t('kindAcronym')}
                      </span>
                    )}
                    {entry.sourceExpansion && (
                      <span className="block text-xs text-gray-500 dark:text-gray-400">
                        {entry.sourceExpansion}
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 pe-2">
                    {entry.target}
                    {entry.targetExpansion && (
                      <span className="block text-xs text-gray-500 dark:text-gray-400">
                        {entry.targetExpansion}
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 pe-2 text-gray-500 dark:text-gray-400">
                    {entry.note}
                  </td>
                  <td className="py-1.5 text-end">
                    <button
                      type="button"
                      onClick={() =>
                        onChange(value.filter((_, i) => i !== index))
                      }
                      aria-label={t('removeEntry', { term: entry.source })}
                      className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-surface-dark-elevated dark:hover:text-gray-200"
                    >
                      <IconX size={13} aria-hidden />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <input
          value={newSource}
          onChange={(e) => setNewSource(e.target.value)}
          placeholder={t('sourceTerm')}
          aria-label={t('sourceTerm')}
          className={`${inputClass} w-32`}
        />
        <input
          value={newTarget}
          onChange={(e) => setNewTarget(e.target.value)}
          placeholder={t('targetTerm')}
          aria-label={t('targetTerm')}
          className={`${inputClass} w-32`}
        />
        <select
          value={effectiveKind}
          onChange={(e) => setKindChoice(e.target.value as GlossaryEntryKind)}
          aria-label={t('entryKind')}
          className={`${inputClass} w-28`}
        >
          <option value="term">{t('kindTerm')}</option>
          <option value="acronym">{t('kindAcronym')}</option>
        </select>
        <input
          value={newNote}
          onChange={(e) => setNewNote(e.target.value)}
          placeholder={t('noteOptional')}
          aria-label={t('noteOptional')}
          className={`${inputClass} w-36`}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAddEntry();
          }}
        />
        <button
          type="button"
          onClick={handleAddEntry}
          disabled={!newSource.trim() || !newTarget.trim()}
          className="inline-flex min-h-[34px] items-center gap-1 rounded-lg bg-gray-200 px-2.5 py-1.5 text-sm text-gray-900 hover:bg-gray-300 disabled:opacity-30 dark:bg-surface-dark-elevated dark:text-gray-100 dark:hover:bg-gray-700"
        >
          <IconPlus size={14} aria-hidden />
          {t('addEntry')}
        </button>
      </div>

      {effectiveKind === 'acronym' && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <input
            value={newSourceExpansion}
            onChange={(e) => setNewSourceExpansion(e.target.value)}
            placeholder={t('sourceExpansion')}
            aria-label={t('sourceExpansion')}
            className={`${inputClass} w-52`}
          />
          <input
            value={newTargetExpansion}
            onChange={(e) => setNewTargetExpansion(e.target.value)}
            placeholder={t('targetExpansion')}
            aria-label={t('targetExpansion')}
            className={`${inputClass} w-52`}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddEntry();
            }}
          />
          <p className="basis-full text-xs text-gray-500 dark:text-gray-400">
            {t('acronymHint')}
          </p>
        </div>
      )}
    </fieldset>
  );
}
