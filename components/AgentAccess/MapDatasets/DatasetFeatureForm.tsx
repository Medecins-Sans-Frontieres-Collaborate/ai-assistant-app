'use client';

import { useTranslations } from 'next-intl';

import {
  EventPrecision,
  MapFeature,
  MapFeatureConfidence,
  MapFeatureGranularity,
  MapFeatureProminence,
} from '@/types/workflow';

interface DatasetFeatureFormProps {
  value: MapFeature;
  onChange: (patch: Partial<MapFeature>) => void;
  onRemove: () => void;
}

const CONFIDENCES: MapFeatureConfidence[] = ['high', 'medium', 'low'];
const PROMINENCES: MapFeatureProminence[] = ['primary', 'secondary', 'mention'];
const GRANULARITIES: MapFeatureGranularity[] = [
  'site',
  'city',
  'district',
  'region',
  'country',
];
const PRECISIONS: EventPrecision[] = ['minute', 'hour', 'day', 'month', 'year'];

/**
 * Per-field editor for one dataset datapoint. Fully controlled: every change
 * patches the parent draft immediately, so lat/lon edits track live on the
 * map preview. Numeric fields tolerate in-progress typing (empty/partial
 * input patches nothing until it parses).
 */
export function DatasetFeatureForm({
  value,
  onChange,
  onRemove,
}: DatasetFeatureFormProps) {
  const t = useTranslations('adminMapDatasets');
  const tMap = useTranslations('workflows.map');

  const inputClass =
    'w-full rounded-lg border border-gray-300 bg-gray-50 px-2 py-1.5 text-sm text-gray-900 placeholder-gray-500 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100 dark:placeholder-gray-400';
  const labelClass =
    'mb-0.5 block text-xs font-medium text-gray-700 dark:text-gray-300';

  const patchNumber = (
    raw: string,
    apply: (parsed: number) => Partial<MapFeature>,
  ) => {
    const parsed = Number(raw);
    if (raw.trim() === '' || Number.isNaN(parsed)) return;
    onChange(apply(parsed));
  };

  const event = value.event;
  const patchEvent = (patch: Partial<NonNullable<MapFeature['event']>>) => {
    onChange({
      event: {
        start: event?.start ?? '',
        end: event?.end ?? null,
        precision: event?.precision ?? 'day',
        ongoing: event?.ongoing,
        ...patch,
      },
    });
  };

  return (
    <div className="space-y-2">
      <div>
        <label className={labelClass}>{t('fieldName')}</label>
        <input
          className={inputClass}
          value={value.name}
          onChange={(e) => onChange({ name: e.target.value })}
        />
      </div>
      <div>
        <label className={labelClass}>{t('fieldDescription')}</label>
        <textarea
          className={inputClass}
          rows={3}
          value={value.description}
          onChange={(e) => onChange({ description: e.target.value })}
        />
      </div>
      <div className="flex gap-2">
        <div className="flex-1">
          <label className={labelClass}>{t('fieldLat')}</label>
          <input
            className={inputClass}
            type="number"
            step="any"
            defaultValue={value.lat}
            key={`lat-${value.id}`}
            onChange={(e) => patchNumber(e.target.value, (lat) => ({ lat }))}
          />
        </div>
        <div className="flex-1">
          <label className={labelClass}>{t('fieldLon')}</label>
          <input
            className={inputClass}
            type="number"
            step="any"
            defaultValue={value.lon}
            key={`lon-${value.id}`}
            onChange={(e) => patchNumber(e.target.value, (lon) => ({ lon }))}
          />
        </div>
      </div>
      <div className="flex gap-2">
        <div className="flex-1">
          <label className={labelClass}>{t('fieldCategory')}</label>
          <input
            className={inputClass}
            value={value.category}
            onChange={(e) => onChange({ category: e.target.value })}
          />
        </div>
        <div className="flex-1">
          <label className={labelClass}>{t('fieldCountryCode')}</label>
          <input
            className={inputClass}
            maxLength={2}
            value={value.countryCode ?? ''}
            onChange={(e) =>
              onChange({
                countryCode: e.target.value
                  ? e.target.value.toUpperCase()
                  : undefined,
              })
            }
          />
        </div>
      </div>
      <div className="flex gap-2">
        <div className="flex-1">
          <label className={labelClass}>{t('fieldConfidence')}</label>
          <select
            className={inputClass}
            value={value.confidence}
            onChange={(e) =>
              onChange({
                confidence: e.target.value as MapFeatureConfidence,
              })
            }
          >
            {CONFIDENCES.map((c) => (
              <option key={c} value={c}>
                {tMap(`confidence.${c}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex-1">
          <label className={labelClass}>{t('fieldProminence')}</label>
          <select
            className={inputClass}
            value={value.prominence ?? 'primary'}
            onChange={(e) =>
              onChange({
                prominence: e.target.value as MapFeatureProminence,
              })
            }
          >
            {PROMINENCES.map((p) => (
              <option key={p} value={p}>
                {tMap(`prominence.${p}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex-1">
          <label className={labelClass}>{t('fieldGranularity')}</label>
          <select
            className={inputClass}
            value={value.granularity ?? 'city'}
            onChange={(e) =>
              onChange({
                granularity: e.target.value as MapFeatureGranularity,
              })
            }
          >
            {GRANULARITIES.map((g) => (
              <option key={g} value={g}>
                {tMap(`granularity.${g}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className={labelClass}>{t('fieldConfidenceReason')}</label>
        <input
          className={inputClass}
          value={value.confidenceReason}
          onChange={(e) => onChange({ confidenceReason: e.target.value })}
        />
      </div>
      <div className="flex gap-2">
        <div className="flex-1">
          <label className={labelClass}>{t('fieldParentName')}</label>
          <input
            className={inputClass}
            value={value.parentName ?? ''}
            onChange={(e) =>
              onChange({ parentName: e.target.value || undefined })
            }
          />
        </div>
        <div className="w-28">
          <label className={labelClass}>{t('fieldRadiusKm')}</label>
          <input
            className={inputClass}
            type="number"
            min={0}
            step="any"
            defaultValue={value.approxRadiusKm ?? 0}
            key={`radius-${value.id}`}
            onChange={(e) =>
              patchNumber(e.target.value, (approxRadiusKm) => ({
                approxRadiusKm: Math.max(0, approxRadiusKm),
              }))
            }
          />
        </div>
      </div>

      <fieldset className="rounded-lg border border-gray-200 p-2 dark:border-gray-700">
        <legend className="px-1 text-xs font-medium text-gray-700 dark:text-gray-300">
          {t('fieldEvent')}
        </legend>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className={labelClass}>{t('fieldEventStart')}</label>
            <input
              className={inputClass}
              placeholder="2026-01-15T00:00"
              value={event?.start ?? ''}
              onChange={(e) => {
                if (!e.target.value) {
                  onChange({ event: undefined });
                } else {
                  patchEvent({ start: e.target.value });
                }
              }}
            />
          </div>
          <div>
            <label className={labelClass}>{t('fieldEventEnd')}</label>
            <input
              className={inputClass}
              placeholder="2026-02-01T00:00"
              value={event?.end ?? ''}
              onChange={(e) => patchEvent({ end: e.target.value || null })}
              disabled={!event}
            />
          </div>
          <div>
            <label className={labelClass}>{t('fieldEventPrecision')}</label>
            <select
              className={inputClass}
              value={event?.precision ?? 'day'}
              onChange={(e) =>
                patchEvent({ precision: e.target.value as EventPrecision })
              }
              disabled={!event}
            >
              {PRECISIONS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <label className="mb-1.5 inline-flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400">
            <input
              type="checkbox"
              checked={event?.ongoing ?? false}
              onChange={(e) => patchEvent({ ongoing: e.target.checked })}
              disabled={!event}
            />
            {t('fieldEventOngoing')}
          </label>
        </div>
      </fieldset>

      <button
        type="button"
        onClick={onRemove}
        className="rounded-md border border-red-200 px-3 py-1 text-sm text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-900/20"
      >
        {t('removeFeature')}
      </button>
    </div>
  );
}
