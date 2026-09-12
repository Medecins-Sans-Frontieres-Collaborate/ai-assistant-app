'use client';

import { IconAnchor, IconPlus, IconTrash } from '@tabler/icons-react';

import { useTranslations } from 'next-intl';

import { slugify } from '@/lib/services/workflows/form/deriveSchema';
import { COMMON_LANGUAGES } from '@/lib/services/workflows/form/language';

import {
  DocxTextPlacement,
  FORM_FIELD_TYPES,
  FormField,
  FormFieldType,
  FormSection,
  FormTemplate,
} from '@/types/formFill';

export type EditableTemplate = Omit<
  FormTemplate,
  'id' | 'origin' | 'createdAt' | 'updatedAt'
>;

interface TemplateEditorProps {
  value: EditableTemplate;
  onChange: (value: EditableTemplate) => void;
  disabled?: boolean;
  /** Admin editor: exposes per-field locked/prefill controls. */
  adminMode?: boolean;
}

const PLACEMENTS: DocxTextPlacement[] = [
  'after-label',
  'table-cell-right',
  'table-cell-below',
  'next-paragraph',
];

const inputClass =
  'w-full rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 focus:border-blue-600 focus:outline-none disabled:opacity-60 dark:border-gray-700 dark:bg-surface-dark dark:text-gray-100';
const labelClass =
  'block text-[11px] font-medium text-gray-600 dark:text-gray-400';

function uniqueId(base: string, items: Array<{ id: string }>): string {
  const taken = new Set(items.map((item) => item.id));
  let id = base;
  let n = 2;
  while (taken.has(id)) {
    id = `${base.slice(0, 36)}_${n}`;
    n += 1;
  }
  return id;
}

/**
 * Structural editing of a template: name, language, sections, fields with
 * type/validation, and the layout markdown. Field ids are minted from the
 * label on creation and then frozen — they are anchor keys and slot ids,
 * so renaming a label must not break the layout or the original file.
 */
