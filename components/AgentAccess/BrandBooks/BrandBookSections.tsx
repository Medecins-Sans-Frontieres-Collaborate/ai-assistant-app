'use client';

import { IconLoader, IconPlus, IconUpload } from '@tabler/icons-react';
import { useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  BRAND_COLOR_ROLES,
  BRAND_FONT_ROLES,
  BRAND_LOGO_TYPES,
  BRAND_TEMPLATE_TYPES,
  BrandBookBody,
  BrandTerm,
  brandItemId,
  templateTypeForFile,
} from '@/lib/utils/shared/brand/brandBook';
import {
  DEFAULT_COLOR_TOLERANCE,
  normalizeHex,
} from '@/lib/utils/shared/brand/brandColor';

import { DraftGroundingLine, DraftGroundingView } from './DraftGroundingLine';
import {
  EditorSection,
  Field,
  HexInput,
  ListInput,
  NumberInput,
  inputClass,
  quietButtonClass,
  removeButtonClass,
} from './brandEditorControls';

/** What every section is given: the book, and a way to change it. */
interface SectionProps {
  book: BrandBookBody;
  onChange: (book: BrandBookBody) => void;
  /** Where a draft's values are stated in its guide, while one is shown. */
  grounding?: DraftGroundingView;
}

/** How the editor uploads a file and shows one (upload or stored). */
export interface BrandFileAccess {
  /** Uploads a file; resolves to the reference a save copies into the book. */
  upload: (file: File) => Promise<string>;
  /** A URL the browser can show the file at, or null when there is none. */
  previewUrl: (ref: string) => string | null;
}

/** Replaces item `index` of a list. */
function replaced<T>(list: T[], index: number, item: T): T[] {
  return list.map((existing, at) => (at === index ? item : existing));
}

/** Removes item `index` of a list. */
function without<T>(list: T[], index: number): T[] {
  return list.filter((_, at) => at !== index);
}

/**
 * The CSS font stack that shows a typeface in its own face when the
 * browser has it, and in a plain sans-serif (never the serif default)
 * when it does not.
 */
function previewFontStack(family: string): string | undefined {
  const name = family.replace(/["\\]/g, '').trim();
  return name ? `"${name}", system-ui, sans-serif` : undefined;
}

/** Most typefaces a book holds (the schema's bound). */
const MAX_TYPEFACES = 12;

/** A row of the editor's lists: a full border, no side stripe. */
const rowClass =
  'rounded-lg border border-gray-200 p-3 dark:border-gray-700 sm:p-4';

/**
 * A button that opens a file picker. The input itself is hidden; the
 * button is what the keyboard reaches.
 */
export function UploadButton({
  accept,
  label,
  onFile,
}: {
  accept: string;
  label: string;
  onFile: (file: File) => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={accept}
        className="hidden"
        tabIndex={-1}
        aria-hidden
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          setBusy(true);
          try {
            await onFile(file);
          } finally {
            setBusy(false);
          }
        }}
      />
      <button
        type="button"
        className={quietButtonClass}
        disabled={busy}
        aria-busy={busy}
        onClick={() => input.current?.click()}
      >
        {busy ? (
          <IconLoader size={14} className="animate-spin" aria-hidden />
        ) : (
          <IconUpload size={14} aria-hidden />
        )}
        {label}
      </button>
    </>
  );
}

