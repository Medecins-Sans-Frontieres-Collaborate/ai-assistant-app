'use client';

import { IconPlus, IconX } from '@tabler/icons-react';

import { useTranslations } from 'next-intl';

import { DocumentSpecSection } from '@/types/workflow';

export interface SpecFieldsValue {
  sections: DocumentSpecSection[];
  generalGuidance?: string;
}

interface SpecFieldsEditorProps {
  value: SpecFieldsValue;
  onChange: (value: SpecFieldsValue) => void;
  disabled?: boolean;
}

/**
 * Controlled editor for a document spec's sections + general guidance —
 * extracted from SpecManager's editor pane so admin structure guides edit
 * the exact same shape through the exact same UI. Uses the existing
 * workflows.document strings (the concepts are identical). Owns no state:
 * every change flows through onChange with the full next value.
 */
export function SpecFieldsEditor({
  value,
  onChange,
  disabled,
}: SpecFieldsEditorProps) {
  const t = useTranslations('workflows.document');

  const patchSection = (index: number, patch: Partial<DocumentSpecSection>) => {
    onChange({
      ...value,
      sections: value.sections.map((s, i) =>
        i === index ? { ...s, ...patch } : s,
      ),
    });
  };

  const inputClass =
    'rounded-lg border border-gray-300 bg-gray-50 px-2 py-1.5 text-sm text-gray-900 placeholder-gray-500 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100 dark:placeholder-gray-400';

  return (
    <fieldset disabled={disabled}>
      <div className="space-y-2">
        {value.sections.map((section, index) => (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <span className="w-4 text-xs text-gray-400">{index + 1}.</span>
            <input
              value={section.heading}
              onChange={(e) => patchSection(index, { heading: e.target.value })}
              placeholder={t('sectionHeading')}
              aria-label={t('sectionHeading')}
              className={`${inputClass} w-44`}
            />
            <input
              value={section.guidance ?? ''}
              onChange={(e) =>
                patchSection(index, { guidance: e.target.value })
              }
              placeholder={t('sectionGuidance')}
              aria-label={t('sectionGuidance')}
              className={`${inputClass} min-w-[160px] flex-1`}
            />
            <label className="inline-flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400">
              <input
                type="checkbox"
                checked={section.required}
                onChange={(e) =>
                  patchSection(index, { required: e.target.checked })
                }
              />
              {t('sectionRequired')}
            </label>
            <button
              type="button"
              onClick={() =>
                onChange({
                  ...value,
                  sections: value.sections.filter((_, i) => i !== index),
                })
              }
              aria-label={t('removeSection')}
              className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-surface-dark-elevated dark:hover:text-gray-200"
            >
              <IconX size={13} aria-hidden />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() =>
            onChange({
              ...value,
              sections: [...value.sections, { heading: '', required: true }],
            })
          }
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
        >
          <IconPlus size={13} aria-hidden />
          {t('addSection')}
        </button>
      </div>

      <textarea
        value={value.generalGuidance ?? ''}
        onChange={(e) =>
          onChange({ ...value, generalGuidance: e.target.value })
        }
        rows={2}
        placeholder={t('generalGuidance')}
        aria-label={t('generalGuidance')}
        className={`${inputClass} mt-3 w-full resize-y`}
      />
    </fieldset>
  );
}
