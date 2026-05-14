'use client';

import {
  IconChevronDown,
  IconChevronRight,
  IconDeviceFloppy,
  IconDownload,
} from '@tabler/icons-react';
import { FC, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import {
  ExtractionFormat,
  exportDataset,
} from '@/lib/utils/shared/chat/extractionExport';
import { downloadFile } from '@/lib/utils/shared/document/exportUtils';

import { ExtractionDataset, ExtractionResultContent } from '@/types/chat';
import {
  ExtractionRecipe,
  FieldType,
  RecipeField,
} from '@/types/extractionRecipe';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { useUIStore } from '@/client/stores/uiStore';

interface ExtractionResultRendererProps {
  content: ExtractionResultContent;
}

const FORMATS: ExtractionFormat[] = ['json', 'csv', 'tsv'];

/**
 * Renders an `ExtractionResultContent` as a stack of download cards —
 * one per recipe. Each card surfaces the dataset as a downloadable
 * artifact (JSON / CSV / TSV) with an optional collapsed preview.
 *
 * Auto-mode datasets (those carrying `proposedSchema`) additionally
 * show a "Save as recipe" affordance.
 */
export const ExtractionResultRenderer: FC<ExtractionResultRendererProps> = ({
  content,
}) => {
  const t = useTranslations('extraction');
  const datasets = content.datasets;

  return (
    <div className="space-y-3">
      {datasets.map((dataset, index) => (
        <DatasetCard key={`${dataset.recipeId}-${index}`} dataset={dataset} />
      ))}

      {datasets.length === 0 && (
        <div className="text-sm text-gray-500 dark:text-gray-400">
          {t('noData')}
        </div>
      )}

      {content.note && (
        <p className="text-xs text-gray-500 dark:text-gray-400 italic">
          {content.note}
        </p>
      )}
    </div>
  );
};

interface DatasetCardProps {
  dataset: ExtractionDataset;
}

const DatasetCard: FC<DatasetCardProps> = ({ dataset }) => {
  const t = useTranslations('extraction');
  const defaultFormat = useUIStore((s) => s.extractionDefaultFormat);
  const setDefaultFormat = useUIStore((s) => s.setExtractionDefaultFormat);
  const addRecipe = useSettingsStore((s) => s.addExtractionRecipe);
  const existingRecipes = useSettingsStore((s) => s.extractionRecipes);

  const [showPreview, setShowPreview] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const [saved, setSaved] = useState(false);

  // The chevron button anchors the portalled menu.
  const chevronRef = useRef<HTMLButtonElement | null>(null);
  // The menu element, used for outside-click detection.
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Position the portalled menu under the chevron. `useLayoutEffect` so
  // the menu doesn't flash at the wrong position before the browser paints.
  useLayoutEffect(() => {
    if (!downloadOpen || !chevronRef.current) return;
    const rect = chevronRef.current.getBoundingClientRect();
    const menuWidth = 140;
    setMenuPosition({
      top: rect.bottom + 4,
      // Align the menu's right edge to the chevron's right edge so it doesn't
      // overflow off the viewport on narrow screens.
      left: Math.max(8, rect.right - menuWidth),
    });
  }, [downloadOpen]);

  // Dismiss on outside click / Escape / scroll / resize.
  useEffect(() => {
    if (!downloadOpen) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      const insideMenu = menuRef.current?.contains(target);
      const onChevron = chevronRef.current?.contains(target);
      if (!insideMenu && !onChevron) {
        setDownloadOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDownloadOpen(false);
    };
    const onScroll = () => setDownloadOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    // Capture-phase scroll so any scrollable ancestor closes the menu.
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [downloadOpen]);

  const rowCount = dataset.rows.length;
  const fieldCount = dataset.fields.length;
  const fieldSummary = buildFieldSummary(dataset.fields);

  const isAutoProposed =
    dataset.recipeId === 'auto' && !!dataset.proposedSchema;

  const handleDownload = (format: ExtractionFormat) => {
    const { content, mimeType, filename } = exportDataset(dataset, format);
    downloadFile(content, filename, mimeType);
    setDefaultFormat(format);
    setDownloadOpen(false);
  };

  const handleSaveAsRecipe = () => {
    if (!dataset.proposedSchema) return;
    const proposed = dataset.proposedSchema;
    const baseName = dataset.recipeName || 'Auto-extracted';
    const name = ensureUniqueName(
      baseName,
      existingRecipes.map((r) => r.name),
    );
    const now = new Date().toISOString();
    const recipe: ExtractionRecipe = {
      id: `recipe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      description: '',
      instructions:
        proposed.instructions ||
        'Extract every record described in the material below.',
      fields: proposed.fields.map(
        (f, idx): RecipeField => ({
          id: `field_${Date.now()}_${idx}`,
          name: f.name,
          label: f.label,
          type: f.type as FieldType,
          required: f.required,
          description: f.description,
        }),
      ),
      createdAt: now,
      updatedAt: now,
    };
    addRecipe(recipe);
    setSaved(true);
    toast.success(t('savedAsRecipeToast', { name }));
  };

  return (
    // `overflow-visible` is intentional: the Download menu is absolutely
    // positioned and extends below the action row. With `overflow-hidden`,
    // it'd be clipped whenever the preview is collapsed (because there's
    // no vertical room below the action row).
    <div className="relative rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-[#1c1c1c]">
      <div className="flex items-baseline justify-between gap-3 px-4 pt-3 pb-1">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
          {dataset.recipeName}
        </h3>
        <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">
          {rowCount} {rowCount === 1 ? t('record') : t('records')}
        </span>
      </div>
      <div className="px-4 pb-3">
        <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
          {fieldSummary} ·{' '}
          {fieldCount === 1
            ? t('fieldCountOne')
            : t('fieldCount', { count: fieldCount })}
        </p>
        {isAutoProposed && (
          <p className="mt-1.5 text-[11px] text-gray-500 dark:text-gray-400 italic">
            {t('proposedSchemaTip')}
          </p>
        )}
      </div>

      <div className="px-4 pb-3 flex items-center gap-2 flex-wrap">
        <div className="relative inline-flex">
          {/*
           * Split button. Left half is the dominant action — click to
           * download in the default format immediately. Right half (the
           * chevron) opens the format menu. Visually one blue pill, but
           * two distinct keyboard targets with separate aria-labels.
           */}
          <button
            type="button"
            onClick={() => handleDownload(defaultFormat)}
            className="inline-flex items-center gap-1.5 rounded-l-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium pl-3 pr-2.5 py-1.5 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 dark:focus:ring-offset-[#1c1c1c]"
            aria-label={t('downloadAriaLabel', {
              name: dataset.recipeName,
              format: formatLabel(defaultFormat, t),
            })}
          >
            <IconDownload size={14} />
            <span>
              {t('download')} · {formatLabel(defaultFormat, t)}
            </span>
          </button>
          <button
            ref={chevronRef}
            type="button"
            onClick={() => setDownloadOpen((v) => !v)}
            className="inline-flex items-center justify-center rounded-r-lg bg-blue-600 hover:bg-blue-700 text-white px-2 py-1.5 border-l border-blue-500/60 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 dark:focus:ring-offset-[#1c1c1c]"
            aria-haspopup="menu"
            aria-expanded={downloadOpen}
            aria-label={t('changeFormatAriaLabel', {
              name: dataset.recipeName,
            })}
          >
            <IconChevronDown size={12} />
          </button>

          {/*
           * Portal the menu to document.body so it escapes ancestor
           * overflow clipping (the assistant-message wrapper clips its
           * content, and a non-portalled menu gets cut off if it extends
           * past the message bounds).
           */}
          {downloadOpen &&
            menuPosition &&
            typeof document !== 'undefined' &&
            createPortal(
              <div
                ref={menuRef}
                role="menu"
                style={{
                  position: 'fixed',
                  top: menuPosition.top,
                  left: menuPosition.left,
                  width: 140,
                }}
                className="z-[10010] rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-[#252525] shadow-lg overflow-hidden"
              >
                {FORMATS.map((format) => (
                  <button
                    key={format}
                    type="button"
                    role="menuitem"
                    onClick={() => handleDownload(format)}
                    className="w-full text-left px-3 py-2 text-xs hover:bg-gray-100 dark:hover:bg-gray-700 focus:bg-gray-100 dark:focus:bg-gray-700 focus:outline-none text-gray-800 dark:text-gray-200"
                    aria-label={t('downloadAriaLabel', {
                      name: dataset.recipeName,
                      format: formatLabel(format, t),
                    })}
                  >
                    {formatLabel(format, t)}
                  </button>
                ))}
              </div>,
              document.body,
            )}
        </div>

        <button
          type="button"
          onClick={() => setShowPreview((v) => !v)}
          className="inline-flex items-center gap-1 rounded-lg border border-gray-300 dark:border-gray-700 px-2.5 py-1.5 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
          aria-expanded={showPreview}
          aria-label={t('previewAriaLabel', { name: dataset.recipeName })}
        >
          {showPreview ? (
            <IconChevronDown size={12} />
          ) : (
            <IconChevronRight size={12} />
          )}
          <span>{t('preview')}</span>
        </button>

        {isAutoProposed && (
          <button
            type="button"
            onClick={handleSaveAsRecipe}
            disabled={saved}
            className="ml-auto inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <IconDeviceFloppy size={14} />
            <span>{t('saveAsRecipe')}</span>
          </button>
        )}
      </div>

      {showPreview && <PreviewTable dataset={dataset} />}
    </div>
  );
};

interface PreviewTableProps {
  dataset: ExtractionDataset;
}

const PREVIEW_ROW_LIMIT = 3;

const PreviewTable: FC<PreviewTableProps> = ({ dataset }) => {
  const t = useTranslations('extraction');
  if (dataset.rows.length === 0) {
    return (
      <div className="px-4 pb-3 text-xs text-gray-500 dark:text-gray-400">
        {t('previewEmpty')}
      </div>
    );
  }

  const previewRows = dataset.rows.slice(0, PREVIEW_ROW_LIMIT);
  const truncated = dataset.rows.length > PREVIEW_ROW_LIMIT;

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 overflow-hidden rounded-b-lg">
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead className="bg-gray-100 dark:bg-[#252525]">
            <tr>
              {dataset.fields.map((field) => (
                <th
                  key={field.name}
                  className={`text-left px-3 py-1.5 font-medium text-gray-700 dark:text-gray-300 border-b border-gray-200 dark:border-gray-700 ${isNumericType(field.type) ? 'text-right tabular-nums' : ''}`}
                >
                  {field.label || field.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {previewRows.map((row, idx) => (
              <tr
                key={idx}
                className="border-b border-gray-100 dark:border-gray-800 last:border-b-0"
              >
                {dataset.fields.map((field) => (
                  <td
                    key={field.name}
                    className={`px-3 py-1 text-gray-800 dark:text-gray-200 align-top ${isNumericType(field.type) ? 'text-right tabular-nums' : ''}`}
                  >
                    <CellValue value={row[field.name]} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {truncated && (
        <p className="px-3 py-2 text-[11px] text-gray-500 dark:text-gray-400">
          {t('previewTruncated', { total: dataset.rows.length })}
        </p>
      )}
    </div>
  );
};

const CellValue: FC<{ value: unknown }> = ({ value }) => {
  if (value === null || value === undefined || value === '') {
    return <span className="text-gray-400 dark:text-gray-600">—</span>;
  }
  if (Array.isArray(value)) {
    return <span>{value.map((v) => String(v)).join(', ')}</span>;
  }
  if (typeof value === 'object') {
    return <code className="text-[10px]">{JSON.stringify(value)}</code>;
  }
  return <span>{String(value)}</span>;
};

function isNumericType(type: string): boolean {
  return type === 'number' || type === 'list<number>';
}

function buildFieldSummary(fields: ExtractionDataset['fields']): string {
  if (fields.length === 0) return '';
  const names = fields.map((f) => f.label || f.name);
  if (names.length <= 5) return names.join(', ');
  return `${names.slice(0, 5).join(', ')}, …`;
}

function formatLabel(
  format: ExtractionFormat,
  t: (key: string) => string,
): string {
  switch (format) {
    case 'json':
      return t('formatJson');
    case 'csv':
      return t('formatCsv');
    case 'tsv':
      return t('formatTsv');
  }
}

function ensureUniqueName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  let suffix = 2;
  while (taken.includes(`${base} (${suffix})`)) suffix++;
  return `${base} (${suffix})`;
}
