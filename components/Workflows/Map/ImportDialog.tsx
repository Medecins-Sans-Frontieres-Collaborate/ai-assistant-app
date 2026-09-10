'use client';

import { IconDownload } from '@tabler/icons-react';
import { useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import { needsEnrichment } from '@/client/services/workflows/map/importEnrich';
import {
  ConfirmedImport,
  PreparedImport,
} from '@/client/services/workflows/map/mapImport';

import { downloadFile } from '@/lib/utils/shared/document/exportUtils';
import { buildImport } from '@/lib/utils/shared/geo/importBuild';
import {
  CONFIDENCE_VALUES,
  IMPORT_FIELDS,
  ImportFieldKey,
  ImportMapping,
  buildTemplateCsv,
  mappingHasRequired,
  missingRequired,
} from '@/lib/utils/shared/geo/importFields';
import { MAP_MAX_FEATURES } from '@/lib/utils/shared/geo/mapLimits';

import { MapFeature, MapFeatureConfidence } from '@/types/workflow';

import Modal from '@/components/UI/Modal';

import { useSettingsStore } from '@/client/stores/settingsStore';

/**
 * Up to this many rows, each point gets its own confidence control in the
 * preview. Beyond it a per-row table stops being reviewable and the
 * file-level default (plus a `confidence` column) is the honest tool.
 */
export const PER_ROW_CONFIDENCE_MAX = 25;

interface ImportDialogProps {
  source: PreparedImport | null;
  /** Features already present, for duplicate skipping. */
  existing: readonly Pick<MapFeature, 'name' | 'lat' | 'lon'>[];
  /** Room left before the destination's cap. */
  capacity: number;
  onConfirm: (confirmed: ConfirmedImport) => void;
  onCancel: () => void;
}

const selectClass =
  'min-h-[32px] rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 dark:border-gray-700 dark:bg-surface-dark dark:text-gray-100';

/**
 * Preview and confirm an import. Everything on it is derived from the
 * parsed rows and the current column mapping, so changing a select re-runs
 * validation and the counts update in place — the person sees exactly what
 * will land before anything does.
 *
 * The mapping step appears only when it has to: a required field is
 * unresolved, or two columns claimed the same one. A file this app exported,
 * or any spreadsheet with sane headers, goes straight to the summary.
 */
export function ImportDialog({
  source,
  existing,
  capacity,
  onConfirm,
  onCancel,
}: ImportDialogProps) {
  const t = useTranslations('workflows.map.import');
  const tCommon = useTranslations('common');
  const settingsDefault = useSettingsStore((s) => s.mapImportDefaultConfidence);
  const setSettingsDefault = useSettingsStore(
    (s) => s.setMapImportDefaultConfidence,
  );

  const [mappingEdits, setMappingEdits] = useState<ImportMapping>({});
  const [mappingOpen, setMappingOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [defaultConfidence, setDefaultConfidence] =
    useState<MapFeatureConfidence>(settingsDefault);
  const [rowConfidence, setRowConfidence] = useState<
    Record<number, MapFeatureConfidence>
  >({});
  const [enrich, setEnrich] = useState(false);

  const mapping: ImportMapping = useMemo(
    () => ({ ...(source?.detected.mapping ?? {}), ...mappingEdits }),
    [source, mappingEdits],
  );
  const ambiguous = source?.detected.ambiguous ?? {};
  // GeoJSON and KML rows carry their own position; columns are optional there.
  const hasGeometry = !!source && source.parsed.rows.some((r) => !!r.lonLat);
  const needsMapping =
    !!source &&
    (!mappingHasRequired(mapping, hasGeometry) ||
      Object.keys(ambiguous).length > 0);

  const result = useMemo(() => {
    if (!source || !mappingHasRequired(mapping, hasGeometry)) return null;
    return buildImport(source.parsed, {
      mapping,
      defaultConfidence,
      sourceName: source.sourceName,
      existing,
      capacity,
    });
  }, [source, mapping, hasGeometry, defaultConfidence, existing, capacity]);

  const features = useMemo(() => {
    if (!result) return [];
    return result.features.map((f) =>
      rowConfidence[f.rowIndex]
        ? { ...f, confidence: rowConfidence[f.rowIndex] }
        : f,
    );
  }, [result, rowConfidence]);
  const enrichable = features.filter(needsEnrichment).length;

  if (!source) return null;
  const stats = result?.stats;
  const headers = source.parsed.headers;
  const perRow =
    features.length > 0 && features.length <= PER_ROW_CONFIDENCE_MAX;

  const confirm = () => {
    if (!result || features.length === 0) return;
    setSettingsDefault(defaultConfidence);
    onConfirm({
      sourceName: source.sourceName,
      format: source.format,
      features,
      connections: source.parsed.connections,
      stats: result.stats,
      enrich: enrich && enrichable > 0,
    });
  };

  const fieldLabel = (key: ImportFieldKey) => t(`fields.${key}`);

  const mappingRow = (key: ImportFieldKey) => {
    const field = IMPORT_FIELDS.find((f) => f.key === key)!;
    const clash = ambiguous[key];
    return (
      <label
        key={key}
        className="flex items-center justify-between gap-3 text-xs"
      >
        <span className="text-gray-700 dark:text-gray-300">
          {fieldLabel(key)}
          {field.required && <span className="ms-0.5 text-red-600">*</span>}
          {clash && (
            <span className="ms-2 text-amber-700 dark:text-amber-400">
              {t('mapping.ambiguous', { headers: clash.join(', ') })}
            </span>
          )}
        </span>
        <select
          value={mapping[key] ?? ''}
          onChange={(e) =>
            setMappingEdits((prev) => ({
              ...prev,
              [key]: e.target.value || undefined,
            }))
          }
          className={selectClass}
        >
          <option value="">{t('mapping.none')}</option>
          {headers.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
      </label>
    );
  };

  const line = (text: string, tone: 'info' | 'warn' = 'info') => (
    <li
      className={
        tone === 'warn'
          ? 'text-amber-700 dark:text-amber-400'
          : 'text-gray-600 dark:text-gray-400'
      }
    >
      {text}
    </li>
  );

  return (
    <Modal
      isOpen
      onClose={onCancel}
      title={t('title', { name: source.sourceName })}
      size="lg"
      footer={
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() =>
              downloadFile(
                buildTemplateCsv(),
                'locations-template.csv',
                'text/csv',
              )
            }
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
          >
            <IconDownload size={14} aria-hidden />
            {t('guide.download')}
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg bg-neutral-200 px-4 py-2 text-neutral-900 hover:bg-neutral-300 dark:bg-neutral-700 dark:text-neutral-100 dark:hover:bg-neutral-600"
            >
              {tCommon('cancel')}
            </button>
            <button
              type="button"
              onClick={confirm}
              disabled={features.length === 0}
              className="rounded-lg bg-blue-500 px-4 py-2 text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('confirm', { count: String(features.length) })}
            </button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4 text-sm">
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t('formatLine', { format: t(`format.${source.format}`) })}
        </p>

        {/* Summary — what will land, and every decision that shaped it. */}
        <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
          <p className="font-medium text-gray-900 dark:text-gray-100">
            {result
              ? t('summary', { count: String(features.length) })
              : t('summaryNone')}
          </p>
          {stats && (
            <ul className="mt-1.5 space-y-0.5 text-xs">
              {stats.skipped.no_coordinates > 0 &&
                line(
                  t('skipped.no_coordinates', {
                    count: String(stats.skipped.no_coordinates),
                  }),
                  'warn',
                )}
              {stats.skipped.invalid_coordinates > 0 &&
                line(
                  t('skipped.invalid_coordinates', {
                    count: String(stats.skipped.invalid_coordinates),
                  }),
                  'warn',
                )}
              {stats.skipped.projected_coordinates > 0 &&
                line(
                  t('skipped.projected_coordinates', {
                    count: String(stats.skipped.projected_coordinates),
                  }),
                  'warn',
                )}
              {stats.skipped.duplicate > 0 &&
                line(
                  t('skipped.duplicate', {
                    count: String(stats.skipped.duplicate),
                  }),
                )}
              {stats.skipped.capped > 0 &&
                line(
                  `${t('skipped.capped', { count: String(stats.skipped.capped), max: String(MAP_MAX_FEATURES) })} ${t('capHint')}`,
                  'warn',
                )}
              {stats.swapped > 0 &&
                line(t('swapped', { count: String(stats.swapped) }), 'warn')}
              {stats.approximated > 0 &&
                line(t('approximated', { count: String(stats.approximated) }))}
              {stats.unnamed > 0 &&
                line(t('unnamed', { count: String(stats.unnamed) }))}
              {stats.undated > 0 &&
                line(t('undated', { count: String(stats.undated) }))}
              {stats.droppedValues > 0 &&
                line(
                  t('droppedValues', { count: String(stats.droppedValues) }),
                )}
              {stats.ignoredHeaders.length > 0 &&
                line(
                  t('ignoredHeaders', {
                    headers: stats.ignoredHeaders.join(', '),
                  }),
                )}
              {source.parsed.notes.map((note, i) =>
                note.kind === 'unsupported_geometry' ? (
                  <li key={i} className="text-amber-700 dark:text-amber-400">
                    {t('notes.unsupported_geometry', {
                      type: note.type,
                      count: String(note.count),
                    })}
                  </li>
                ) : (
                  <li key={i} className="text-gray-600 dark:text-gray-400">
                    {t(`notes.${note.kind}`)}
                  </li>
                ),
              )}
            </ul>
          )}
        </div>

        {/* Column mapping — shown when the file left a question open. */}
        {(needsMapping || mappingOpen) && (
          <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
            <p className="mb-2 text-xs font-medium text-gray-700 dark:text-gray-300">
              {t('mapping.title')}
            </p>
            {missingRequired(mapping, hasGeometry).length > 0 && (
              <p className="mb-2 text-xs text-amber-700 dark:text-amber-400">
                {t('mapping.needed')}
              </p>
            )}
            <div className="space-y-1.5">
              {IMPORT_FIELDS.filter((f) => f.required || mappingOpen).map((f) =>
                mappingRow(f.key),
              )}
              {!mappingOpen && mappingRow('coordinates')}
            </div>
          </div>
        )}
        {!needsMapping && !mappingOpen && (
          <button
            type="button"
            onClick={() => setMappingOpen(true)}
            className="self-start text-xs text-blue-600 hover:underline dark:text-blue-400"
          >
            {t('mapping.adjust')}
          </button>
        )}

        {/* Confidence: a file that states coordinates asserts them, so the
            default is a stated fact about the file, not a model's doubt. */}
        <label className="flex items-center justify-between gap-3 text-xs">
          <span className="text-gray-700 dark:text-gray-300">
            {t('defaultConfidence.label')}
          </span>
          <select
            value={defaultConfidence}
            onChange={(e) =>
              setDefaultConfidence(e.target.value as MapFeatureConfidence)
            }
            className={selectClass}
          >
            {CONFIDENCE_VALUES.map((v) => (
              <option key={v} value={v}>
                {t(`confidence.${v}`)}
              </option>
            ))}
          </select>
        </label>

        {perRow && (
          <div className="rounded-lg border border-gray-200 dark:border-gray-700">
            <p className="border-b border-gray-200 px-3 py-2 text-xs font-medium text-gray-700 dark:border-gray-700 dark:text-gray-300">
              {t('rows.title')}
            </p>
            <ul className="max-h-56 divide-y divide-gray-100 overflow-y-auto dark:divide-gray-800">
              {features.map((f) => (
                <li
                  key={f.rowIndex}
                  className="flex items-center gap-3 px-3 py-1.5 text-xs"
                >
                  <span className="min-w-0 flex-1 truncate text-gray-900 dark:text-gray-100">
                    {f.name}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-gray-500 dark:text-gray-400">
                    {f.lat.toFixed(4)}, {f.lon.toFixed(4)}
                  </span>
                  <select
                    aria-label={t('rows.confidence', { name: f.name })}
                    value={f.confidence}
                    onChange={(e) =>
                      setRowConfidence((prev) => ({
                        ...prev,
                        [f.rowIndex]: e.target.value as MapFeatureConfidence,
                      }))
                    }
                    className={selectClass}
                  >
                    {CONFIDENCE_VALUES.map((v) => (
                      <option key={v} value={v}>
                        {t(`confidence.${v}`)}
                      </option>
                    ))}
                  </select>
                </li>
              ))}
            </ul>
          </div>
        )}

        {enrichable > 0 && (
          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={enrich}
              onChange={(e) => setEnrich(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5"
            />
            <span>
              <span className="text-gray-900 dark:text-gray-100">
                {t('enrich.label', { count: String(enrichable) })}
              </span>
              <span className="block text-gray-500 dark:text-gray-400">
                {t('enrich.hint')}
              </span>
            </span>
          </label>
        )}

        {/* The field guide, generated from the same table the detector uses. */}
        <div className="rounded-lg border border-gray-200 dark:border-gray-700">
          <button
            type="button"
            onClick={() => setGuideOpen((o) => !o)}
            aria-expanded={guideOpen}
            className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-gray-700 dark:text-gray-300"
          >
            {t('guide.title')}
            <span aria-hidden>{guideOpen ? '−' : '+'}</span>
          </button>
          {guideOpen && (
            <div className="border-t border-gray-200 px-3 py-2 dark:border-gray-700">
              <p className="mb-1.5 text-xs text-gray-500 dark:text-gray-400">
                {t('guide.intro')}
              </p>
              {(['required', 'optional'] as const).map((group) => (
                <div key={group} className="mb-2">
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    {t(`guide.${group}`)}
                  </p>
                  <ul className="space-y-1 text-xs">
                    {IMPORT_FIELDS.filter(
                      (f) => f.required === (group === 'required'),
                    ).map((f) => (
                      <li key={f.key}>
                        <code className="rounded bg-gray-100 px-1 dark:bg-surface-dark-elevated">
                          {f.key}
                        </code>{' '}
                        <span className="text-gray-700 dark:text-gray-300">
                          {f.description}
                        </span>
                        {f.aliases.length > 1 && (
                          <span className="block text-[11px] text-gray-500 dark:text-gray-400">
                            {t('guide.aliases', {
                              aliases: f.aliases.slice(1).join(', '),
                            })}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
