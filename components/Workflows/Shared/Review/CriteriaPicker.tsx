'use client';

import { useTranslations } from 'next-intl';

export interface CriteriaPickerItem {
  id: string;
  label: string;
  description?: string;
}

interface CriteriaPickerProps {
  criteria: CriteriaPickerItem[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  /** e.g. 'workflows.document' — provides the legend string. */
  i18nNamespace: string;
  disabled?: boolean;
}

/**
 * Checkbox row for choosing which quality criteria an assessment runs.
 * Callers build the item list (built-ins via i18n, custom criteria with
 * their raw names). At least one must remain selected — the caller
 * disables its Assess button when the set is empty.
 */
export function CriteriaPicker({
  criteria,
  selected,
  onToggle,
  i18nNamespace,
  disabled,
}: CriteriaPickerProps) {
  const t = useTranslations(i18nNamespace);

  return (
    <fieldset
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5"
      disabled={disabled}
    >
      <legend className="sr-only">{t('criteriaPicker')}</legend>
      {criteria.map((criterion) => (
        <label
          key={criterion.id}
          className="inline-flex min-h-[32px] cursor-pointer items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300"
          title={criterion.description}
        >
          <input
            type="checkbox"
            checked={selected.has(criterion.id)}
            onChange={() => onToggle(criterion.id)}
          />
          {criterion.label}
        </label>
      ))}
    </fieldset>
  );
}