/** The brand colours, each with its roles and how close a match must be. */
export function PaletteSection({ book, onChange, grounding }: SectionProps) {
  const t = useTranslations('adminBrandBooks');
  const setPalette = (palette: BrandBookBody['palette']) =>
    onChange({ ...book, palette });
  return (
    <EditorSection
      title={t('palette.title')}
      description={t('palette.description')}
      action={
        <button
          type="button"
          className={quietButtonClass}
          onClick={() =>
            setPalette([
              ...book.palette,
              {
                name: t('palette.newName', { number: book.palette.length + 1 }),
                hex: '#000000',
                roles: [],
                tolerance: DEFAULT_COLOR_TOLERANCE,
              },
            ])
          }
        >
          <IconPlus size={14} aria-hidden />
          {t('palette.add')}
        </button>
      }
    >
      {book.palette.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('palette.none')}
        </p>
      ) : (
        <ul className="space-y-2">
          {book.palette.map((color, index) => (
            <li key={index} className={rowClass}>
              <div className="flex flex-wrap items-end gap-3">
                <Field label={t('palette.hex')}>
                  {(id) => (
                    <HexInput
                      id={id}
                      label={t('palette.pick', { name: color.name })}
                      value={color.hex}
                      onChange={(hex) =>
                        setPalette(
                          replaced(book.palette, index, { ...color, hex }),
                        )
                      }
                    />
                  )}
                </Field>
                <Field
                  label={t('palette.name')}
                  className="min-w-[10rem] flex-1"
                >
                  {(id) => (
                    <input
                      id={id}
                      className={inputClass}
                      value={color.name}
                      maxLength={60}
                      onChange={(event) =>
                        setPalette(
                          replaced(book.palette, index, {
                            ...color,
                            name: event.target.value,
                          }),
                        )
                      }
                    />
                  )}
                </Field>
                <Field label={t('palette.tolerance')} className="w-32">
                  {(id) => (
                    <NumberInput
                      id={id}
                      value={color.tolerance}
                      min={0}
                      max={20}
                      step={0.5}
                      onChange={(tolerance) =>
                        setPalette(
                          replaced(book.palette, index, {
                            ...color,
                            tolerance: tolerance ?? DEFAULT_COLOR_TOLERANCE,
                          }),
                        )
                      }
                    />
                  )}
                </Field>
                <button
                  type="button"
                  className={removeButtonClass}
                  aria-label={t('removeNamed', { name: color.name })}
                  onClick={() => setPalette(without(book.palette, index))}
                >
                  {t('remove')}
                </button>
              </div>
              <fieldset className="mt-3">
                <legend className="mb-1 text-xs font-medium text-gray-600 dark:text-gray-400">
                  {t('palette.roles')}
                </legend>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {BRAND_COLOR_ROLES.map((role) => (
                    <label
                      key={role}
                      className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300"
                    >
                      <input
                        type="checkbox"
                        checked={color.roles.includes(role)}
                        onChange={(event) =>
                          setPalette(
                            replaced(book.palette, index, {
                              ...color,
                              roles: event.target.checked
                                ? [...color.roles, role]
                                : color.roles.filter((r) => r !== role),
                            }),
                          )
                        }
                      />
                      {t(`colorRole.${role}`)}
                    </label>
                  ))}
                </div>
              </fieldset>
              <DraftGroundingLine
                view={grounding}
                list="colors"
                value={color.hex}
                normalize={normalizeHex}
              />
            </li>
          ))}
        </ul>
      )}
      {book.palette.length > 0 && (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          {t('palette.tolerance')}: {t('palette.toleranceHint')}
        </p>
      )}
      <Field
        label={t('palette.neutrals')}
        hint={t('palette.neutralsHint')}
        className="mt-4 max-w-md"
      >
        {(id) => (
          <ListInput
            id={id}
            values={book.neutrals}
            placeholder="#ffffff, #000000"
            onChange={(neutrals) => onChange({ ...book, neutrals })}
          />
        )}
      </Field>
    </EditorSection>
  );
}

