'use client';

import {
  IconArrowLeft,
  IconPaperclip,
  IconPlus,
  IconWorld,
  IconX,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';

import { useLocale, useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';

import {
  fetchUrlContent,
  hostnameOf,
  isLikelyUrl,
  urlErrorKey,
} from '@/client/services/url/urlFetchClient';
import { uploadAndExtractText } from '@/client/services/workflows/fileTextExtraction';
import { extractMapFeatures } from '@/client/services/workflows/map/mapExtraction';
import type {
  MapDataset,
  MapDatasetSourceRecord,
} from '@/lib/services/agentAccess/types';

import {
  connectionsWithoutFeature,
  resolveConnections,
} from '@/lib/utils/shared/geo/connections';
import { formatFeatureDates } from '@/lib/utils/shared/geo/eventTime';
import { findDemotedAreaIds } from '@/lib/utils/shared/geo/granularity';
import { MAX_DATASET_FEATURES } from '@/lib/utils/shared/geo/mapLimits';

import { MapConnection, MapFeature } from '@/types/workflow';

import { FeatureList } from '../../Workflows/Map/FeatureList';
import type { MapFocus } from '../../Workflows/Map/MapView';
import { AdminMapDatasetResponse } from '../types';
import { DatasetFeatureForm } from './DatasetFeatureForm';

import { Link } from '@/lib/navigation';
import { v4 as uuidv4 } from 'uuid';

const MapView = dynamic(() => import('../../Workflows/Map/MapView'), {
  ssr: false,
});

interface MapDatasetEditorProps {
  datasetId: string;
}

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'loaded' };

/**
 * Full-page curation editor for one admin map dataset: Leaflet preview +
 * the workspace's virtualized FeatureList + a per-field form, plus the SAME
 * generation composer methods the map workflow offers (paste / web search /
 * file / URL → extraction). Whole-dataset saves go through the data blob's
 * If-Match CAS; a 409 shows a conflict banner whose reload discards the
 * draft explicitly (never silently).
 */
export function MapDatasetEditor({ datasetId }: MapDatasetEditorProps) {
  const t = useTranslations('adminMapDatasets');
  const tMap = useTranslations('workflows.map');
  const tUrl = useTranslations('urlFetch');
  const locale = useLocale();

  const [loadState, setLoadState] = useState<LoadState>({ phase: 'loading' });
  const [etag, setEtag] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [features, setFeatures] = useState<MapFeature[]>([]);
  const [connections, setConnections] = useState<MapConnection[]>([]);
  const [sources, setSources] = useState<MapDatasetSourceRecord[]>([]);
  const [dirty, setDirty] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isConflict, setIsConflict] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [sourceText, setSourceText] = useState('');
  const [searchMode, setSearchMode] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [composerNotice, setComposerNotice] = useState<string | null>(null);

  const seedFromServer = useCallback((data: AdminMapDatasetResponse) => {
    setEtag(data.etag);
    setName(data.dataset.name);
    setDescription(data.dataset.description);
    setTags(data.dataset.tags);
    // Dataset payload types are structural twins of the workspace types.
    setFeatures(data.dataset.features as MapFeature[]);
    setConnections(data.dataset.connections as MapConnection[]);
    setSources(data.dataset.sources);
    setDirty(false);
    setSelectedId(null);
    setIsConflict(false);
    setSaveError(null);
  }, []);

  const load = useCallback(async () => {
    setLoadState({ phase: 'loading' });
    try {
      const response = await fetch(
        `/api/agent-access/map-datasets/${datasetId}`,
      );
      const parsed = await response.json().catch(() => null);
      if (!response.ok || !parsed?.success) {
        throw new Error(parsed?.error || `Request failed (${response.status})`);
      }
      seedFromServer(parsed.data as AdminMapDatasetResponse);
      setLoadState({ phase: 'loaded' });
    } catch (err) {
      setLoadState({
        phase: 'error',
        message: err instanceof Error ? err.message : 'Failed to load',
      });
    }
  }, [datasetId, seedFromServer]);

  useEffect(() => {
    void load();
  }, [load]);

  // Unsaved-changes guard: the draft lives only in memory.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const markDirty = () => setDirty(true);

  const selected = features.find((f) => f.id === selectedId) ?? null;
  const demotedIds = useMemo(() => findDemotedAreaIds(features), [features]);

  const confidenceLabel = useCallback(
    (confidence: string) => tMap(`confidence.${confidence}`),
    [tMap],
  );
  const prominenceLabel = useCallback(
    (prominence: string) => tMap(`prominence.${prominence}`),
    [tMap],
  );
  const granularityLabel = useCallback(
    (granularity: string) => tMap(`granularity.${granularity}`),
    [tMap],
  );
  const dateLabel = useCallback(
    (feature: MapFeature) => formatFeatureDates(feature, locale, tMap),
    [locale, tMap],
  );
  const sourceNameById = useMemo(
    () => new Map(sources.map((s) => [s.id, s.name])),
    [sources],
  );
  const sourceLabel = useCallback(
    (feature: MapFeature) => {
      const sourceName = feature.sourceId
        ? sourceNameById.get(feature.sourceId)
        : undefined;
      if (!sourceName) return null;
      return { name: sourceName, href: null };
    },
    [sourceNameById],
  );

  const handleFocus = (id: string) => {
    setSelectedId(id);
    setFocus((prev) => ({ id, nonce: (prev?.nonce ?? 0) + 1 }));
  };

  const handleRemove = (id: string) => {
    setFeatures((prev) => prev.filter((f) => f.id !== id));
    setConnections((prev) => connectionsWithoutFeature(prev, id));
    if (selectedId === id) setSelectedId(null);
    markDirty();
  };

  const handlePatchSelected = (patch: Partial<MapFeature>) => {
    if (!selectedId) return;
    setFeatures((prev) =>
      prev.map((f) => (f.id === selectedId ? { ...f, ...patch } : f)),
    );
    markDirty();
  };

  const handleAddManual = () => {
    const feature: MapFeature = {
      id: uuidv4(),
      name: t('newFeatureName'),
      description: '',
      lat: 0,
      lon: 0,
      confidence: 'high',
      confidenceReason: t('manualEntryReason'),
      category: '',
    };
    setFeatures((prev) => [...prev, feature]);
    setSelectedId(feature.id);
    markDirty();
  };

  const appendGenerated = (
    incoming: MapFeature[],
    newConnections: MapConnection[],
    record: MapDatasetSourceRecord,
  ) => {
    setFeatures((prev) => [...prev, ...incoming]);
    setConnections((prev) => [...prev, ...newConnections]);
    setSources((prev) => [...prev, record]);
    markDirty();
  };

  const runGeneration = async (
    input: { sourceText: string } | { searchQuery: string },
    sourceName: string,
    kind: 'text' | 'file' | 'search' | 'url',
    url?: string,
  ) => {
    setComposerNotice(null);
    setGenerating(true);
    try {
      const result = await extractMapFeatures(input, {
        existingNames: features.map((f) => f.name),
      });
      if (result.features.length === 0) {
        setComposerNotice(tMap('noneFound'));
        return;
      }
      if (features.length + result.features.length > MAX_DATASET_FEATURES) {
        setComposerNotice(
          t('capReached', { max: String(MAX_DATASET_FEATURES) }),
        );
        return;
      }
      const sourceId = uuidv4();
      const incoming = result.features.map((f) => ({
        ...f,
        id: uuidv4(),
        sourceId,
      }));
      const { connections: resolved } = resolveConnections(
        result.connections,
        [...incoming, ...features],
        uuidv4,
        sourceId,
      );
      appendGenerated(incoming, resolved, {
        id: sourceId,
        name: sourceName,
        addedAt: new Date().toISOString(),
        featureCount: incoming.length,
        kind,
        ...(kind === 'search' && 'searchQuery' in input
          ? { query: input.searchQuery }
          : {}),
        ...(url ? { url } : {}),
      });
      setSourceText('');
      setComposerNotice(t('generated', { count: String(incoming.length) }));
    } catch (err) {
      setComposerNotice(
        err instanceof Error ? err.message : t('generationFailed'),
      );
    } finally {
      setGenerating(false);
    }
  };

  const handleComposerSubmit = async () => {
    const trimmed = sourceText.trim();
    if (!trimmed || generating) return;
    if (searchMode) {
      await runGeneration({ searchQuery: trimmed }, trimmed, 'search');
      return;
    }
    if (isLikelyUrl(trimmed)) {
      setGenerating(true);
      setComposerNotice(null);
      const result = await fetchUrlContent(trimmed);
      if (!result.ok) {
        setComposerNotice(
          `${tUrl(urlErrorKey(result.code))} ${tUrl('fallbackHint')}`,
        );
        setGenerating(false);
        return;
      }
      const { text, title, resolvedUrl } = result.page;
      const sourceName = (
        title?.trim() ||
        hostnameOf(resolvedUrl) ||
        tUrl('sourceFallback')
      ).slice(0, 120);
      await runGeneration({ sourceText: text }, sourceName, 'url', resolvedUrl);
      return;
    }
    await runGeneration({ sourceText: trimmed }, t('pastedTextSource'), 'text');
  };

  const handleUploadFile = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file || generating) return;
    setGenerating(true);
    setComposerNotice(null);
    try {
      const extracted = await uploadAndExtractText(file);
      if (!extracted.text.trim()) {
        setComposerNotice(t('fileEmpty', { name: file.name }));
        setGenerating(false);
        return;
      }
      await runGeneration({ sourceText: extracted.text }, file.name, 'file');
    } catch (err) {
      setComposerNotice(
        err instanceof Error ? err.message : t('generationFailed'),
      );
      setGenerating(false);
    }
  };

  const handleSave = async () => {
    if (!etag) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      const response = await fetch(
        `/api/agent-access/map-datasets/${datasetId}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'If-Match': etag,
          },
          body: JSON.stringify({
            name: name.trim(),
            description: description.trim(),
            tags,
            features,
            connections,
            sources,
          }),
        },
      );
      if (response.status === 409) {
        setIsConflict(true);
        return;
      }
      const parsed = await response.json().catch(() => null);
      if (!response.ok || !parsed?.success) {
        setSaveError(parsed?.error || `Request failed (${response.status})`);
        return;
      }
      seedFromServer(parsed.data as AdminMapDatasetResponse);
      toast.success(t('saved'));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  const removeConnection = (id: string) => {
    setConnections((prev) => prev.filter((c) => c.id !== id));
    markDirty();
  };

  const featureNameById = useMemo(
    () => new Map(features.map((f) => [f.id, f.name])),
    [features],
  );

  const inputClass =
    'rounded-lg border border-gray-300 bg-gray-50 px-2 py-1.5 text-sm text-gray-900 placeholder-gray-500 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100 dark:placeholder-gray-400';

  if (loadState.phase === 'loading') {
    return (
      <div className="flex h-full items-center justify-center text-sm text-gray-500 dark:text-gray-400">
        {t('loading')}
      </div>
    );
  }
  if (loadState.phase === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-red-600 dark:text-red-400">
        <p>{loadState.message}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-md border border-gray-300 px-3 py-1 text-sm text-black hover:bg-gray-100 dark:border-gray-600 dark:text-white dark:hover:bg-gray-800"
        >
          {t('retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white dark:bg-surface-dark-base">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 border-b border-gray-200 px-4 py-2 dark:border-gray-700">
        <Link
          href="/admin/agent-access"
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-black dark:text-gray-400 dark:hover:text-white"
        >
          <IconArrowLeft size={16} aria-hidden />
          {t('back')}
        </Link>
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            markDirty();
          }}
          aria-label={t('datasetName')}
          className={`${inputClass} w-72 font-medium`}
        />
        <input
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
            markDirty();
          }}
          placeholder={t('datasetDescription')}
          aria-label={t('datasetDescription')}
          className={`${inputClass} min-w-[200px] flex-1`}
        />
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {t('featureCount', { count: String(features.length) })}
        </span>
        {dirty && (
          <span className="text-xs text-amber-600 dark:text-amber-400">
            {t('unsavedChanges')}
          </span>
        )}
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!dirty || isSaving || name.trim() === ''}
          className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
        >
          {isSaving ? t('saving') : t('save')}
        </button>
      </div>

      {isConflict && (
        <div className="flex items-center gap-3 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
          <p>{t('conflict')}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-md bg-amber-600 px-3 py-1 text-sm font-medium text-white hover:bg-amber-700"
          >
            {t('conflictReload')}
          </button>
        </div>
      )}
      {saveError && (
        <p className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-900/20 dark:text-red-400">
          {saveError}
        </p>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Map + composer column */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <MapView
              features={features}
              connections={connections}
              demotedIds={demotedIds}
              focus={focus}
              confidenceLabel={confidenceLabel}
              prominenceLabel={prominenceLabel}
              granularityLabel={granularityLabel}
              dateLabel={dateLabel}
              sourceLabel={sourceLabel}
            />
          </div>

          {/* Generation composer — the same methods as the map workflow. */}
          <div className="border-t border-gray-200 p-3 dark:border-gray-700">
            {composerNotice && (
              <p className="mb-2 text-sm text-amber-700 dark:text-amber-400">
                {composerNotice}
              </p>
            )}
            <div className="flex items-end gap-2">
              <textarea
                value={sourceText}
                onChange={(e) => setSourceText(e.target.value)}
                rows={searchMode ? 1 : 2}
                disabled={generating}
                placeholder={
                  searchMode
                    ? tMap('searchPlaceholder')
                    : tMap('inputPlaceholder')
                }
                onKeyDown={(e) => {
                  if (
                    (searchMode || isLikelyUrl(sourceText.trim())) &&
                    e.key === 'Enter' &&
                    !e.shiftKey
                  ) {
                    e.preventDefault();
                    void handleComposerSubmit();
                  }
                }}
                className={`${inputClass} min-h-[44px] flex-1 resize-none`}
              />
              <button
                type="button"
                onClick={() => setSearchMode((mode) => !mode)}
                disabled={generating}
                aria-pressed={searchMode}
                aria-label={tMap('searchToggle')}
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg disabled:opacity-30 ${
                  searchMode
                    ? 'bg-blue-600 text-white hover:bg-blue-700'
                    : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated'
                }`}
              >
                <IconWorld size={16} aria-hidden />
              </button>
              {!searchMode && (
                <label
                  aria-label={tMap('uploadFile')}
                  className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
                >
                  <IconPaperclip size={16} aria-hidden />
                  <input
                    type="file"
                    accept=".pdf,.doc,.docx,.txt,.md,.csv,.json,.xlsx"
                    hidden
                    onChange={(e) => void handleUploadFile(e.target.files)}
                  />
                </label>
              )}
              <button
                type="button"
                onClick={() => void handleComposerSubmit()}
                disabled={generating || !sourceText.trim()}
                className="min-h-[36px] shrink-0 rounded-lg bg-gray-300 px-3 py-2 text-sm font-medium text-gray-900 hover:bg-gray-400 disabled:pointer-events-none disabled:opacity-30 dark:bg-surface-dark-base dark:text-white dark:hover:bg-surface-dark-elevated"
              >
                {generating
                  ? tMap('finding')
                  : searchMode
                    ? tMap('searchAndMap')
                    : tMap('mapIt')}
              </button>
            </div>
          </div>
        </div>

        {/* List + form column */}
        <div className="flex w-96 shrink-0 flex-col border-s border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2 dark:border-gray-700">
            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {t('datapoints')}
            </p>
            <button
              type="button"
              onClick={handleAddManual}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
            >
              <IconPlus size={13} aria-hidden />
              {t('addFeature')}
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <FeatureList
              features={features}
              sourceLabel={sourceLabel}
              demotedIds={demotedIds}
              onFocus={handleFocus}
              onRemove={handleRemove}
            />
          </div>
          {selected && (
            <div className="max-h-[45%] overflow-y-auto border-t border-gray-200 p-3 dark:border-gray-700">
              <DatasetFeatureForm
                key={selected.id}
                value={selected}
                onChange={handlePatchSelected}
                onRemove={() => handleRemove(selected.id)}
              />
            </div>
          )}
          {connections.length > 0 && (
            <div className="max-h-40 overflow-y-auto border-t border-gray-200 p-3 dark:border-gray-700">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                {t('connectionsTitle', {
                  count: String(connections.length),
                })}
              </p>
              <ul className="space-y-1">
                {connections.map((connection) => (
                  <li
                    key={connection.id}
                    className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {featureNameById.get(connection.fromId) ?? '?'} →{' '}
                      {featureNameById.get(connection.toId) ?? '?'}
                      {connection.kind ? ` (${connection.kind})` : ''}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeConnection(connection.id)}
                      aria-label={t('removeConnection')}
                      className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-surface-dark-elevated dark:hover:text-gray-200"
                    >
                      <IconX size={12} aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