export function TemplateEditor({
  value,
  onChange,
  disabled,
  adminMode,
}: TemplateEditorProps) {
  const t = useTranslations('workflows.form');

  const patch = (updates: Partial<EditableTemplate>) =>
    onChange({ ...value, ...updates });
  const patchField = (id: string, updates: Partial<FormField>) =>
    patch({
      fields: value.fields.map((f) => (f.id === id ? { ...f, ...updates } : f)),
    });
  const patchValidation = (
    id: string,
    updates: Partial<NonNullable<FormField['validation']>>,
  ) => {
    const field = value.fields.find((f) => f.id === id);
    if (!field) return;
    const validation = { ...(field.validation ?? {}), ...updates };
    for (const key of Object.keys(validation) as Array<
      keyof typeof validation
    >) {
      const v = validation[key];
      if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) {
        delete validation[key];
      }
    }
    patchField(id, {
      validation: Object.keys(validation).length > 0 ? validation : undefined,
    });
  };

  const addSection = () => {
    const heading = 'New section';
    const id = uniqueId(slugify(heading, 'section'), value.sections);
    patch({ sections: [...value.sections, { id, heading }] });
  };
  const patchSection = (id: string, updates: Partial<FormSection>) =>
    patch({
      sections: value.sections.map((s) =>
        s.id === id ? { ...s, ...updates } : s,
      ),
    });
  const removeSection = (id: string) => {
    if (value.sections.length <= 1) return;
    const fallback = value.sections.find((s) => s.id !== id)?.id ?? id;
    patch({
      sections: value.sections.filter((s) => s.id !== id),
      fields: value.fields.map((f) =>
        f.sectionId === id ? { ...f, sectionId: fallback } : f,
      ),
    });
  };

  const addField = (sectionId: string) => {
    const label = 'New field';
    const id = uniqueId(slugify(label, 'field'), value.fields);
    patch({
      fields: [
        ...value.fields,
        { id, sectionId, label, type: 'text', required: false },
      ],
      layout: value.layout.includes(`{{field:${id}}}`)
        ? value.layout
        : `${value.layout.trim()}\n\n**${label}:** {{field:${id}}}\n`,
    });
  };
  const removeField = (id: string) =>
    patch({
      fields: value.fields.filter((f) => f.id !== id),
      layout: value.layout.replace(
        new RegExp(`\\{\\{field:${id}\\}\\}`, 'g'),
        '',
      ),
    });

  // Limits are "at least 1": a 0 or negative entry means "no limit", which
  // is what the schema (`min(1)`) would otherwise reject at save/fill time.
  const numberOrUndefined = (raw: string) => {
    const n = Number(raw);
    return raw.trim() === '' || Number.isNaN(n) || n < 1
      ? undefined
      : Math.floor(n);
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <label>
          <span className={labelClass}>{t('templateName')}</span>
          <input
            value={value.name}
            disabled={disabled}
            onChange={(e) => patch({ name: e.target.value })}
            className={inputClass}
          />
        </label>
        <label>
          <span className={labelClass}>{t('templateDescription')}</span>
          <input
            value={value.description ?? ''}
            disabled={disabled}
            onChange={(e) =>
              patch({ description: e.target.value || undefined })
            }
            className={inputClass}
          />
        </label>
        <label>
          <span className={labelClass}>{t('templateLanguage')}</span>
          <input
            list="form-template-languages"
            value={value.language ?? ''}
            disabled={disabled}
            placeholder={t('languageAuto')}
            onChange={(e) => patch({ language: e.target.value || undefined })}
            className={inputClass}
          />
          <datalist id="form-template-languages">
            {COMMON_LANGUAGES.map((l) => (
              <option key={l} value={l} />
            ))}
          </datalist>
        </label>
      </div>

      {value.original && (
        <p className="text-[11px] text-gray-500 dark:text-gray-400">
          {value.original.name} · {t(`fillMode.${value.original.fillMode}`)}
        </p>
      )}

      <div className="space-y-3">
        {value.sections.map((section) => {
          const fields = value.fields.filter((f) => f.sectionId === section.id);
          return (
            <div
              key={section.id}
              className="rounded-lg border border-gray-200 p-2.5 dark:border-gray-700"
            >
              <div className="flex items-center gap-2">
                <input
                  value={section.heading}
                  disabled={disabled}
                  onChange={(e) =>
                    patchSection(section.id, { heading: e.target.value })
                  }
                  className={`${inputClass} font-semibold`}
                />
                <button
                  type="button"
                  onClick={() => addField(section.id)}
                  disabled={disabled}
                  className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
                >
                  <IconPlus size={13} aria-hidden />
                  {t('addField')}
                </button>
                <button
                  type="button"
                  onClick={() => removeSection(section.id)}
                  disabled={disabled || value.sections.length <= 1}
                  aria-label={t('removeField')}
                  className="shrink-0 rounded-lg p-1 text-gray-500 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
                >
                  <IconTrash size={13} aria-hidden />
                </button>
              </div>
              <input
                value={section.guidance ?? ''}
                disabled={disabled}
                placeholder={t('fieldDescription')}
                onChange={(e) =>
                  patchSection(section.id, {
                    guidance: e.target.value || undefined,
                  })
                }
                className={`${inputClass} mt-1`}
              />
              <ul className="mt-2 space-y-2">
                {fields.map((field) => (
                  <li
                    key={field.id}
                    className="rounded border border-gray-100 bg-gray-50 p-2 dark:border-gray-800 dark:bg-surface-dark-recessed"
                  >
                    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                      <label className="col-span-2">
                        <span className={labelClass}>{t('fieldLabel')}</span>
                        <input
                          value={field.label}
                          disabled={disabled}
                          onChange={(e) =>
                            patchField(field.id, { label: e.target.value })
                          }
                          className={inputClass}
                        />
                      </label>
                      <label>
                        <span className={labelClass}>{t('fieldType')}</span>
                        <select
                          value={field.type}
                          disabled={disabled}
                          onChange={(e) =>
                            patchField(field.id, {
                              type: e.target.value as FormFieldType,
                            })
                          }
                          className={inputClass}
                        >
                          {FORM_FIELD_TYPES.map((type) => (
                            <option key={type} value={type}>
                              {t(`types.${type}`)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="flex items-end gap-1.5 pb-1">
                        <input
                          type="checkbox"
                          checked={field.required}
                          disabled={disabled}
                          onChange={(e) =>
                            patchField(field.id, { required: e.target.checked })
                          }
                        />
                        <span className="text-xs text-gray-700 dark:text-gray-300">
                          {t('fieldRequired')}
                        </span>
                      </label>
                    </div>
                    <label className="mt-1.5 block">
                      <span className={labelClass}>
                        {t('fieldDescription')}
                      </span>
                      <input
                        value={field.description ?? ''}
                        disabled={disabled}
                        onChange={(e) =>
                          patchField(field.id, {
                            description: e.target.value || undefined,
                          })
                        }
                        className={inputClass}
                      />
                    </label>
                    <div className="mt-1.5 grid grid-cols-3 gap-1.5 sm:grid-cols-6">
                      <label>
                        <span className={labelClass}>{t('fieldMinWords')}</span>
                        <input
                          type="number"
                          value={field.validation?.minWords ?? ''}
                          disabled={disabled}
                          onChange={(e) =>
                            patchValidation(field.id, {
                              minWords: numberOrUndefined(e.target.value),
                            })
                          }
                          className={inputClass}
                        />
                      </label>
                      <label>
                        <span className={labelClass}>{t('fieldMaxWords')}</span>
                        <input
                          type="number"
                          value={field.validation?.maxWords ?? ''}
                          disabled={disabled}
                          onChange={(e) =>
                            patchValidation(field.id, {
                              maxWords: numberOrUndefined(e.target.value),
                            })
                          }
                          className={inputClass}
                        />
                      </label>
                      <label>
                        <span className={labelClass}>{t('fieldMaxChars')}</span>
                        <input
                          type="number"
                          value={field.validation?.maxChars ?? ''}
                          disabled={disabled}
                          onChange={(e) =>
                            patchValidation(field.id, {
                              maxChars: numberOrUndefined(e.target.value),
                            })
                          }
                          className={inputClass}
                        />
                      </label>
                      <label className="col-span-3">
                        <span className={labelClass}>{t('fieldSection')}</span>
                        <select
                          value={field.sectionId}
                          disabled={disabled}
                          onChange={(e) =>
                            patchField(field.id, { sectionId: e.target.value })
                          }
                          className={inputClass}
                        >
                          {value.sections.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.heading}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    {(field.type === 'enum' || field.type === 'text') && (
                      <label className="mt-1.5 block">
                        <span className={labelClass}>{t('fieldEnum')}</span>
                        <textarea
                          rows={2}
                          value={(field.validation?.enumValues ?? []).join(
                            '\n',
                          )}
                          disabled={disabled}
                          onChange={(e) =>
                            patchValidation(field.id, {
                              enumValues: e.target.value
                                .split('\n')
                                .map((v) => v.trim())
                                .filter((v) => v !== ''),
                            })
                          }
                          className={inputClass}
                        />
                      </label>
                    )}
                    {(field.type === 'longtext' ||
                      field.type === 'list<longtext>') && (
                      <label className="mt-1.5 block">
                        <span className={labelClass}>{t('fieldRubric')}</span>
                        <input
                          value={field.validation?.rubric ?? ''}
                          disabled={disabled}
                          onChange={(e) =>
                            patchValidation(field.id, {
                              rubric: e.target.value || undefined,
                            })
                          }
                          className={inputClass}
                        />
                      </label>
                    )}
                    {value.original && (
                      <div className="mt-1.5 flex flex-wrap items-end gap-1.5">
                        <span className="inline-flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400">
                          <IconAnchor size={11} aria-hidden />
                          {field.anchor
                            ? t('fieldAnchored')
                            : t('fieldUnanchored')}
                        </span>
                        {value.original.mime === 'docx' && (
                          <>
                            <input
                              value={
                                field.anchor?.kind === 'docx-text'
                                  ? field.anchor.labelText
                                  : field.anchor?.kind === 'docx-control'
                                    ? field.anchor.tag
                                    : ''
                              }
                              disabled={disabled}
                              placeholder={t('anchorLabelPlaceholder')}
                              onChange={(e) => {
                                const labelText = e.target.value;
                                if (!labelText.trim()) {
                                  patchField(field.id, { anchor: undefined });
                                  return;
                                }
                                patchField(field.id, {
                                  anchor: {
                                    kind: 'docx-text',
                                    labelText,
                                    occurrence:
                                      field.anchor?.kind === 'docx-text'
                                        ? field.anchor.occurrence
                                        : 0,
                                    placement:
                                      field.anchor?.kind === 'docx-text'
                                        ? field.anchor.placement
                                        : 'after-label',
                                  },
                                });
                              }}
                              className={`${inputClass} w-48 flex-none`}
                            />
                            {field.anchor?.kind === 'docx-text' && (
                              <select
                                value={field.anchor.placement}
                                disabled={disabled}
                                onChange={(e) =>
                                  patchField(field.id, {
                                    anchor: {
                                      ...(field.anchor as Extract<
                                        FormField['anchor'],
                                        { kind: 'docx-text' }
                                      >),
                                      placement: e.target
                                        .value as DocxTextPlacement,
                                    },
                                  })
                                }
                                className={`${inputClass} w-40 flex-none`}
                              >
                                {PLACEMENTS.map((p) => (
                                  <option key={p} value={p}>
                                    {t(`placement.${p}`)}
                                  </option>
                                ))}
                              </select>
                            )}
                          </>
                        )}
                        {value.original.mime === 'pdf' && (
                          <input
                            value={
                              field.anchor?.kind === 'pdf-field'
                                ? field.anchor.fieldName
                                : ''
                            }
                            disabled={disabled}
                            placeholder={t('anchorPdfPlaceholder')}
                            onChange={(e) =>
                              patchField(field.id, {
                                anchor: e.target.value.trim()
                                  ? {
                                      kind: 'pdf-field',
                                      fieldName: e.target.value,
                                    }
                                  : undefined,
                              })
                            }
                            className={`${inputClass} w-56 flex-none`}
                          />
                        )}
                      </div>
                    )}
                    {adminMode && (
                      <div className="mt-1.5 flex flex-wrap items-end gap-2 rounded border border-dashed border-gray-300 p-1.5 dark:border-gray-600">
                        <label className="flex items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300">
                          <input
                            type="checkbox"
                            checked={field.admin?.locked === true}
                            disabled={disabled}
                            onChange={(e) =>
                              patchField(field.id, {
                                admin: {
                                  ...(field.admin ?? {}),
                                  locked: e.target.checked || undefined,
                                },
                              })
                            }
                          />
                          {t('adminLocked')}
                        </label>
                        <label>
                          <span className={labelClass}>
                            {t('adminPrefill')}
                          </span>
                          <select
                            value={
                              field.admin?.prefill?.kind === 'user'
                                ? `user:${field.admin.prefill.attribute}`
                                : field.admin?.prefill?.kind === 'constant'
                                  ? 'constant'
                                  : ''
                            }
                            disabled={disabled}
                            onChange={(e) => {
                              const v = e.target.value;
                              const prefill =
                                v === ''
                                  ? undefined
                                  : v === 'constant'
                                    ? {
                                        kind: 'constant' as const,
                                        value:
                                          field.admin?.prefill?.kind ===
                                          'constant'
                                            ? field.admin.prefill.value
                                            : '',
                                      }
                                    : {
                                        kind: 'user' as const,
                                        attribute: v.slice(5) as
                                          | 'displayName'
                                          | 'email'
                                          | 'department'
                                          | 'jobTitle'
                                          | 'officeLocation',
                                      };
                              patchField(field.id, {
                                admin: { ...(field.admin ?? {}), prefill },
                              });
                            }}
                            className={inputClass}
                          >
                            <option value="">{t('adminPrefillNone')}</option>
                            <option value="constant">
                              {t('adminPrefillConstant')}
                            </option>
                            <option value="user:displayName">
                              {t('adminPrefillUser.displayName')}
                            </option>
                            <option value="user:email">
                              {t('adminPrefillUser.email')}
                            </option>
                            <option value="user:department">
                              {t('adminPrefillUser.department')}
                            </option>
                            <option value="user:jobTitle">
                              {t('adminPrefillUser.jobTitle')}
                            </option>
                            <option value="user:officeLocation">
                              {t('adminPrefillUser.officeLocation')}
                            </option>
                          </select>
                        </label>
                        {field.admin?.prefill?.kind === 'constant' && (
                          <input
                            value={field.admin.prefill.value}
                            disabled={disabled}
                            placeholder={t('adminPrefillValue')}
                            onChange={(e) =>
                              patchField(field.id, {
                                admin: {
                                  ...(field.admin ?? {}),
                                  prefill: {
                                    kind: 'constant',
                                    value: e.target.value,
                                  },
                                },
                              })
                            }
                            className={`${inputClass} w-56 flex-none`}
                          />
                        )}
                      </div>
                    )}
                    <div className="mt-1 flex items-center">
                      <code className="text-[10px] text-gray-400">
                        {field.id}
                      </code>
                      <button
                        type="button"
                        onClick={() => removeField(field.id)}
                        disabled={disabled}
                        className="ms-auto inline-flex items-center gap-1 rounded-lg px-1.5 py-0.5 text-[11px] text-red-700 hover:bg-red-50 disabled:opacity-30 dark:text-red-400 dark:hover:bg-red-900/20"
                      >
                        <IconTrash size={11} aria-hidden />
                        {t('removeField')}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        <button
          type="button"
          onClick={addSection}
          disabled={disabled}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
        >
          <IconPlus size={13} aria-hidden />
          {t('addSection')}
        </button>
      </div>

      <label className="block">
        <span className={labelClass}>{t('rules')}</span>
        <textarea
          rows={3}
          value={(value.rules ?? []).join('\n')}
          disabled={disabled}
          placeholder={t('rulesPlaceholder')}
          onChange={(e) =>
            patch({
              rules: e.target.value
                .split('\n')
                .map((r) => r.trim())
                .filter((r) => r !== ''),
            })
          }
          className={inputClass}
        />
        <span className="text-[11px] text-gray-500 dark:text-gray-400">
          {t('rulesHint')}
        </span>
      </label>

      <label className="block">
        <span className={labelClass}>{t('layout')}</span>
        <textarea
          rows={10}
          value={value.layout}
          disabled={disabled}
          onChange={(e) => patch({ layout: e.target.value })}
          className={`${inputClass} font-mono`}
        />
        <span className="text-[11px] text-gray-500 dark:text-gray-400">
          {t('layoutHint')}
        </span>
      </label>
    </div>
  );
}
