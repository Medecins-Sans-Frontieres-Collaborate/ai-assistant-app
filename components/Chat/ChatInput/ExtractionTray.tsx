'use client';

import {
  IconAlertTriangle,
  IconInfoCircle,
  IconPaperclip,
  IconPlus,
  IconX,
} from '@tabler/icons-react';
import { FC, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useConversations } from '@/client/hooks/conversation/useConversations';

import { getExtractionMaterialState } from '@/lib/utils/shared/chat/extractionMaterial';

import { ExtractionRecipePicker } from './ExtractionRecipePicker';

import { useChatInputStore } from '@/client/stores/chatInputStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import { ATTACH_ACCEPT_TYPES } from '@/lib/constants/fileTypes';

const MAX_RECIPES_PER_TURN = 3;

/**
 * Inline tray rendered above the chat textarea when extraction mode is
 * active. Two-state body:
 *
 *  - **Empty state**: no composer text, no composer file, no active
 *    file → amber warning row + inline Attach-file affordance. The
 *    send button is also blocked upstream (`ChatInput.preventSubmission`).
 *  - **With-material state**: a quiet status line listing what will be
 *    extracted (composer files, message text, active files).
 *
 * Per DESIGN.md the tray uses the half-step `paper-tint` background and a
 * 1px border — matches the existing Panel pattern, no shadow, no nesting.
 */
export const ExtractionTray: FC = () => {
  const t = useTranslations('extraction');
  const recipes = useSettingsStore((s) => s.extractionRecipes);
  const selectedIds = useChatInputStore((s) => s.extractionRecipeIds);
  const removeRecipeId = useChatInputStore((s) => s.removeExtractionRecipeId);
  const clearRecipeIds = useChatInputStore((s) => s.clearExtractionRecipeIds);
  const setExtractionMode = useChatInputStore((s) => s.setExtractionMode);
  const textFieldValue = useChatInputStore((s) => s.textFieldValue);
  const filePreviews = useChatInputStore((s) => s.filePreviews);
  const handleFileUpload = useChatInputStore((s) => s.handleFileUpload);
  const { selectedConversation } = useConversations();

  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const selectedRecipes = selectedIds
    .map((id) => recipes.find((r) => r.id === id))
    .filter((r): r is NonNullable<typeof r> => !!r);

  const isFull = selectedRecipes.length >= MAX_RECIPES_PER_TURN;
  const isAuto = selectedRecipes.length === 0;

  const material = getExtractionMaterialState({
    textFieldValue,
    filePreviewCount: filePreviews.length,
    activeFileCount: selectedConversation?.activeFiles?.length ?? 0,
  });

  const handleAttachClick = () => {
    fileInputRef.current?.click();
  };

  const handleDismiss = () => {
    // Turning extraction off is a "cancel" — clear chip selections too so
    // re-enabling later starts from a clean tray.
    clearRecipeIds();
    setExtractionMode(false);
    setPickerOpen(false);
  };

  const handleFileInputChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    await handleFileUpload(event);
    // Reset so picking the same file again still fires the change event.
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div
      className="relative mx-3 my-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-[#1c1c1c] px-3 py-2"
      role="region"
      aria-label={t('trayLabel')}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-medium text-gray-700 dark:text-gray-300">
          {t('trayPrefix')}:
        </span>

        {selectedRecipes.map((recipe) => (
          <span
            key={recipe.id}
            className="inline-flex items-center gap-1 rounded-md bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-2 py-0.5 text-xs text-gray-800 dark:text-gray-200"
          >
            <span className="truncate max-w-[160px]">{recipe.name}</span>
            <button
              type="button"
              onClick={() => removeRecipeId(recipe.id)}
              className="ml-0.5 rounded-sm p-0.5 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              aria-label={t('removeRecipe', { name: recipe.name })}
              title={t('remove')}
            >
              <IconX size={12} />
            </button>
          </span>
        ))}

        {isAuto && (
          <span className="inline-flex items-center gap-1 rounded-md border border-dashed border-gray-300 dark:border-gray-600 px-2 py-0.5 text-xs text-gray-500 dark:text-gray-400">
            {t('autoChip')}
          </span>
        )}

        <button
          ref={addButtonRef}
          type="button"
          onClick={() => !isFull && setPickerOpen((v) => !v)}
          disabled={isFull}
          className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs transition-colors ${
            isFull
              ? 'cursor-not-allowed text-gray-400 dark:text-gray-500'
              : 'text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30'
          }`}
          title={isFull ? t('addRecipeFullTitle') : t('addRecipeTitle')}
          aria-haspopup="dialog"
          aria-expanded={pickerOpen}
        >
          <IconPlus size={12} />
          <span>{t('addRecipe')}</span>
        </button>

        <span
          className="ml-auto inline-flex items-center text-gray-400 dark:text-gray-500"
          title={t('trayInfo')}
        >
          <IconInfoCircle size={14} aria-hidden="true" />
          <span className="sr-only">{t('trayInfo')}</span>
        </span>

        <button
          type="button"
          onClick={handleDismiss}
          className="rounded-md p-1 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-gray-100 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
          aria-label={t('dismiss')}
          title={t('dismiss')}
        >
          <IconX size={14} />
        </button>
      </div>

      {/* Material state: warning when empty, quiet summary when present. */}
      {material.hasAny ? (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          {t('willExtractPrefix')}{' '}
          {buildMaterialSummary(material, t).join(' + ')}
        </p>
      ) : (
        <div
          className="mt-2 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-900/30 dark:border-amber-700/60 px-3 py-2 flex items-start gap-2"
          role="status"
        >
          <IconAlertTriangle
            size={14}
            className="mt-0.5 flex-shrink-0 text-amber-700 dark:text-amber-300"
            aria-hidden="true"
          />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-amber-800 dark:text-amber-200">
              {t('materialWarningTitle')}
            </p>
            <p className="text-xs text-amber-800/80 dark:text-amber-200/80 mt-0.5">
              {t('materialWarningBody')}
            </p>
            <button
              type="button"
              onClick={handleAttachClick}
              className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-amber-300 dark:border-amber-700 bg-white dark:bg-[#1c1c1c] px-2 py-0.5 text-xs font-medium text-amber-800 dark:text-amber-200 hover:bg-amber-100/60 dark:hover:bg-amber-900/40 transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500"
            >
              <IconPaperclip size={12} />
              <span>{t('materialAttach')}</span>
            </button>
          </div>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept={ATTACH_ACCEPT_TYPES}
        multiple
        className="hidden"
        onChange={handleFileInputChange}
        aria-hidden="true"
      />

      {pickerOpen && (
        <ExtractionRecipePicker
          anchorRef={addButtonRef}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
};

type TranslateFn = ReturnType<typeof useTranslations<'extraction'>>;

function buildMaterialSummary(
  material: ReturnType<typeof getExtractionMaterialState>,
  t: TranslateFn,
): string[] {
  const parts: string[] = [];
  if (material.newFileCount > 0) {
    parts.push(t('materialFiles', { count: material.newFileCount }));
  }
  if (material.hasText) {
    parts.push(t('materialText'));
  }
  if (material.activeFileCount > 0) {
    parts.push(t('materialActiveFiles', { count: material.activeFileCount }));
  }
  return parts;
}
