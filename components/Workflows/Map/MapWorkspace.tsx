'use client';

import {
  IconDownload,
  IconHistory,
  IconInfoCircle,
  IconPaperclip,
  IconWorld,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useLocale, useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';

import { useAutoFocusComposer } from '@/client/hooks/ui/useAutoFocusComposer';
import { usePasteComposer } from '@/client/hooks/ui/usePasteComposer';

import {
  fetchUrlContent,
  hostnameOf,
  isLikelyUrl,
  urlErrorKey,
} from '@/client/services/url/urlFetchClient';
import { uploadAndExtractText } from '@/client/services/workflows/fileTextExtraction';
import { appendWorkflowRailMessages } from '@/client/services/workflows/railMessages';
import { nameWorkflowConversation } from '@/client/services/workflows/workflowTitle';

import { downloadFile } from '@/lib/utils/shared/document/exportUtils';
import {
  buildCategoryChips,
  featureMatchesCategories,
} from '@/lib/utils/shared/geo/categories';
import {
  NamedConnection,
  connectionsWithoutFeature,
  resolveConnections,
} from '@/lib/utils/shared/geo/connections';
import {
  featureEventRange,
  featureVerdictAt,
  formatFeatureDates,
} from '@/lib/utils/shared/geo/eventTime';
import {
  buildSourceIndex,
  featureSource,
  sourceHref,
} from '@/lib/utils/shared/geo/featureSources';
import { featuresToGeoJson } from '@/lib/utils/shared/geo/geojson';
import { findDemotedAreaIds } from '@/lib/utils/shared/geo/granularity';
import { featuresToKml } from '@/lib/utils/shared/geo/kml';
import { computeTimelineKeyframes } from '@/lib/utils/shared/geo/timelineKeyframes';
import {
  DateRange,
  computeTimelineScale,
  featureDateRangeVerdict,
  isDateRangeActive,
  msToStep,
  stepToMs,
} from '@/lib/utils/shared/geo/timelineScale';

import { EventPrecision, MapFeature, MapWorkflowState } from '@/types/workflow';

import { WorkflowWorkspaceProps } from '../registry';
import { CategoryFilterBar } from './CategoryFilterBar';
import { DateRangeFilter } from './DateRangeFilter';
import { FeatureList } from './FeatureList';
import type { MapFocus } from './MapView';
import { TimelineControl } from './TimelineControl';
import { TimelineJumpBanner } from './TimelineJumpBanner';
import { useTimelinePlayback } from './useTimelinePlayback';
import { useTimelineSpotlight } from './useTimelineSpotlight';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import Papa from 'papaparse';
import { v4 as uuidv4 } from 'uuid';

// Leaflet touches `window` at import time — client-only chunk.
const MapView = dynamic(() => import('./MapView'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center bg-gray-50 dark:bg-surface-dark-recessed">
      <span className="animate-pulse text-sm text-gray-500 dark:text-gray-400">
        …
      </span>
    </div>
  ),
});

const MAX_FEATURES = 2_000;

