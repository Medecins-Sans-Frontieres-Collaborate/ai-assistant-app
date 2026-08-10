'use client';

import {
  IconBrain,
  IconPencil,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import { FC, KeyboardEvent, useState } from 'react';

import { useFormatter, useTranslations } from 'next-intl';

import {
  MAX_MEMORIES,
  MAX_MEMORY_TEXT_LENGTH,
  normalizeMemoryText,
  useMemoryStore,
} from '@/client/stores/memoryStore';
import { useSettingsStore } from '@/client/stores/settingsStore';

/**
 * "Memories" settings section: user opt-in toggle for cross-conversation
 * memories, a pause switch for automatic capture, and full manual management
 * of the stored entries. Visibility is gated by the LaunchDarkly
 * `enableMemories` flag in SettingsSidebar; the section itself always renders
 * what is stored so users can review, correct and delete their data even
 * after opting out.
 */
export const MemoriesSection: FC = () => {
  const t = useTranslations('memories');
  const format = useFormatter();

  const memoriesEnabled = useSettingsStore((s) => s.memoriesEnabled);
  const setMemoriesEnabled = useSettingsStore((s) => s.setMemoriesEnabled);
  const memoryCapturePaused = useSettingsStore((s) => s.memoryCapturePaused);
  const setMemoryCapturePaused = useSettingsStore(
    (s) => s.setMemoryCapturePaused,
  );
  const memories = useMemoryStore((s) => s.memories);
  const addMemory = useMemoryStore((s) => s.addMemory);
  const updateMemory = useMemoryStore((s) => s.updateMemory);
  const deleteMemory = useMemoryStore((s) => s.deleteMemory);
  const clearMemories = useMemoryStore((s) => s.clearMemories);

  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [draft, setDraft] = useState('');
  const [addError, setAddError] = useState<'duplicate' | 'at-capacity' | null>(
    null,
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');

  // Don't leave the destructive confirm armed across list-empty transitions
  // (e.g. last memory deleted per-item, then a new one auto-extracted), and
  // don't keep an editor open over an entry that has since disappeared —
  // auto-extraction can delete one while Settings is open.
  // Render-time state adjustment — the lint config disallows setState in effects.
  if (showClearConfirm && memories.length === 0) {
    setShowClearConfirm(false);
  }
  if (editingId && !memories.some((m) => m.id === editingId)) {
    setEditingId(null);
  }

  const clearConfirmVisible = showClearConfirm && memories.length > 0;
  const atCapacity = memories.length >= MAX_MEMORIES;
  // Count what will actually be STORED, not what was typed: the store
  // collapses runs of whitespace before saving.
  const normalizedDraft = normalizeMemoryText(draft);
  const normalizedEditDraft = normalizeMemoryText(editDraft);

  const formatDate = (iso: string): string => {
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime())
      ? ''
      : format.dateTime(parsed, { dateStyle: 'short' });
  };

  const handleAdd = (): void => {
    // 'user' marks the entry hand-written, which protects it from being
    // rewritten or deleted by automatic extraction.
    const result = addMemory(draft, undefined, 'user');
    if (result === 'added') {
      setDraft('');
      setAddError(null);
    } else if (result === 'duplicate' || result === 'at-capacity') {
      setAddError(result);
    }
  };

  const startEditing = (id: string, text: string): void => {
    setEditingId(id);
    setEditDraft(text);
    // Never leave an armed destructive confirm sitting next to an open editor.
    setShowClearConfirm(false);
  };

  const handleSaveEdit = (): void => {
    if (!editingId || !normalizedEditDraft) return;
    // A hand-edited memory becomes protected too — the user has taken
    // ownership of its wording.
    updateMemory(editingId, editDraft, 'user');
    setEditingId(null);
  };

  // Memory text is always stored as a single line, so a literal newline would
  // be silently dropped. Enter saves instead, and Escape backs out.
  const submitOnEnter =
    (onSubmit: () => void, onCancel: () => void) =>
    (e: KeyboardEvent<HTMLTextAreaElement>): void => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        onSubmit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };

  const textareaClass =
    'w-full resize-none rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm text-black dark:text-white placeholder:text-gray-400 dark:placeholder:text-gray-500';

  return (
    <div className="p-4">
      <div className="mb-2 flex items-center gap-2">
        <IconBrain size={24} className="text-black dark:text-white" />
        <h2 className="text-xl font-bold text-black dark:text-white">
          {t('title')}
        </h2>
      </div>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        {t('description')}
      </p>

      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-gray-600 dark:accent-gray-400"
          checked={memoriesEnabled}
          onChange={(e) => setMemoriesEnabled(e.target.checked)}
        />
        <span>
          <span className="block text-sm text-black dark:text-gray-200">
            {t('enableToggle')}
          </span>
          {/* Transparent data handling: where memories live and how they're used. */}
          <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
            {t('privacyNote')}
          </span>
        </span>
      </label>

      {/* Nested under the master toggle: pausing capture is meaningless while
          the feature itself is off, but the control stays visible so the
          option is discoverable rather than appearing out of nowhere. */}
      <label
        className={`mt-3 ml-7 flex items-start gap-3 ${
          memoriesEnabled ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'
        }`}
      >
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-gray-600 dark:accent-gray-400"
          checked={memoryCapturePaused}
          disabled={!memoriesEnabled}
          onChange={(e) => setMemoryCapturePaused(e.target.checked)}
        />
        <span>
          <span className="block text-sm text-black dark:text-gray-200">
            {t('pauseToggle')}
          </span>
          <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
            {t('pauseNote')}
          </span>
        </span>
      </label>

      <div className="mt-6">
        <label
          htmlFor="memory-add"
          className="mb-1.5 block text-sm font-medium text-black dark:text-gray-200"
        >
          {t('addLabel')}
        </label>
        <textarea
          id="memory-add"
          rows={2}
          maxLength={MAX_MEMORY_TEXT_LENGTH}
          className={textareaClass}
          value={draft}
          placeholder={t('addPlaceholder')}
          onChange={(e) => {
            setDraft(e.target.value);
            setAddError(null);
          }}
          onKeyDown={submitOnEnter(handleAdd, () => {
            setDraft('');
            setAddError(null);
          })}
        />
        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {addError === 'duplicate'
              ? t('duplicate')
              : addError === 'at-capacity' || atCapacity
                ? t('atCapacity', { max: MAX_MEMORIES })
                : draft.includes('\n')
                  ? t('noLineBreaksHint')
                  : normalizedDraft
                    ? t('charCount', {
                        count: normalizedDraft.length,
                        max: MAX_MEMORY_TEXT_LENGTH,
                      })
                    : ''}
          </p>
          <button
            type="button"
            onClick={handleAdd}
            disabled={!normalizedDraft || atCapacity}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-black dark:text-white hover:bg-gray-100 dark:hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <IconPlus size={14} />
            {t('addMemory')}
          </button>
        </div>
      </div>

      <div className="mt-6">
        {memories.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('empty')}
          </p>
        ) : (
          <>
            <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
              {t('storedCount', { count: memories.length, max: MAX_MEMORIES })}
            </p>
            <ul className="space-y-2">
              {memories.map((memory) => (
                <li
                  key={memory.id}
                  className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2"
                >
                  {editingId === memory.id ? (
                    <>
                      <textarea
                        rows={2}
                        autoFocus
                        maxLength={MAX_MEMORY_TEXT_LENGTH}
                        className={textareaClass}
                        value={editDraft}
                        aria-label={t('editMemory')}
                        onChange={(e) => setEditDraft(e.target.value)}
                        onKeyDown={submitOnEnter(handleSaveEdit, () =>
                          setEditingId(null),
                        )}
                      />
                      <div className="mt-1.5 flex items-center gap-3">
                        <button
                          type="button"
                          onClick={handleSaveEdit}
                          disabled={!normalizedEditDraft}
                          className="text-sm font-semibold text-black hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-50 dark:text-gray-200 dark:hover:text-white"
                        >
                          {t('saveMemory')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          className="text-sm text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
                        >
                          {t('cancel')}
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="break-words text-sm text-black dark:text-gray-200">
                          {memory.text}
                        </p>
                        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                          {memory.origin === 'user'
                            ? `${t('addedByYou')} · ${t('savedOn', {
                                date: formatDate(memory.updatedAt),
                              })}`
                            : t('savedOn', {
                                date: formatDate(memory.updatedAt),
                              })}
                        </p>
                      </div>
                      <div className="flex flex-shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={() => startEditing(memory.id, memory.text)}
                          aria-label={t('editMemory')}
                          title={t('editMemory')}
                          className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-black dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white"
                        >
                          <IconPencil size={16} />
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteMemory(memory.id)}
                          aria-label={t('deleteMemory')}
                          title={t('deleteMemory')}
                          className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-red-600 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-red-400"
                        >
                          <IconTrash size={16} />
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>

            <div className="mt-4">
              {clearConfirmVisible ? (
                <div className="flex items-center gap-3">
                  <span className="text-sm text-black dark:text-gray-200">
                    {t('clearAllConfirmQuestion')}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      clearMemories();
                      setShowClearConfirm(false);
                    }}
                    className="text-sm font-semibold text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                  >
                    {t('clearAllConfirm')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowClearConfirm(false)}
                    className="text-sm text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
                  >
                    {t('cancel')}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowClearConfirm(true)}
                  className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 dark:border-gray-700 dark:text-red-400 dark:hover:bg-red-900/20"
                >
                  {t('clearAll')}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