/** The typefaces by role, their allowed substitutes, and the smallest size. */
export function TypographySection({ book, onChange, grounding }: SectionProps) {
  const t = useTranslations('adminBrandBooks');
  const setFonts = (fonts: BrandBookBody['fonts']) =>
    onChange({ ...book, fonts });
  // A new typeface takes the first role without one; with every role
  // taken it joins the last, where a guide's extra typefaces usually go.
  const nextRole =
    BRAND_FONT_ROLES.find(
      (role) => !book.fonts.some((font) => font.role === role),
    ) ?? BRAND_FONT_ROLES[BRAND_FONT_ROLES.length - 1];
  const full = book.fonts.length >= MAX_TYPEFACES;
  return (
    <EditorSection
      title={t('typography.title')}
      description={t('typography.description')}
      action={
        !full && (
          <button
            type="button"
            className={quietButtonClass}
            onClick={() =>
              setFonts([
                ...book.fonts,
                { role: nextRole, family: '', substitutes: [] },
              ])
            }
          >
            <IconPlus size={14} aria-hidden />
            {t('typography.add')}
          </button>
        )
      }
    >
      {book.fonts.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('typography.none')}
        </p>
      ) : (
        <ul className="space-y-2">
          {book.fonts.map((font, index) => (
            <li key={index} className={rowClass}>
              <div className="flex flex-wrap items-end gap-3">
                <Field label={t('typography.role')} className="w-36">
                  {(id) => (
                    <select
                      id={id}
                      className={inputClass}
                      value={font.role}
                      onChange={(event) =>
                        setFonts(
                          replaced(book.fonts, index, {
                            ...font,
                            role: event.target
                              .value as (typeof BRAND_FONT_ROLES)[number],
                          }),
                        )
                      }
                    >
                      {BRAND_FONT_ROLES.map((role) => (
                        <option key={role} value={role}>
                          {t(`fontRole.${role}`)}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                <Field
                  label={t('typography.family')}
                  className="min-w-[10rem] flex-1"
                >
                  {(id) => (
                    <input
                      id={id}
                      className={inputClass}
                      value={font.family}
                      maxLength={80}
                      style={{ fontFamily: previewFontStack(font.family) }}
                      onChange={(event) =>
                        setFonts(
                          replaced(book.fonts, index, {
                            ...font,
                            family: event.target.value,
                          }),
                        )
                      }
                    />
                  )}
                </Field>
                <Field
                  label={t('typography.substitutes')}
                  className="min-w-[12rem] flex-1"
                >
                  {(id) => (
                    <ListInput
                      id={id}
                      values={font.substitutes}
                      placeholder="Arial, Helvetica"
                      onChange={(substitutes) =>
                        setFonts(
                          replaced(book.fonts, index, { ...font, substitutes }),
                        )
                      }
                    />
                  )}
                </Field>
                <button
                  type="button"
                  className={removeButtonClass}
                  aria-label={t('removeNamed', {
                    name: font.family || t(`fontRole.${font.role}`),
                  })}
                  onClick={() => setFonts(without(book.fonts, index))}
                >
                  {t('remove')}
                </button>
              </div>
              <DraftGroundingLine
                view={grounding}
                list="fonts"
                value={font.family}
                others={font.substitutes}
              />
            </li>
          ))}
        </ul>
      )}
      <Field
        label={t('typography.minSize')}
        hint={t('typography.minSizeHint')}
        className="mt-4 w-40"
      >
        {(id) => (
          <NumberInput
            id={id}
            value={book.minTextSizePt}
            min={0}
            max={72}
            step={0.5}
            onChange={(minTextSizePt) =>
              onChange({ ...book, minTextSizePt: minTextSizePt ?? 0 })
            }
          />
        )}
      </Field>
    </EditorSection>
  );
}

/** The logo files, their smallest width, and the colours each may appear in. */
export function LogosSection({
  book,
  onChange,
  files,
  onError,
  defaultMinWidthPt,
}: SectionProps & {
  files: BrandFileAccess;
  onError: (message: string) => void;
  /** The smallest width a new logo starts with (a drafted guide's rule). */
  defaultMinWidthPt?: number;
}) {
  const t = useTranslations('adminBrandBooks');
  const setLogos = (logos: BrandBookBody['logos']) =>
    onChange({ ...book, logos });
  const colors = [
    ...book.palette.map((color) => ({ hex: color.hex, name: color.name })),
    ...book.neutrals.map((hex) => ({ hex, name: hex })),
  ].filter(
    (color, index, all) => all.findIndex((c) => c.hex === color.hex) === index,
  );
  const accept = BRAND_LOGO_TYPES.map((ext) => `.${ext}`).join(',');

  const addLogo = async (file: File) => {
    try {
      const ref = await files.upload(file);
      const name = file.name.replace(/\.[^.]+$/, '') || t('logos.untitled');
      setLogos([
        ...book.logos,
        {
          id: brandItemId(
            name,
            book.logos.map((logo) => logo.id),
          ),
          name: name.slice(0, 80),
          file: ref,
          ...(defaultMinWidthPt ? { minWidthPt: defaultMinWidthPt } : {}),
          allowedColors: [],
          aspectTolerance: 0.02,
        },
      ]);
    } catch (error) {
      onError(error instanceof Error ? error.message : t('uploadFailed'));
    }
  };

  return (
    <EditorSection
      title={t('logos.title')}
      description={t('logos.description')}
      action={
        <UploadButton accept={accept} label={t('logos.add')} onFile={addLogo} />
      }
    >
      {book.logos.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('logos.none')}
        </p>
      ) : (
        <ul className="space-y-2">
          {book.logos.map((logo, index) => {
            const preview = files.previewUrl(logo.file);
            return (
              <li key={logo.id} className={`${rowClass} flex flex-wrap gap-4`}>
                {/* A checkerboard shows a logo meant for dark or light ground. */}
                <div className="flex h-24 w-32 shrink-0 items-center justify-center rounded-md border border-gray-200 bg-[repeating-conic-gradient(#e5e7eb_0%_25%,#f9fafb_0%_50%)] bg-[length:16px_16px] p-2 dark:border-gray-700">
                  {preview ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={preview}
                      alt={logo.name}
                      className="max-h-full max-w-full object-contain"
                    />
                  ) : (
                    <span className="text-xs text-gray-500">
                      {t('logos.noPreview')}
                    </span>
                  )}
                </div>
                <div className="min-w-[14rem] flex-1 space-y-3">
                  <div className="flex flex-wrap items-end gap-3">
                    <Field
                      label={t('logos.name')}
                      className="min-w-[10rem] flex-1"
                    >
                      {(id) => (
                        <input
                          id={id}
                          className={inputClass}
                          value={logo.name}
                          maxLength={80}
                          onChange={(event) =>
                            setLogos(
                              replaced(book.logos, index, {
                                ...logo,
                                name: event.target.value,
                              }),
                            )
                          }
                        />
                      )}
                    </Field>
                    <Field label={t('logos.minWidth')} className="w-32">
                      {(id) => (
                        <NumberInput
                          id={id}
                          value={logo.minWidthPt}
                          min={0}
                          max={2000}
                          optional
                          onChange={(minWidthPt) =>
                            setLogos(
                              replaced(book.logos, index, {
                                ...logo,
                                minWidthPt,
                              }),
                            )
                          }
                        />
                      )}
                    </Field>
                    <Field label={t('logos.aspect')} className="w-36">
                      {(id) => (
                        <NumberInput
                          id={id}
                          value={Math.round(logo.aspectTolerance * 1000) / 10}
                          min={0}
                          max={50}
                          step={0.5}
                          onChange={(percent) =>
                            setLogos(
                              replaced(book.logos, index, {
                                ...logo,
                                aspectTolerance: (percent ?? 2) / 100,
                              }),
                            )
                          }
                        />
                      )}
                    </Field>
                    <button
                      type="button"
                      className={removeButtonClass}
                      aria-label={t('removeNamed', { name: logo.name })}
                      onClick={() => setLogos(without(book.logos, index))}
                    >
                      {t('remove')}
                    </button>
                  </div>
                  {/* Under the row, so a hint never lifts one field above the rest. */}
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {t('logos.aspectHint')}
                  </p>
                  {colors.length > 0 && (
                    <fieldset>
                      <legend className="mb-1 text-xs font-medium text-gray-600 dark:text-gray-400">
                        {t('logos.colors')}
                      </legend>
                      <div className="flex flex-wrap gap-x-4 gap-y-1">
                        {colors.map((color) => (
                          <label
                            key={color.hex}
                            className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300"
                          >
                            <input
                              type="checkbox"
                              checked={logo.allowedColors.includes(color.hex)}
                              onChange={(event) =>
                                setLogos(
                                  replaced(book.logos, index, {
                                    ...logo,
                                    allowedColors: event.target.checked
                                      ? [...logo.allowedColors, color.hex]
                                      : logo.allowedColors.filter(
                                          (hex) => hex !== color.hex,
                                        ),
                                  }),
                                )
                              }
                            />
                            <span
                              aria-hidden
                              className="h-3 w-3 rounded-sm border border-gray-300 dark:border-gray-600"
                              style={{ backgroundColor: color.hex }}
                            />
                            {color.name}
                          </label>
                        ))}
                      </div>
                      <p className="mt-1 text-xs text-gray-500">
                        {t('logos.colorsHint')}
                      </p>
                    </fieldset>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </EditorSection>
  );
}

/** One list of terms (preferred or banned). */
function TermList({
  terms,
  onChange,
  addLabel,
  emptyLabel,
  grounding,
}: {
  grounding?: DraftGroundingView;
  terms: BrandTerm[];
  onChange: (terms: BrandTerm[]) => void;
  addLabel: string;
  emptyLabel: string;
}) {
  const t = useTranslations('adminBrandBooks');
  return (
    <div>
      {terms.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">{emptyLabel}</p>
      ) : (
        <ul className="space-y-2">
          {terms.map((term, index) => (
            <li key={index}>
              <div className="flex flex-wrap items-end gap-3">
                <Field label={t('language.term')} className="w-44">
                  {(id) => (
                    <input
                      id={id}
                      className={inputClass}
                      value={term.term}
                      maxLength={120}
                      onChange={(event) =>
                        onChange(
                          replaced(terms, index, {
                            ...term,
                            term: event.target.value,
                          }),
                        )
                      }
                    />
                  )}
                </Field>
                <Field
                  label={t('language.alternatives')}
                  className="min-w-[10rem] flex-1"
                >
                  {(id) => (
                    <ListInput
                      id={id}
                      values={term.alternatives}
                      onChange={(alternatives) =>
                        onChange(
                          replaced(terms, index, { ...term, alternatives }),
                        )
                      }
                    />
                  )}
                </Field>
                <Field
                  label={t('language.note')}
                  className="min-w-[10rem] flex-1"
                >
                  {(id) => (
                    <input
                      id={id}
                      className={inputClass}
                      value={term.note}
                      maxLength={300}
                      onChange={(event) =>
                        onChange(
                          replaced(terms, index, {
                            ...term,
                            note: event.target.value,
                          }),
                        )
                      }
                    />
                  )}
                </Field>
                <button
                  type="button"
                  className={removeButtonClass}
                  aria-label={t('removeNamed', { name: term.term || addLabel })}
                  onClick={() => onChange(without(terms, index))}
                >
                  {t('remove')}
                </button>
              </div>
              <DraftGroundingLine
                view={grounding}
                list="terms"
                value={term.term}
                others={term.alternatives}
              />
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className={`${quietButtonClass} mt-2`}
        onClick={() =>
          onChange([...terms, { term: '', alternatives: [], note: '' }])
        }
      >
        <IconPlus size={14} aria-hidden />
        {addLabel}
      </button>
    </div>
  );
}

/** The languages, the words to use and avoid, and the voice. */
export function LanguageSection({ book, onChange, grounding }: SectionProps) {
  const t = useTranslations('adminBrandBooks');
  const setLanguage = (changes: Partial<BrandBookBody['language']>) =>
    onChange({ ...book, language: { ...book.language, ...changes } });
  return (
    <EditorSection
      title={t('language.title')}
      description={t('language.description')}
    >
      <div className="space-y-5">
        <Field
          label={t('language.locales')}
          hint={t('language.localesHint')}
          className="max-w-md"
        >
          {(id) => (
            <ListInput
              id={id}
              values={book.language.locales}
              placeholder="en, fr"
              onChange={(locales) => setLanguage({ locales })}
            />
          )}
        </Field>
        <div>
          <h3 className="mb-2 text-sm font-medium text-gray-800 dark:text-gray-200">
            {t('language.preferred')}
          </h3>
          <TermList
            terms={book.language.preferred}
            onChange={(preferred) => setLanguage({ preferred })}
            grounding={grounding}
            addLabel={t('language.addPreferred')}
            emptyLabel={t('language.nonePreferred')}
          />
        </div>
        <div>
          <h3 className="mb-2 text-sm font-medium text-gray-800 dark:text-gray-200">
            {t('language.banned')}
          </h3>
          <TermList
            terms={book.language.banned}
            onChange={(banned) => setLanguage({ banned })}
            grounding={grounding}
            addLabel={t('language.addBanned')}
            emptyLabel={t('language.noneBanned')}
          />
        </div>
        <Field label={t('language.tone')} className="max-w-2xl">
          {(id) => (
            <textarea
              id={id}
              rows={4}
              maxLength={2000}
              className={inputClass}
              value={book.language.tone}
              onChange={(event) => setLanguage({ tone: event.target.value })}
            />
          )}
        </Field>
      </div>
    </EditorSection>
  );
}

/** The Office templates documents are built from. */
export function TemplatesSection({
  book,
  onChange,
  onError,
  files,
}: SectionProps & {
  files: BrandFileAccess;
  onError: (message: string) => void;
}) {
  const t = useTranslations('adminBrandBooks');
  const setTemplates = (templates: BrandBookBody['templates']) =>
    onChange({ ...book, templates });
  const accept = BRAND_TEMPLATE_TYPES.map((ext) => `.${ext}`).join(',');

  const addTemplate = async (file: File) => {
    const type = templateTypeForFile(file.name);
    if (!type) {
      onError(t('templates.wrongType', { types: accept }));
      return;
    }
    try {
      const ref = await files.upload(file);
      const name = file.name.replace(/\.[^.]+$/, '') || t('templates.untitled');
      setTemplates([
        ...book.templates,
        {
          id: brandItemId(
            name,
            book.templates.map((template) => template.id),
          ),
          name: name.slice(0, 80),
          type,
          file: ref,
        },
      ]);
    } catch (error) {
      onError(error instanceof Error ? error.message : t('uploadFailed'));
    }
  };

  return (
    <EditorSection
      title={t('templates.title')}
      description={t('templates.description')}
      action={
        <UploadButton
          accept={accept}
          label={t('templates.add')}
          onFile={addTemplate}
        />
      }
    >
      {book.templates.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('templates.none')}
        </p>
      ) : (
        <ul className="space-y-2">
          {book.templates.map((template, index) => (
            <li
              key={template.id}
              className={`${rowClass} flex flex-wrap items-end gap-3`}
            >
              <Field
                label={t('templates.name')}
                className="min-w-[12rem] flex-1"
              >
                {(id) => (
                  <input
                    id={id}
                    className={inputClass}
                    value={template.name}
                    maxLength={80}
                    onChange={(event) =>
                      setTemplates(
                        replaced(book.templates, index, {
                          ...template,
                          name: event.target.value,
                        }),
                      )
                    }
                  />
                )}
              </Field>
              <span className="mb-1.5 rounded-full bg-gray-100 px-2 py-0.5 font-mono text-xs uppercase text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                {template.type}
              </span>
              <button
                type="button"
                className={removeButtonClass}
                aria-label={t('removeNamed', { name: template.name })}
                onClick={() => setTemplates(without(book.templates, index))}
              >
                {t('remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </EditorSection>
  );
}