export function MapWorkspace({ conversationId }: WorkflowWorkspaceProps) {
  const t = useTranslations('workflows');
  const tMap = useTranslations('workflows.map');
  // Link-fetch copy is shared with the chat composer, so it lives in its own
  // top-level namespace rather than under workflows.map.
  const tUrl = useTranslations('urlFetch');
  const locale = useLocale();
  const conversation = useConversationStore((s) =>
    s.conversations.find((c) => c.id === conversationId),
  );
  const updateWorkflowState = useConversationStore(
    (s) => s.updateWorkflowState,
  );

  const state =
    conversation?.workflowState?.kind === 'map'
      ? (conversation.workflowState as MapWorkflowState)
      : undefined;

  const [sourceText, setSourceText] = useState('');
  const [searchMode, setSearchMode] = useState(false);
  // 'fetching' is the URL path's extra leg, so the button can say what it is
  // waiting on rather than showing one undifferentiated spinner label.
  const [phase, setPhase] = useState<'idle' | 'fetching' | 'extracting'>(
    'idle',
  );
  const busy = phase !== 'idle';

  // Stray typing and pasting land in the source box. No `onAttach`: this
  // field is meant to receive pasted prose that gets mined for locations,
  // and it already routes a pasted link through its own URL path.
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const appendSource = useCallback(
    (text: string) => setSourceText((prev) => prev + text),
    [],
  );
  useAutoFocusComposer({
    textareaRef: sourceRef,
    enabled: !busy,
    append: appendSource,
  });
  usePasteComposer({
    textareaRef: sourceRef,
    enabled: !busy,
    append: appendSource,
  });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tileError, setTileError] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  // Nonce so re-clicking the same list row re-centers the map.
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const focusNonceRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const features = useMemo(() => state?.features ?? [], [state?.features]);
  const hasFeatures = features.length > 0;

  const focusFeature = (id: string) => {
    focusNonceRef.current += 1;
    setFocus({ id, nonce: focusNonceRef.current });
  };

  /* ---- category filters (ephemeral view state) ---- */
  const [activeCategories, setActiveCategories] = useState<Set<string>>(
    new Set(),
  );
  const { chips, chipKeys } = useMemo(
    () => buildCategoryChips(features),
    [features],
  );
  const categoryFiltered = useMemo(
    () =>
      features.filter((f) =>
        featureMatchesCategories(f, activeCategories, chipKeys),
      ),
    [features, activeCategories, chipKeys],
  );

  /* ---- date-range filter (ephemeral view state) ---- */
  const [showUndated, setShowUndated] = useState(true);
  const [dateRange, setDateRange] = useState<DateRange | null>(null);
  // Era chips come from the scale over the category-filtered set (BEFORE
  // the date filter — else the options vanish once one is picked).
  const eraScale = useMemo(
    () => computeTimelineScale(categoryFiltered),
    [categoryFiltered],
  );
  const undatedCount = useMemo(
    () => categoryFiltered.filter((f) => featureEventRange(f) === null).length,
    [categoryFiltered],
  );
  const dateFiltered = useMemo(() => {
    if (!isDateRangeActive(dateRange)) return categoryFiltered;
    return categoryFiltered.filter((feature) => {
      const verdict = featureDateRangeVerdict(feature, dateRange as DateRange);
      if (verdict === 'in') return true;
      // Undated features can't fail a date test; the shared toggle
      // decides rather than silently dropping them.
      return verdict === 'undated' && showUndated;
    });
  }, [categoryFiltered, dateRange, showUndated]);

  /* ---- time lapse (over the date-filtered set: scrub WITHIN a range) ---- */
  // Playback pacing is a viewer preference, so unlike the filters above it
  // persists rather than living in workspace state.
  const pacing = useSettingsStore((s) => s.mapTimelapse);
  const setPacing = useSettingsStore((s) => s.setMapTimelapse);
  // Memoized: the playback hook stops on scale identity changes.
  const timelineScale = useMemo(
    () => computeTimelineScale(dateFiltered),
    [dateFiltered],
  );
  // Playback visits only the instants where the map actually changes; the
  // scale above stays the slider's geometry.
  const keyframes = useMemo(
    () => computeTimelineKeyframes(dateFiltered),
    [dateFiltered],
  );
  const { timeMs, setTimeMs, playing, togglePlay, cue } = useTimelinePlayback(
    timelineScale,
    keyframes,
    pacing,
  );
  const spotlightIds = useTimelineSpotlight(cue);
  const timelineActive = timelineScale !== null && timeMs !== null;

  const { visibleFeatures, faintIds, activeCount, precisionById } =
    useMemo(() => {
      if (!timelineActive) {
        return {
          visibleFeatures: dateFiltered,
          faintIds: undefined as Set<string> | undefined,
          activeCount: dateFiltered.length,
          // Halos are a time-lapse affordance: outside a sweep there is no
          // "current date" for a vague one to be vague ABOUT.
          precisionById: undefined as Map<string, EventPrecision> | undefined,
        };
      }
      const visible: MapFeature[] = [];
      const faint = new Set<string>();
      const precisions = new Map<string, EventPrecision>();
      let active = 0;
      for (const feature of dateFiltered) {
        const verdict = featureVerdictAt(feature, timeMs as number);
        if (verdict === 'active') {
          visible.push(feature);
          active += 1;
          const range = featureEventRange(feature);
          if (range) precisions.set(feature.id, range.precision);
        } else if (verdict === 'undated' && showUndated) {
          visible.push(feature);
          faint.add(feature.id);
        }
      }
      return {
        visibleFeatures: visible,
        faintIds: faint,
        activeCount: active,
        precisionById: precisions,
      };
    }, [dateFiltered, timelineActive, timeMs, showUndated]);

  // List order: what the material is about first, passing mentions last.
  const listFeatures = useMemo(
    () =>
      [...visibleFeatures].sort((a, b) => {
        const rank = { primary: 0, secondary: 1, mention: 2 } as const;
        return (
          rank[a.prominence ?? 'primary'] - rank[b.prominence ?? 'primary']
        );
      }),
    [visibleFeatures],
  );

  // Container areas whose contents are individually mapped render as
  // outline only (e.g. "DRC" when "Goma" is also on the map) — computed
  // over what's currently shown so demotion follows the filters.
  const demotedIds = useMemo(
    () => findDemotedAreaIds(visibleFeatures),
    [visibleFeatures],
  );

  const isFiltering =
    activeCategories.size > 0 || isDateRangeActive(dateRange) || timelineActive;

  // Stable label callbacks so MapView's memoized marker layers don't
  // re-render on every workspace render.
  const confidenceLabel = useCallback(
    (confidence: string) => t(`map.confidence.${confidence}`),
    [t],
  );
  const prominenceLabel = useCallback(
    (prominence: string) => t(`map.prominence.${prominence}`),
    [t],
  );
  const granularityLabel = useCallback(
    (granularity: string) => t(`map.granularity.${granularity}`),
    [t],
  );
  const dateLabel = useCallback(
    (feature: MapFeature) => formatFeatureDates(feature, locale, tMap),
    [locale, tMap],
  );
  const sourceIndex = useMemo(
    () => buildSourceIndex(state?.sources),
    [state?.sources],
  );
  const sourceLabel = useCallback(
    (feature: MapFeature) => {
      const source = featureSource(feature, sourceIndex);
      if (!source) return null;
      return {
        name: t('map.sourceLabel', { name: source.name }),
        href: sourceHref(source),
      };
    },
    [sourceIndex, t],
  );

  // View persistence is debounced and skips no-op writes. Leaflet fires
  // moveend in bursts (wheel zoom = one gesture per notch), and every
  // store write re-renders the whole map tree and serializes the
  // conversation to localStorage — unthrottled writes during zoom/pan can
  // cascade into "maximum update depth exceeded".
  const persistViewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  useEffect(
    () => () => {
      if (persistViewTimerRef.current !== null) {
        clearTimeout(persistViewTimerRef.current);
      }
    },
    [],
  );
  const persistView = useCallback(
    (view: { lat: number; lon: number; zoom: number }) => {
      if (persistViewTimerRef.current !== null) {
        clearTimeout(persistViewTimerRef.current);
      }
      persistViewTimerRef.current = setTimeout(() => {
        persistViewTimerRef.current = null;
        updateWorkflowState(conversationId, (prev) => {
          const p = prev as MapWorkflowState;
          const current = p.view;
          if (
            current &&
            Math.abs(current.lat - view.lat) < 1e-6 &&
            Math.abs(current.lon - view.lon) < 1e-6 &&
            current.zoom === view.zoom
          ) {
            // Unchanged — same reference tells the store to skip the write.
            return p;
          }
          return { ...p, view, updatedAt: new Date().toISOString() };
        });
      }, 300);
    },
    [conversationId, updateWorkflowState],
  );

  const runExtraction = async (
    input: { sourceText: string } | { searchQuery: string },
    sourceName: string,
    kind: 'text' | 'file' | 'search' | 'url',
    extra?: { url?: string; notice?: string },
  ) => {
    setError(null);
    setPhase('extracting');
    // Notices accumulate rather than overwrite: a caller's warning (a thin
    // page read) must survive alongside anything the extraction itself
    // reports, and low-confidence hits must not silently replace unresolved
    // connections.
    const notices: string[] = extra?.notice ? [extra.notice] : [];
    setNotice(notices.length > 0 ? notices.join(' ') : null);
    try {
      const response = await fetch('/api/workflows/map', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...input,
          existingNames: features.map((f) => f.name),
          modelId: conversation?.model?.id,
        }),
      });
      const parsed = await response.json();
      if (!response.ok || !parsed?.success) {
        throw new Error(parsed?.error || `Request failed (${response.status})`);
      }

      const sourceId = uuidv4();
      const incoming = (parsed.data.features as Omit<MapFeature, 'id'>[]).map(
        (f) => ({ ...f, id: uuidv4(), sourceId }),
      );
      const citations = (parsed.data.sources ?? []) as Array<{
        number: number;
        title: string;
        url: string;
      }>;
      if (incoming.length === 0) {
        notices.push(t('map.noneFound'));
        setNotice(notices.join(' '));
        return;
      }
      if (features.length + incoming.length > MAX_FEATURES) {
        throw new Error(
          t('map.featureCapExceeded', { max: String(MAX_FEATURES) }),
        );
      }

      // Resolve name-referenced connections: this run's features take
      // priority, then anything already on the map.
      const namedConnections = (parsed.data.connections ??
        []) as NamedConnection[];
      const { connections: newConnections, unresolved } = resolveConnections(
        namedConnections,
        [...incoming, ...features],
        uuidv4,
        sourceId,
      );

      updateWorkflowState(conversationId, (prev) => {
        const p = prev as MapWorkflowState;
        return {
          ...p,
          features: [...p.features, ...incoming],
          connections: [...(p.connections ?? []), ...newConnections],
          sources: [
            ...p.sources,
            {
              id: sourceId,
              name: sourceName,
              addedAt: new Date().toISOString(),
              featureCount: incoming.length,
              kind,
              ...(kind === 'search' && 'searchQuery' in input
                ? { query: input.searchQuery }
                : {}),
              ...(extra?.url ? { url: extra.url } : {}),
            },
          ],
          updatedAt: new Date().toISOString(),
        };
      });
      // Name from the first material put on the map; later additions leave
      // the established name alone.
      if (features.length === 0) {
        nameWorkflowConversation(conversationId, {
          label: kind === 'file' || kind === 'url' ? sourceName : undefined,
          sample: 'sourceText' in input ? input.sourceText : input.searchQuery,
          workflow: 'Map',
        });
      }
      if (unresolved > 0) {
        notices.push(
          t('map.connections.unresolved', { count: String(unresolved) }),
        );
      }

      // Rail message; for searches, append the citation links so sources
      // stay auditable from the conversation.
      const citationLines =
        citations.length > 0
          ? `\n\n${citations
              .map((c) => `${c.number}. [${c.title || c.url}](${c.url})`)
              .join('\n')}`
          : '';
      // Fetched pages carry their link into the rail too, so the source of
      // every mapped place stays auditable from the conversation.
      const sourceLink =
        kind === 'url' && extra?.url ? `\n\n[${sourceName}](${extra.url})` : '';
      appendWorkflowRailMessages(
        conversationId,
        kind === 'search'
          ? t('map.railSearchRequest', { query: sourceName })
          : kind === 'url'
            ? t('map.railUrlRequest', {
                title: sourceName,
                url: extra?.url ?? '',
              })
            : t('map.railRequest', { source: sourceName }),
        `${t('map.railDone', { count: String(incoming.length) })}${citationLines}${sourceLink}`,
      );
      setSourceText('');
      const lowConfidence = incoming.filter(
        (f) => f.confidence === 'low',
      ).length;
      if (lowConfidence > 0) {
        notices.push(
          t('map.lowConfidenceNotice', { count: String(lowConfidence) }),
        );
      }
      if (notices.length > 0) setNotice(notices.join(' '));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPhase('idle');
    }
  };

  const handleUploadFile = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setPhase('extracting');
    setError(null);
    try {
      const extracted = await uploadAndExtractText(file);
      if (!extracted.text.trim()) {
        throw new Error(t('document.referenceEmpty', { name: file.name }));
      }
      await runExtraction({ sourceText: extracted.text }, file.name, 'file');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('idle');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  /**
   * Fetches a pasted link server-side, then maps the extracted prose.
   *
   * On failure the URL is deliberately left in the textarea: the message tells
   * the user to open the page and paste its text, which is easier if the link
   * is still there to click.
   */
  const handleFetchUrl = async (rawUrl: string) => {
    setError(null);
    setNotice(null);
    setPhase('fetching');
    try {
      const result = await fetchUrlContent(rawUrl, {
        modelId: conversation?.model?.id,
      });
      if (!result.ok) {
        setError(`${tUrl(urlErrorKey(result.code))} ${tUrl('fallbackHint')}`);
        return;
      }

      const { text, title, resolvedUrl } = result.page;
      const sourceName = (
        title?.trim() ||
        hostnameOf(resolvedUrl) ||
        tUrl('sourceFallback')
      ).slice(0, 120);
      await runExtraction({ sourceText: text }, sourceName, 'url', {
        url: resolvedUrl,
        // A paywalled page still returns 200 with a teaser, so flag thin
        // reads rather than silently mapping three paragraphs.
        notice: text.length < 800 ? tUrl('shortExtract') : undefined,
      });
    } finally {
      setPhase('idle');
    }
  };

  const handleRemove = (id: string) => {
    updateWorkflowState(conversationId, (prev) => {
      const p = prev as MapWorkflowState;
      return {
        ...p,
        features: p.features.filter((f) => f.id !== id),
        // Connections follow their endpoints out.
        connections: connectionsWithoutFeature(p.connections ?? [], id),
        updatedAt: new Date().toISOString(),
      };
    });
  };

  const handleExport = (format: 'geojson' | 'kml' | 'csv') => {
    if (!hasFeatures) return;
    switch (format) {
      case 'geojson':
        downloadFile(
          JSON.stringify(
            featuresToGeoJson(
              features,
              state?.connections ?? [],
              state?.sources ?? [],
            ),
            null,
            2,
          ),
          'locations.geojson',
          'application/geo+json',
        );
        break;
      case 'kml':
        downloadFile(
          featuresToKml(
            features,
            conversation?.name || 'Locations',
            state?.connections ?? [],
            state?.sources ?? [],
          ),
          'locations.kml',
          'application/vnd.google-earth.kml+xml',
        );
        break;
      case 'csv':
        downloadFile(
          Papa.unparse(
            features.map((f) => {
              const range = featureEventRange(f);
              const source = featureSource(f, sourceIndex);
              return {
                name: f.name,
                lat: f.lat,
                lon: f.lon,
                category: f.category,
                granularity: f.granularity ?? 'city',
                country_code: f.countryCode ?? '',
                parent: f.parentName ?? '',
                approx_radius_km: f.approxRadiusKm ?? 0,
                event_start: range?.start ?? '',
                event_end: range?.end ?? '',
                event_precision: range?.precision ?? '',
                event_ongoing: range?.ongoing ?? false,
                prominence: f.prominence ?? 'primary',
                confidence: f.confidence,
                confidence_reason: f.confidenceReason,
                description: f.description,
                source: source?.name ?? '',
                source_url: source?.url ?? '',
              };
            }),
          ),
          'locations.csv',
          'text/csv',
        );
        break;
    }
  };

  if (!state) return null;

  const trimmedSource = sourceText.trim();
  // Pasting a link is the whole affordance — no extra toggle to discover.
  const urlCandidate = !searchMode && isLikelyUrl(trimmedSource);

  const handleSubmit = () => {
    if (!trimmedSource || busy) return;
    if (urlCandidate) {
      void handleFetchUrl(trimmedSource);
      return;
    }
    void runExtraction(
      searchMode
        ? { searchQuery: trimmedSource }
        : { sourceText: trimmedSource },
      searchMode ? trimmedSource : t('map.pastedSource'),
      searchMode ? 'search' : 'text',
    );
  };

  const inputPanel = (
    <div className="border-t border-gray-200 p-3 dark:border-gray-700">
      {error && (
        <p className="mb-2 text-sm text-red-700 dark:text-red-400" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="mb-2 text-sm text-amber-700 dark:text-amber-400">
          {notice}
        </p>
      )}
      <div className="flex items-end gap-2">
        <textarea
          ref={sourceRef}
          value={sourceText}
          onChange={(e) => setSourceText(e.target.value)}
          rows={searchMode ? 1 : 2}
          disabled={busy}
          placeholder={
            searchMode ? t('map.searchPlaceholder') : t('map.inputPlaceholder')
          }
          onKeyDown={(e) => {
            // A link is a single line, so Enter submits it the way it does
            // in search mode; pasted prose keeps Enter as a newline.
            if (
              (searchMode || urlCandidate) &&
              e.key === 'Enter' &&
              !e.shiftKey
            ) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          className="min-h-[44px] flex-1 resize-none rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-900 placeholder-gray-500 focus:border-blue-600 focus:outline-none disabled:opacity-50 dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100 dark:placeholder-gray-400"
        />
        <button
          type="button"
          onClick={() => setSearchMode((mode) => !mode)}
          disabled={busy}
          aria-pressed={searchMode}
          aria-label={t('map.searchToggle')}
          title={t('map.searchToggleHint')}
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg disabled:opacity-30 ${
            searchMode
              ? 'bg-blue-600 text-white hover:bg-blue-700'
              : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated'
          }`}
        >
          <IconWorld size={16} aria-hidden />
        </button>
        {!searchMode && (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
            aria-label={t('map.uploadFile')}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
          >
            <IconPaperclip size={16} aria-hidden />
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.doc,.docx,.txt,.md,.csv,.json,.xlsx"
          hidden
          onChange={(e) => void handleUploadFile(e.target.files)}
        />
        <button
          type="button"
          onClick={handleSubmit}
          disabled={busy || !trimmedSource}
          className="min-h-[36px] shrink-0 rounded-lg bg-gray-300 px-3 py-2 text-sm font-medium text-gray-900 hover:bg-gray-400 disabled:pointer-events-none disabled:opacity-30 dark:bg-surface-dark-base dark:text-white dark:hover:bg-surface-dark-elevated"
        >
          {busy
            ? phase === 'fetching'
              ? t('map.fetchingPage')
              : searchMode
                ? t('map.searching')
                : t('map.finding')
            : searchMode
              ? t('map.searchAndMap')
              : urlCandidate
                ? t('map.fetchAndMap')
                : t('map.mapIt')}
        </button>
      </div>
      <p className="mt-2 max-w-[75ch] text-xs text-gray-500 dark:text-gray-400">
        {t('map.disclaimer')}
      </p>
    </div>
  );

  if (!hasFeatures) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex flex-1 items-center justify-center overflow-y-auto p-6">
          <div className="w-full max-w-lg">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t('map.emptyTitle')}
            </h2>
            <p className="mt-1 max-w-[65ch] text-sm text-gray-600 dark:text-gray-400">
              {t('map.emptyBody')}
            </p>
          </div>
        </div>
        {inputPanel}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-700">
        <span className="text-sm text-gray-600 dark:text-gray-400">
          {isFiltering
            ? t('map.filters.showing', {
                shown: String(visibleFeatures.length),
                total: String(features.length),
              })
            : t('map.featureCount', { count: String(features.length) })}
        </span>
        {timelineScale && (
          <button
            type="button"
            onClick={() =>
              setTimeMs(timeMs === null ? timelineScale.minMs : null)
            }
            aria-pressed={timelineActive}
            className={`inline-flex min-h-[36px] items-center gap-1 rounded-lg px-2 py-1.5 text-sm ${
              timelineActive
                ? 'bg-blue-600 text-white hover:bg-blue-700'
                : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated'
            }`}
          >
            <IconHistory size={15} aria-hidden />
            {t('map.timeline.toggle')}
          </button>
        )}
        {tileError && (
          <span className="text-xs text-amber-700 dark:text-amber-400">
            {t('map.tilesOffline')}
          </span>
        )}
        <button
          type="button"
          onClick={() => setLegendOpen((open) => !open)}
          aria-pressed={legendOpen}
          className="inline-flex min-h-[36px] items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
        >
          <IconInfoCircle size={15} aria-hidden />
          {t('map.legend.toggle')}
        </button>
        <div className="ms-auto flex items-center gap-1">
          {(['geojson', 'kml', 'csv'] as const).map((format) => (
            <button
              key={format}
              type="button"
              onClick={() => handleExport(format)}
              className="inline-flex min-h-[36px] items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
            >
              <IconDownload size={14} aria-hidden />
              {format.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Map + list */}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="relative min-h-[240px] flex-1">
          <MapView
            features={visibleFeatures}
            connections={state.connections ?? []}
            demotedIds={demotedIds}
            faintIds={faintIds}
            spotlightIds={spotlightIds}
            precisionById={precisionById}
            view={state.view}
            focus={focus}
            onViewChange={persistView}
            onTileError={() => setTileError(true)}
            confidenceLabel={confidenceLabel}
            prominenceLabel={prominenceLabel}
            granularityLabel={granularityLabel}
            dateLabel={dateLabel}
            sourceLabel={sourceLabel}
          />
          {cue && <TimelineJumpBanner cue={cue} />}
          {legendOpen && (
            <div className="absolute bottom-6 start-2 z-[1000] w-60 rounded-lg border border-gray-200 bg-white/95 p-3 text-xs text-gray-700 shadow-lg dark:border-gray-700 dark:bg-surface-dark/95 dark:text-gray-300">
              <p className="font-semibold text-gray-900 dark:text-gray-100">
                {t('map.legend.title')}
              </p>
              <p className="mt-1.5">
                <span className="me-1 inline-block h-2.5 w-2.5 rounded-full bg-blue-500 align-middle" />
                <span className="me-1 inline-block h-2.5 w-2.5 rounded-full bg-amber-500 align-middle" />
                <span className="me-1.5 inline-block h-2.5 w-2.5 rounded-full bg-red-400 align-middle" />
                {t('map.legend.color')}
              </p>
              <p className="mt-1.5">
                <span className="me-1 inline-block h-3 w-3 rounded-full bg-gray-500 align-middle" />
                <span className="me-1.5 inline-block h-2 w-2 rounded-full bg-gray-400 align-middle" />
                {t('map.legend.size')}
              </p>
              <p className="mt-1.5">
                <span className="me-1.5 inline-block h-3.5 w-3.5 rounded-full border-2 border-dashed border-gray-500 align-middle" />
                {t('map.legend.area')}
              </p>
              <p className="mt-1.5">
                <span className="me-1.5 inline-block h-3.5 w-3.5 rounded-full border border-dashed border-gray-400 align-middle" />
                {t('map.legend.container')}
              </p>
              {timelineActive && (
                <p className="mt-1.5">
                  <span className="relative me-1.5 inline-flex h-3.5 w-3.5 items-center justify-center align-middle">
                    <span className="absolute inset-0 rounded-full border border-dashed border-blue-400 opacity-60" />
                    <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
                  </span>
                  {t('map.legend.precisionHalo')}
                </p>
              )}
            </div>
          )}
        </div>
        <div className="flex max-h-56 shrink-0 flex-col border-t border-gray-200 dark:border-gray-700 md:max-h-none md:w-80 md:border-s md:border-t-0">
          <CategoryFilterBar
            chips={chips}
            active={activeCategories}
            onToggle={(key) =>
              setActiveCategories((prev) => {
                const next = new Set(prev);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              })
            }
            onClear={() => setActiveCategories(new Set())}
          />
          {listFeatures.length === 0 ? (
            <p className="px-3 py-4 text-sm text-gray-500 dark:text-gray-400">
              {t('map.filters.noneMatch')}
            </p>
          ) : (
            <div className="min-h-0 flex-1">
              <FeatureList
                features={listFeatures}
                sourceLabel={sourceLabel}
                demotedIds={demotedIds}
                faintIds={faintIds}
                onFocus={focusFeature}
                onRemove={handleRemove}
              />
            </div>
          )}
        </div>
      </div>

      {eraScale && (
        <DateRangeFilter
          eras={eraScale.segments}
          range={dateRange}
          onChange={setDateRange}
          showUndated={showUndated}
          onShowUndatedChange={setShowUndated}
          undatedCount={undatedCount}
        />
      )}

      {timelineActive && timelineScale && (
        <TimelineControl
          scale={timelineScale}
          // Snap (not clamp): a stale timeMs landing in an era gap after
          // a filter change snaps to the nearer era edge.
          timeMs={stepToMs(
            timelineScale,
            msToStep(timelineScale, timeMs as number),
          )}
          onTimeChange={setTimeMs}
          playing={playing}
          onPlayToggle={togglePlay}
          showUndated={showUndated}
          onShowUndatedChange={setShowUndated}
          activeCount={activeCount}
          pacing={pacing}
          onPacingChange={setPacing}
        />
      )}

      {inputPanel}
    </div>
  );
}
