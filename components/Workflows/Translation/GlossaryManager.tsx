'use client';

import { IconPlus, IconTrash, IconX } from '@tabler/icons-react';
import { useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import { MAX_GUIDE_ENTRIES } from '@/lib/utils/shared/review/guideCriteria';
import {
  TRANSLATION_LANGUAGES,
  translationLanguageLabel,
} from '@/lib/utils/shared/translation/languages';

import { TranslationGlossary } from '@/types/workflow';

import { GlossaryEntriesEditor } from '../Shared/GlossaryEntriesEditor';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { v4 as uuidv4 } from 'uuid';

interface GlossaryManagerProps {
  onClose: () => void;
  /**
   * Prefills the target language of a NEW glossary from the workspace's
   * current target (catalog id or `custom:<id>`) — the encouragement half
   * of "optional but encouraged".
   */
  defaultTargetLang?: string;
}

/**
 * Inline glossary editor panel: create, edit, and delete reusable
 * terminology glossaries (persisted in settingsStore, applied to
 * translations by prompt injection).
 */
export function GlossaryManager({
  onClose,
  defaultTargetLang,
}: GlossaryManagerProps) {
  const t = useTranslations('workflows');
  const glossaries = useSettingsStore((s) => s.glossaries);
  const customLanguages = useSettingsStore((s) => s.customLanguages);
  const addGlossary = useSettingsStore((s) => s.addGlossary);
  const updateGlossary = useSettingsStore((s) => s.updateGlossary);
  const deleteGlossary = useSettingsStore((s) => s.deleteGlossary);

  /** Catalog + this user's custom languages, for the pair selects. */
  const languageOptions = useMemo(() => {
    const catalog = TRANSLATION_LANGUAGES.map((lang) => ({
      id: lang.id,
      label: translationLanguageLabel(lang),
    })).sort((a, b) => a.label.localeCompare(b.label));
    const custom = customLanguages.map((lang) => ({
      id: `custom:${lang.id}`,
      label: lang.name,
    }));
    return [...catalog, ...custom];
  }, [customLanguages]);

  const [editingId, setEditingId] = useState<string | null>(
    glossaries[0]?.id ?? null,
  );
  const editing = glossaries.find((g) => g.id === editingId);

  const handleCreate = () => {
    const glossary: TranslationGlossary = {
      id: uuidv4(),
      name: t('translation.newGlossaryName'),
      ...(defaultTargetLang ? { targetLang: defaultTargetLang } : {}),
      entries: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    addGlossary(glossary);
    setEditingId(glossary.id);
  };

  const inputClass =
    'rounded-lg border border-gray-300 bg-gray-50 px-2 py-1.5 text-sm text-gray-900 placeholder-gray-500 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100 dark:placeholder-gray-400';

  return (
    <div className="flex h-full flex-col border-t border-gray-200 dark:border-gray-700">
      <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {t('translation.glossaries')}
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('translation.closeGlossaries')}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
        >
          <IconX size={15} aria-hidden />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Glossary list */}
        <div className="w-44 shrink-0 overflow-y-auto border-e border-gray-200 p-2 dark:border-gray-700">
          {glossaries.map((glossary) => (
            <button
              key={glossary.id}
              type="button"
              onClick={() => setEditingId(glossary.id)}
              className={`mb-1 block w-full truncate rounded-md px-2 py-1.5 text-start text-sm ${
                glossary.id === editingId
                  ? 'bg-gray-200 text-gray-900 dark:bg-gray-700 dark:text-gray-100'
                  : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-surface-dark-elevated'
              }`}
            >
              {glossary.name}
            </button>
          ))}
          <button
            type="button"
            onClick={handleCreate}
            className="mt-1 inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
          >
            <IconPlus size={14} aria-hidden />
            {t('translation.newGlossary')}
          </button>
        </div>

        {/* Editor */}
        <div className="min-w-0 flex-1 overflow-y-auto p-3">
          {editing ? (
            <>
              <div className="mb-3 flex items-center gap-2">
                <input
                  value={editing.name}
                  onChange={(e) =>
                    updateGlossary(editing.id, { name: e.target.value })
                  }
                  aria-label={t('translation.glossaryName')}
                  className={`${inputClass} flex-1`}
                />
                <button
                  type="button"
                  onClick={() => {
                    deleteGlossary(editing.id);
                    setEditingId(null);
                  }}
                  aria-label={t('translation.deleteGlossary')}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
                >
                  <IconTrash size={15} aria-hidden />
                </button>
              </div>

              <div className="mb-3 flex flex-wrap items-end gap-2">
                <label className="flex flex-col gap-0.5 text-xs text-gray-500 dark:text-gray-400">
                  {t('translation.glossarySourceLang')}
                  <select
                    value={editing.sourceLang ?? ''}
                    onChange={(e) =>
                      updateGlossary(editing.id, {
                        sourceLang: e.target.value || undefined,
                      })
                    }
                    className={`${inputClass} w-44`}
                  >
                    <option value="">
                      {t('translation.glossaryAnyLanguage')}
                    </option>
                    {languageOptions.map((lang) => (
                      <option key={lang.id} value={lang.id}>
                        {lang.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-0.5 text-xs text-gray-500 dark:text-gray-400">
                  {t('translation.glossaryTargetLang')}
                  <select
                    value={editing.targetLang ?? ''}
                    onChange={(e) =>
                      updateGlossary(editing.id, {
                        targetLang: e.target.value || undefined,
                      })
                    }
                    className={`${inputClass} w-44`}
                  >
                    <option value="">
                      {t('translation.glossaryAnyLanguage')}
                    </option>
                    {languageOptions.map((lang) => (
                      <option key={lang.id} value={lang.id}>
                        {lang.label}
                      </option>
                    ))}
                  </select>
                </label>
                {!editing.targetLang && (
                  <p className="basis-full text-xs text-gray-500 dark:text-gray-400">
                    {t('translation.glossaryLanguageEncourage')}
                  </p>
                )}
              </div>

              <GlossaryEntriesEditor
                value={editing.entries}
                onChange={(entries) => updateGlossary(editing.id, { entries })}
                allowImport
                maxEntries={MAX_GUIDE_ENTRIES}
                exportName={editing.name}
              />
            </>
          ) : (
            <p className="max-w-[50ch] text-sm text-gray-500 dark:text-gray-400">
              {t('translation.glossariesEmpty')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
