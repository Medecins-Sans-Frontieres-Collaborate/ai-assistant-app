'use client';

import {
  IconChevronDown,
  IconChevronRight,
  IconPlus,
  IconSparkles,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { FC, useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  ExtractionRecipe,
  FieldType,
  RecipeField,
} from '@/types/extractionRecipe';

import { useSettingsStore } from '@/client/stores/settingsStore';

const FIELD_TYPES: FieldType[] = [
  'text',
  'number',
  'date',
  'boolean',
  'enum',
  'list<text>',
  'list<number>',
];

function newRecipeId(): string {
  return `recipe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function newFieldId(): string {
  return `field_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function emptyRecipe(): ExtractionRecipe {
  const now = new Date().toISOString();
  return {
    id: newRecipeId(),
    name: '',
    description: '',
    instructions: '',
    fields: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Quick Actions tab for managing saved extraction recipes.
 *
 * List + inline-expand editor pattern (no nested modals). Each recipe
 * row collapses to name + field count; expanded reveals the full editor —
 * name, description, instructions, field builder, and a "Suggest with AI"
 * button that hits `/api/extraction/suggest-schema`.
 */
export const ExtractionRecipesTab: FC = () => {
  const t = useTranslations('extraction');
  const recipes = useSettingsStore((s) => s.extractionRecipes);
  const addRecipe = useSettingsStore((s) => s.addExtractionRecipe);
  const updateRecipe = useSettingsStore((s) => s.updateExtractionRecipe);
  const deleteRecipe = useSettingsStore((s) => s.deleteExtractionRecipe);

  const [expandedId, setExpandedId] = useState<string | null>(null);

  const handleCreateNew = () => {
    const recipe = emptyRecipe();
    addRecipe(recipe);
    setExpandedId(recipe.id);
  };

  return (
    <div className="flex flex-col gap-4 h-full overflow-y-auto p-4 sm:p-6">
      <p className="text-sm text-gray-600 dark:text-gray-400 max-w-prose">
        {t('sectionSubtitle')}
      </p>

      <div className="space-y-2">
        {recipes.length === 0 && (
          <div className="rounded-lg border border-dashed border-gray-300 dark:border-gray-700 px-4 py-6 text-sm text-gray-500 dark:text-gray-400 text-center">
            {t('editorEmpty')}
          </div>
        )}

        {recipes.map((recipe) => (
          <RecipeRow
            key={recipe.id}
            recipe={recipe}
            isExpanded={expandedId === recipe.id}
            onToggleExpand={() =>
              setExpandedId((id) => (id === recipe.id ? null : recipe.id))
            }
            onUpdate={(updates) => updateRecipe(recipe.id, updates)}
            onDelete={() => {
              deleteRecipe(recipe.id);
              if (expandedId === recipe.id) setExpandedId(null);
            }}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={handleCreateNew}
        className="self-start inline-flex items-center gap-1 rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
      >
        <IconPlus size={16} />
        <span>{t('newRecipe')}</span>
      </button>
    </div>
  );
};

interface RecipeRowProps {
  recipe: ExtractionRecipe;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onUpdate: (updates: Partial<ExtractionRecipe>) => void;
  onDelete: () => void;
}

const RecipeRow: FC<RecipeRowProps> = ({
  recipe,
  isExpanded,
  onToggleExpand,
  onUpdate,
  onDelete,
}) => {
  const t = useTranslations('extraction');
  const [confirming, setConfirming] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);

  const handleFieldUpdate = (
    fieldId: string,
    updates: Partial<RecipeField>,
  ) => {
    onUpdate({
      fields: recipe.fields.map((f) =>
        f.id === fieldId ? { ...f, ...updates } : f,
      ),
      updatedAt: new Date().toISOString(),
    });
  };

  const handleAddField = () => {
    const field: RecipeField = {
      id: newFieldId(),
      name: '',
      type: 'text',
      required: true,
    };
    onUpdate({
      fields: [...recipe.fields, field],
      updatedAt: new Date().toISOString(),
    });
  };

  const handleRemoveField = (fieldId: string) => {
    onUpdate({
      fields: recipe.fields.filter((f) => f.id !== fieldId),
      updatedAt: new Date().toISOString(),
    });
  };

  const handleSuggest = async () => {
    if (!recipe.instructions.trim()) {
      setSuggestError(t('suggestNeedsInstructions'));
      return;
    }
    setSuggesting(true);
    setSuggestError(null);
    try {
      const res = await fetch('/api/extraction/suggest-schema', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instructions: recipe.instructions,
          existingFields: recipe.fields.map((f) => ({
            name: f.name,
            type: f.type,
            description: f.description,
            required: f.required !== false,
          })),
        }),
      });
      if (!res.ok) {
        throw new Error(`Schema suggestion failed (${res.status})`);
      }
      const data = (await res.json()) as {
        fields: Array<{
          name: string;
          type: FieldType;
          description?: string;
          required?: boolean;
          enumValues?: string[];
        }>;
      };
      const newFields: RecipeField[] = data.fields.map((f) => ({
        id: newFieldId(),
        name: f.name,
        type: f.type,
        description: f.description,
        required: f.required !== false,
        enumValues: f.enumValues,
      }));
      onUpdate({ fields: newFields, updatedAt: new Date().toISOString() });
    } catch (err) {
      setSuggestError(
        err instanceof Error ? err.message : 'Schema suggestion failed',
      );
    } finally {
      setSuggesting(false);
    }
  };

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-[#1c1c1c] overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={onToggleExpand}
          className="flex items-center gap-2 flex-1 text-left focus:outline-none"
          aria-expanded={isExpanded}
        >
          {isExpanded ? (
            <IconChevronDown size={16} className="text-gray-500" />
          ) : (
            <IconChevronRight size={16} className="text-gray-500" />
          )}
          <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
            {recipe.name || t('untitledRecipe')}
          </span>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {recipe.fields.length}{' '}
            {recipe.fields.length === 1 ? t('field') : t('fieldsPlural')}
          </span>
        </button>

        {!confirming ? (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="rounded-md p-1.5 text-gray-500 dark:text-gray-400 hover:bg-red-50 dark:hover:bg-red-900/30 hover:text-red-600 dark:hover:text-red-400 transition-colors"
            aria-label={t('deleteRecipe')}
            title={t('delete')}
          >
            <IconTrash size={14} />
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-xs text-red-600 dark:text-red-400">
              {t('deleteConfirm')}
            </span>
            <button
              type="button"
              onClick={onDelete}
              className="rounded-md px-2 py-0.5 text-xs font-medium text-white bg-red-600 hover:bg-red-700 transition-colors"
            >
              {t('delete')}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-md px-2 py-0.5 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            >
              {t('cancel')}
            </button>
          </div>
        )}
      </div>

      {isExpanded && (
        <div className="px-3 pb-3 pt-1 border-t border-gray-200 dark:border-gray-700 space-y-3 bg-gray-50/40 dark:bg-[#181818]">
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('name')}
            </label>
            <input
              type="text"
              value={recipe.name}
              onChange={(e) =>
                onUpdate({
                  name: e.target.value,
                  updatedAt: new Date().toISOString(),
                })
              }
              placeholder={t('namePlaceholder')}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#1c1c1c] px-3 py-1.5 text-sm focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('description')}{' '}
              <span className="text-gray-400 font-normal">{t('optional')}</span>
            </label>
            <input
              type="text"
              value={recipe.description || ''}
              onChange={(e) =>
                onUpdate({
                  description: e.target.value,
                  updatedAt: new Date().toISOString(),
                })
              }
              placeholder={t('descriptionPlaceholder')}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#1c1c1c] px-3 py-1.5 text-sm focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('instructions')}
            </label>
            <textarea
              value={recipe.instructions}
              onChange={(e) =>
                onUpdate({
                  instructions: e.target.value,
                  updatedAt: new Date().toISOString(),
                })
              }
              placeholder={t('instructionsPlaceholder')}
              rows={3}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-[#1c1c1c] px-3 py-1.5 text-sm focus:outline-none focus:border-blue-500 resize-y"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-gray-700 dark:text-gray-300">
                {t('fields')}
              </span>
              <button
                type="button"
                onClick={handleSuggest}
                disabled={suggesting || !recipe.instructions.trim()}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                title={
                  recipe.instructions.trim()
                    ? t('suggest')
                    : t('suggestNeedsInstructions')
                }
              >
                <IconSparkles size={14} />
                <span>{suggesting ? t('suggesting') : t('suggest')}</span>
              </button>
            </div>

            {suggestError && (
              <p className="text-xs text-red-600 dark:text-red-400 mb-2">
                {suggestError}
              </p>
            )}

            <div className="space-y-1.5">
              {recipe.fields.map((field) => (
                <FieldRow
                  key={field.id}
                  field={field}
                  onUpdate={(updates) => handleFieldUpdate(field.id, updates)}
                  onRemove={() => handleRemoveField(field.id)}
                />
              ))}
            </div>

            <button
              type="button"
              onClick={handleAddField}
              className="mt-2 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors"
            >
              <IconPlus size={12} />
              <span>{t('addField')}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

interface FieldRowProps {
  field: RecipeField;
  onUpdate: (updates: Partial<RecipeField>) => void;
  onRemove: () => void;
}

const FieldRow: FC<FieldRowProps> = ({ field, onUpdate, onRemove }) => {
  const t = useTranslations('extraction');
  const [showDetail, setShowDetail] = useState(false);

  return (
    <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-[#1c1c1c]">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <input
          type="text"
          value={field.name}
          onChange={(e) =>
            onUpdate({
              name: e.target.value
                .toLowerCase()
                .replace(/[^a-z0-9_]/g, '_')
                .replace(/^_+/, ''),
            })
          }
          placeholder={t('fieldNamePlaceholder')}
          className="flex-1 min-w-0 bg-transparent border-0 text-xs font-mono focus:outline-none placeholder:text-gray-400"
          aria-label={t('fieldName')}
        />
        <select
          value={field.type}
          onChange={(e) => onUpdate({ type: e.target.value as FieldType })}
          className="bg-transparent border-0 text-xs focus:outline-none text-gray-700 dark:text-gray-300"
          aria-label={t('fieldType')}
        >
          {FIELD_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-xs text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            checked={field.required !== false}
            onChange={(e) => onUpdate({ required: e.target.checked })}
            className="h-3 w-3"
          />
          <span>{t('required')}</span>
        </label>
        <button
          type="button"
          onClick={() => setShowDetail((v) => !v)}
          className="rounded-md p-1 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 text-xs"
          aria-label={t('toggleDetails')}
          title={t('fieldDetailsTitle')}
        >
          {showDetail ? '−' : '…'}
        </button>
        <button
          type="button"
          onClick={onRemove}
          className="rounded-md p-1 text-gray-500 dark:text-gray-400 hover:bg-red-50 dark:hover:bg-red-900/30 hover:text-red-600 dark:hover:text-red-400 transition-colors"
          aria-label={t('removeField')}
        >
          <IconX size={12} />
        </button>
      </div>

      {showDetail && (
        <div className="px-2 pb-2 border-t border-gray-100 dark:border-gray-800 space-y-1.5">
          <input
            type="text"
            value={field.description || ''}
            onChange={(e) => onUpdate({ description: e.target.value })}
            placeholder={t('fieldDescriptionPlaceholder')}
            className="w-full bg-transparent border-0 text-xs focus:outline-none placeholder:text-gray-400 text-gray-700 dark:text-gray-300 pt-1"
          />
          {field.type === 'enum' && (
            <input
              type="text"
              value={(field.enumValues || []).join(', ')}
              onChange={(e) =>
                onUpdate({
                  enumValues: e.target.value
                    .split(',')
                    .map((v) => v.trim())
                    .filter((v) => v.length > 0),
                })
              }
              placeholder={t('enumValuesPlaceholder')}
              className="w-full bg-transparent border-0 text-xs focus:outline-none placeholder:text-gray-400 text-gray-700 dark:text-gray-300"
            />
          )}
        </div>
      )}
    </div>
  );
};
