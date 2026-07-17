'use client';

import { IconPlus, IconSparkles } from '@tabler/icons-react';
import { FC, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useChatInputStore } from '@/client/stores/chatInputStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import { useUIStore } from '@/client/stores/uiStore';

interface ExtractionRecipePickerProps {
  /** Anchor element rect so the popover positions above the tray. */
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}

/**
 * Popover that opens from "+ add recipe" in the ExtractionTray. Lists
 * saved recipes (most-recently-updated first) plus a "Create new recipe…"
 * row that opens the Settings editor.
 *
 * Disabled when 3 recipes are already selected — the tray's add button
 * gates that, but we re-check here defensively.
 */
export const ExtractionRecipePicker: FC<ExtractionRecipePickerProps> = ({
  anchorRef,
  onClose,
}) => {
  const t = useTranslations('extraction');
  const recipes = useSettingsStore((s) => s.extractionRecipes);
  const selectedIds = useChatInputStore((s) => s.extractionRecipeIds);
  const addRecipeId = useChatInputStore((s) => s.addExtractionRecipeId);
  const setIsCustomizationsOpen = useUIStore((s) => s.setIsCustomizationsOpen);
  const setCustomizationsInitialTab = useUIStore(
    (s) => s.setCustomizationsInitialTab,
  );

  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [filter, setFilter] = useState('');

  // Dismiss on outside click + Escape.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchorRef, onClose]);

  const visibleRecipes = useMemo(() => {
    const available = recipes.filter((r) => !selectedIds.includes(r.id));
    const sorted = [...available].sort((a, b) =>
      (b.updatedAt || '').localeCompare(a.updatedAt || ''),
    );
    if (!filter.trim()) return sorted;
    const q = filter.toLowerCase();
    return sorted.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        (r.description || '').toLowerCase().includes(q),
    );
  }, [recipes, selectedIds, filter]);

  const handlePick = (id: string) => {
    addRecipeId(id);
    onClose();
  };

  const handleCreateNew = () => {
    setCustomizationsInitialTab('recipes');
    setIsCustomizationsOpen(true);
    onClose();
  };

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={t('section')}
      className="absolute bottom-full left-0 mb-2 w-80 z-30 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-[#1c1c1c] shadow-lg overflow-hidden"
    >
      <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700">
        <input
          autoFocus
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t('searchRecipes')}
          className="w-full bg-transparent text-sm focus:outline-none placeholder:text-gray-400 dark:placeholder:text-gray-500"
          aria-label={t('searchRecipes')}
        />
      </div>

      <ul className="max-h-72 overflow-y-auto py-1">
        {visibleRecipes.length === 0 && recipes.length === 0 && (
          <li className="px-3 py-3 text-xs text-gray-500 dark:text-gray-400">
            {t('pickerEmpty')}
          </li>
        )}

        {visibleRecipes.length === 0 && recipes.length > 0 && (
          <li className="px-3 py-3 text-xs text-gray-500 dark:text-gray-400">
            {t('pickerEmptyMatch')}
          </li>
        )}

        {visibleRecipes.map((recipe) => (
          <li key={recipe.id}>
            <button
              type="button"
              onClick={() => handlePick(recipe.id)}
              className="w-full text-left px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800 focus:bg-gray-50 dark:focus:bg-gray-800 focus:outline-none transition-colors"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium truncate text-gray-900 dark:text-gray-100">
                  {recipe.name}
                </span>
                <span className="shrink-0 text-[10px] font-medium text-gray-500 dark:text-gray-400">
                  {recipe.fields.length}{' '}
                  {recipe.fields.length === 1 ? t('field') : t('fieldsPlural')}
                </span>
              </div>
              {recipe.description && (
                <p className="text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5">
                  {recipe.description}
                </p>
              )}
            </button>
          </li>
        ))}
      </ul>

      <div className="border-t border-gray-200 dark:border-gray-700">
        <button
          type="button"
          onClick={handleCreateNew}
          className="w-full text-left px-3 py-2.5 text-sm flex items-center gap-2 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 focus:bg-blue-50 dark:focus:bg-blue-900/30 focus:outline-none transition-colors"
        >
          <IconPlus size={16} />
          <span>{t('newRecipe')}</span>
          <IconSparkles
            size={14}
            className="ml-auto text-gray-400 dark:text-gray-500"
            aria-hidden="true"
          />
        </button>
      </div>
    </div>
  );
};
