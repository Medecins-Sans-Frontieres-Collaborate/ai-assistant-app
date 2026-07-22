'use client';

import { IconPlus, IconTrash, IconX } from '@tabler/icons-react';
import { useState } from 'react';

import { useTranslations } from 'next-intl';

import { DocumentSpec } from '@/types/workflow';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { v4 as uuidv4 } from 'uuid';

interface SpecManagerProps {
  onClose: () => void;
}

/**
 * Inline editor for reusable document specs (format templates like a
 * SitRep): ordered sections with per-section guidance and required flags,
 * plus freeform general guidance. GlossaryManager pattern.
 */
export function SpecManager({ onClose }: SpecManagerProps) {
  const t = useTranslations('workflows.document');
  const specs = useSettingsStore((s) => s.documentSpecs);
  const addDocumentSpec = useSettingsStore((s) => s.addDocumentSpec);
  const updateDocumentSpec = useSettingsStore((s) => s.updateDocumentSpec);
  const deleteDocumentSpec = useSettingsStore((s) => s.deleteDocumentSpec);

  const [editingId, setEditingId] = useState<string | null>(
    specs[0]?.id ?? null,
  );
  const editing = specs.find((s) => s.id === editingId);

  const handleCreate = () => {
    const spec: DocumentSpec = {
      id: uuidv4(),
      name: t('newSpecName'),
      sections: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    addDocumentSpec(spec);
    setEditingId(spec.id);
  };

  const patchSection = (
    index: number,
    patch: Partial<DocumentSpec['sections'][number]>,
  ) => {
    if (!editing) return;
    updateDocumentSpec(editing.id, {
      sections: editing.sections.map((s, i) =>
        i === index ? { ...s, ...patch } : s,
      ),
    });
  };

  const inputClass =
    'rounded-lg border border-gray-300 bg-gray-50 px-2 py-1.5 text-sm text-gray-900 placeholder-gray-500 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100 dark:placeholder-gray-400';

  return (
    <div className="flex h-full flex-col border-t border-gray-200 dark:border-gray-700">
      <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {t('specs')}
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('closeSpecs')}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
        >
          <IconX size={15} aria-hidden />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="w-44 shrink-0 overflow-y-auto border-e border-gray-200 p-2 dark:border-gray-700">
          {specs.map((spec) => (
            <button
              key={spec.id}
              type="button"
              onClick={() => setEditingId(spec.id)}
              className={`mb-1 block w-full truncate rounded-md px-2 py-1.5 text-start text-sm ${
                spec.id === editingId
                  ? 'bg-gray-200 text-gray-900 dark:bg-gray-700 dark:text-gray-100'
                  : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-surface-dark-elevated'
              }`}
            >
              {spec.name}
            </button>
          ))}
          <button
            type="button"
            onClick={handleCreate}
            className="mt-1 inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
          >
            <IconPlus size={14} aria-hidden />
            {t('newSpec')}
          </button>
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto p-3">
          {editing ? (
            <>
              <div className="mb-2 flex items-center gap-2">
                <input
                  value={editing.name}
                  onChange={(e) =>
                    updateDocumentSpec(editing.id, { name: e.target.value })
                  }
                  aria-label={t('specName')}
                  className={`${inputClass} flex-1`}
                />
                <button
                  type="button"
                  onClick={() => {
                    deleteDocumentSpec(editing.id);
                    setEditingId(null);
                  }}
                  aria-label={t('deleteSpec')}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
                >
                  <IconTrash size={15} aria-hidden />
                </button>
              </div>
              <input
                value={editing.description ?? ''}
                onChange={(e) =>
                  updateDocumentSpec(editing.id, {
                    description: e.target.value,
                  })
                }
                placeholder={t('specDescription')}
                aria-label={t('specDescription')}
                className={`${inputClass} mb-3 w-full`}
              />

              <div className="space-y-2">
                {editing.sections.map((section, index) => (
                  <div
                    key={index}
                    className="flex flex-wrap items-center gap-2"
                  >
                    <span className="w-4 text-xs text-gray-400">
                      {index + 1}.
                    </span>
                    <input
                      value={section.heading}
                      onChange={(e) =>
                        patchSection(index, { heading: e.target.value })
                      }
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
                        updateDocumentSpec(editing.id, {
                          sections: editing.sections.filter(
                            (_, i) => i !== index,
                          ),
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
                    updateDocumentSpec(editing.id, {
                      sections: [
                        ...editing.sections,
                        { heading: '', required: true },
                      ],
                    })
                  }
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
                >
                  <IconPlus size={13} aria-hidden />
                  {t('addSection')}
                </button>
              </div>

              <textarea
                value={editing.generalGuidance ?? ''}
                onChange={(e) =>
                  updateDocumentSpec(editing.id, {
                    generalGuidance: e.target.value,
                  })
                }
                rows={2}
                placeholder={t('generalGuidance')}
                aria-label={t('generalGuidance')}
                className={`${inputClass} mt-3 w-full resize-y`}
              />
            </>
          ) : (
            <p className="max-w-[50ch] text-sm text-gray-500 dark:text-gray-400">
              {t('specsEmpty')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
