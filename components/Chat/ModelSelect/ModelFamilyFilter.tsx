'use client';

import { IconCategory2 } from '@tabler/icons-react';
import React from 'react';

import { useTranslations } from 'next-intl';

import { ModelProviderIcon } from './ModelProviderIcon';

/**
 * Model family ('all' plus each provider). Mirrors the `provider` union on
 * {@link OpenAIModel} (`types/openai.ts`), with an extra `'all'` sentinel for
 * the unfiltered default.
 */
export type ModelFamily =
  | 'all'
  | 'openai'
  | 'anthropic'
  | 'deepseek'
  | 'meta'
  | 'xai';

/** Display order of family filters (after the leading "All"). */
export const FAMILY_ORDER: Exclude<ModelFamily, 'all'>[] = [
  'openai',
  'anthropic',
  'deepseek',
  'meta',
  'xai',
];

/**
 * Human-readable family names — brand proper nouns, intentionally not
 * translated. Used for the icon button tooltip + accessible label.
 */
export const FAMILY_LABEL: Record<Exclude<ModelFamily, 'all'>, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek',
  meta: 'Meta',
  xai: 'xAI',
};

interface ModelFamilyFilterProps {
  /** Families that have at least one model in the current list. */
  families: Exclude<ModelFamily, 'all'>[];
  value: ModelFamily;
  onChange: (family: ModelFamily) => void;
}

/**
 * Icons-only filter row shown above the model list. An "All" pill (the default)
 * plus one provider icon per family present, so users can quickly narrow a long
 * cross-provider list down to a single family. Purely a view filter.
 */
export const ModelFamilyFilter: React.FC<ModelFamilyFilterProps> = ({
  families,
  value,
  onChange,
}) => {
  const t = useTranslations();

  const baseButton =
    'flex items-center justify-center rounded-lg border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500';
  const active =
    'border-blue-500 bg-blue-50 dark:bg-blue-500/15 ring-1 ring-blue-500';
  const inactive =
    'border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800';

  return (
    <div
      className="mb-2 flex flex-wrap items-center gap-1"
      role="group"
      aria-label={t('modelSelect.familyFilterLabel')}
    >
      <button
        type="button"
        onClick={() => onChange('all')}
        aria-pressed={value === 'all'}
        aria-label={t('modelSelect.familyAll')}
        title={t('modelSelect.familyAll')}
        className={`${baseButton} h-8 w-9 text-gray-700 dark:text-gray-200 ${
          value === 'all' ? active : inactive
        }`}
      >
        <IconCategory2 className="h-6 w-6" />
      </button>

      {families.map((family) => (
        <button
          key={family}
          type="button"
          onClick={() => onChange(family)}
          aria-pressed={value === family}
          aria-label={FAMILY_LABEL[family]}
          title={FAMILY_LABEL[family]}
          className={`${baseButton} h-8 w-9 ${
            value === family ? active : inactive
          }`}
        >
          <ModelProviderIcon provider={family} size="lg" />
        </button>
      ))}
    </div>
  );
};

export default ModelFamilyFilter;
