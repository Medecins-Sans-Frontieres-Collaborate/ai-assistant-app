'use client';

import {
  IconAlertTriangle,
  IconChevronDown,
  IconChevronRight,
} from '@tabler/icons-react';
import { FC, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { unwrapApiData } from '@/client/hooks/settings/useAgentAccessAdmin';

import type {
  M365ManifestFolder,
  M365ManifestItem,
  M365ManifestSource,
} from '@/lib/services/agentAccess/types';

import type { ClientSourcePlan } from './types';

/** Selection fields an admin can change on a source from the plan view. */
export interface SourceSelection {
  recursive: boolean;
  excludedItemIds: string[];
  includeExtensions?: string[];
}

interface M365SourcePlanViewProps {
  kind: 'file' | 'folder';
  selection: SourceSelection;
  plan: ClientSourcePlan | undefined;
  loading: boolean;
  /** The last index run's per-item outcomes for this source, if any. */
  manifestSource?: M365ManifestSource | null;
  /** Saved agent id — enables the per-file Prepare action (phase 4). */
  agentId?: string;
  /** A file was prepared: the caller re-plans so it shows as indexable. */
  onPrepared?: () => void;
  /** Explicit Prepare (OCR) page cap per PDF (served by the agents listing). */
  ocrMaxPages?: number;
  /** Auto-OCR per-file page cap, for the "too many pages" note. */
  autoOcrMaxPagesPerFile?: number;
  /**
   * Open the details (subfolder tree + file lists) without a click — the
   * editor sets this on the largest source when the plan is over the cap,
   * so the trim controls are in front of the admin, not behind "Details".
   */
  autoExpand?: boolean;
  /**
   * How many of THIS source's documents still fit under the effective cap
   * given the other sources. When it is below the source's included count
   * the "Keep newest N" action is offered; undefined hides it.
   */
  keepNewestLimit?: number;
  onChange: (patch: Partial<SourceSelection>) => void;
}

export type PlanSortKey = 'name' | 'size' | 'modified';

/**
 * Newest-first selection for "Keep newest N": the included indexable
 * items sorted by modified date (undated last, then by name), split into
 * the N to keep and the ids to exclude. Pure — the confirm copy and the
 * tests read the same numbers the click applies.
 */
export function planKeepNewest(
  items: readonly M365ManifestItem[],
  keep: number,
): { keepIds: string[]; excludeIds: string[] } {
  const included = items
    .filter((item) => item.tier === 'indexable')
    .slice()
    .sort((a, b) => {
      const da = a.lastModified ?? '';
      const db = b.lastModified ?? '';
      if (da !== db)
        return da === '' ? 1 : db === '' ? -1 : db.localeCompare(da);
      return a.name.localeCompare(b.name);
    });
  const safeKeep = Math.max(0, keep);
  return {
    keepIds: included.slice(0, safeKeep).map((i) => i.itemId),
    excludeIds: included.slice(safeKeep).map((i) => i.itemId),
  };
}

export function sortPlanItems(
  items: readonly M365ManifestItem[],
  sortBy: PlanSortKey,
): M365ManifestItem[] {
  const byName = (a: M365ManifestItem, b: M365ManifestItem) =>
    `${a.path}/${a.name}`.localeCompare(`${b.path}/${b.name}`);
  const sorted = items.slice();
  if (sortBy === 'size') {
    sorted.sort((a, b) => b.size - a.size || byName(a, b));
  } else if (sortBy === 'modified') {
    sorted.sort((a, b) => {
      const da = a.lastModified ?? '';
      const db = b.lastModified ?? '';
      if (da !== db)
        return da === '' ? 1 : db === '' ? -1 : db.localeCompare(da);
      return byName(a, b);
    });
  } else {
    sorted.sort(byName);
  }
  return sorted;
}

/** Default caps when the listing has not served them (matches env defaults). */
export const DEFAULT_OCR_MAX_PAGES = 200;
export const DEFAULT_AUTO_OCR_MAX_PAGES_PER_FILE = 50;

function isPdfName(name: string): boolean {
  return name.toLowerCase().endsWith('.pdf');
}

/**
 * Scanned PDFs from the last run that still await OCR: `noText` outcome,
 * not yet prepared. These are what "Prepare all" walks through.
 */
export function selectUnpreparedScannedPdfs(
  items: readonly M365ManifestItem[],
): M365ManifestItem[] {
  return items.filter(
    (item) =>
      item.status === 'noText' && isPdfName(item.name) && !item.prepared,
  );
}

/** Reads the outcome envelope of POST …/m365-agents/prepare. */
export async function readPrepareOutcome(
  response: Response,
  genericError: string,
): Promise<PrepareOutcome> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error || genericError);
  }
  const outcome = unwrapApiData<{ outcome: PrepareOutcome }>(body)?.outcome;
  if (!outcome) throw new Error(genericError);
  return outcome;
}

export interface PrepareAllResult {
  prepared: number;
  total: number;
  failures: Array<{ name: string; error: string }>;
  cancelled: boolean;
}

/**
 * "Prepare all scanned PDFs": the explicit, click-to-pay batch counterpart
 * of the per-file Prepare button. Files are OCR'd ONE AT A TIME through
 * the same route (no server fan-out, nothing runs without this tab), with
 * a confirm that states the file count and the per-file page cap, live
 * progress, and a cancel that stops after the file in flight. Failures
 * are collected and listed rather than aborting the batch.
 */
export const M365PrepareAllButton: FC<{
  agentId: string;
  items: readonly M365ManifestItem[];
  ocrMaxPages: number;
  disabled?: boolean;
  onDone: (result: PrepareAllResult) => void;
}> = ({ agentId, items, ocrMaxPages, disabled, onDone }) => {
  const t = useTranslations('agentAccess');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{
    current: number;
    total: number;
    name: string;
  } | null>(null);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [failures, setFailures] = useState<
    Array<{ name: string; error: string }>
  >([]);
  const cancelRef = useRef(false);
  const unmountedRef = useRef(false);
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      cancelRef.current = true;
    };
  }, []);

  const run = async () => {
    if (running || items.length === 0) return;
    const confirmed = window.confirm(
      t('m365PrepareAllConfirm', { count: items.length, pages: ocrMaxPages }),
    );
    if (!confirmed) return;
    cancelRef.current = false;
    setCancelRequested(false);
    setFailures([]);
    setRunning(true);
    const collected: Array<{ name: string; error: string }> = [];
    let prepared = 0;
    let index = 0;
    try {
      for (const item of items) {
        if (cancelRef.current) break;
        index += 1;
        if (!unmountedRef.current) {
          setProgress({ current: index, total: items.length, name: item.name });
        }
        try {
          const outcome = await readPrepareOutcome(
            await fetch('/api/agent-access/m365-agents/prepare', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                id: agentId,
                driveId: item.driveId,
                itemId: item.itemId,
              }),
            }),
            t('m365PrepareFailedGeneric'),
          );
          if (outcome.status === 'prepared') prepared += 1;
          else if (outcome.status === 'failed') {
            collected.push({ name: item.name, error: outcome.error });
          } else {
            // PDFs answer synchronously; anything else is not a scanned
            // PDF and does not belong in this batch.
            collected.push({
              name: item.name,
              error: t('m365PrepareFailedGeneric'),
            });
          }
        } catch (error) {
          collected.push({
            name: item.name,
            error: error instanceof Error ? error.message : '',
          });
        }
      }
    } finally {
      if (!unmountedRef.current) {
        setRunning(false);
        setProgress(null);
        setFailures(collected);
      }
      onDone({
        prepared,
        total: items.length,
        failures: collected,
        cancelled: cancelRef.current && index < items.length,
      });
    }
  };

  if (items.length === 0 && failures.length === 0) return null;
  return (
    <div className="text-xs">
      {running ? (
        <div className="flex flex-wrap items-center gap-2">
          <span role="status" className="text-blue-700 dark:text-blue-400">
            {cancelRequested
              ? t('m365PrepareAllCancelling')
              : progress
                ? t('m365PrepareAllProgress', progress)
                : null}
          </span>
          {!cancelRequested && (
            <button
              type="button"
              onClick={() => {
                cancelRef.current = true;
                setCancelRequested(true);
              }}
              className="rounded-md border border-neutral-300 px-2 py-0.5 text-gray-700 hover:bg-gray-100 dark:border-neutral-600 dark:text-gray-300 dark:hover:bg-neutral-700"
            >
              {t('m365PrepareAllCancel')}
            </button>
          )}
        </div>
      ) : (
        items.length > 0 && (
          <button
            type="button"
            onClick={() => void run()}
            disabled={disabled}
            title={t('m365PrepareHintOcr', { pages: ocrMaxPages })}
            className="rounded-md border border-blue-300 px-2 py-0.5 font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-700 dark:text-blue-300 dark:hover:bg-blue-900/20"
          >
            {t('m365PrepareAllButton', { count: items.length })}
          </button>
        )
      )}
      {failures.length > 0 && (
        <div className="mt-1 text-red-700 dark:text-red-400">
          <p>{t('m365PrepareAllFailures', { count: failures.length })}</p>
          <ul className="space-y-0.5">
            {failures.map((failure) => (
              <li
                key={failure.name}
                className="line-clamp-2 break-words"
                title={`${failure.name}: ${failure.error}`}
              >
                <span className="font-medium">{failure.name}</span>:{' '}
                {failure.error}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

/**
 * Per-item OCR note from the last run: pages billed by auto-OCR, or why
 * auto-OCR left the file alone (budget / size / no engine).
 */
export function ocrNoteFor(
  status: M365ManifestItem | undefined,
  t: (key: string, values?: Record<string, string | number>) => string,
  autoOcrMaxPagesPerFile: number,
): string | null {
  if (!status) return null;
  if (status.ocrSkipped) {
    return t(`m365ItemOcrSkipped.${status.ocrSkipped}`, {
      perFile: autoOcrMaxPagesPerFile,
    });
  }
  if (status.ocrPages && status.ocrPages > 0) {
    return t('m365ItemOcrPages', { count: status.ocrPages });
  }
  return null;
}

type PrepareOutcome =
  | { status: 'prepared'; name: string; chars: number }
  | { status: 'pending'; name: string; jobId: string; itemId: string }
  | { status: 'running'; jobId: string }
  | { status: 'failed'; error: string };

/** Chunked transcription status poll interval. */
const PREPARE_POLL_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** ~1 MB per minute at typical speech bitrates — a hint, not a meter. */
function estimateMediaMinutes(bytes: number): number {
  return Math.max(1, Math.round(bytes / (1024 * 1024)));
}

/** Rows shown per file group before collapsing into "and N more". */
const MAX_ROWS_PER_GROUP = 60;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function parseExtensions(raw: string): string[] | undefined {
  const list = raw
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase().replace(/^\./, ''))
    .filter((e) => /^[a-z0-9]{1,10}$/.test(e));
  return list.length > 0 ? [...new Set(list)] : undefined;
}

/**
 * Per-source plan view (design §2–§3): tier chips, the recursive toggle
 * and extension filter, a subfolder list with include checkboxes, and the
 * classified file lists with skip reasons and last-run outcomes.
 */
export const M365SourcePlanView: FC<M365SourcePlanViewProps> = ({
  kind,
  selection,
  plan,
  loading,
  manifestSource,
  agentId,
  onPrepared,
  ocrMaxPages = DEFAULT_OCR_MAX_PAGES,
  autoOcrMaxPagesPerFile = DEFAULT_AUTO_OCR_MAX_PAGES_PER_FILE,
  autoExpand = false,
  keepNewestLimit,
  onChange,
}) => {
  const t = useTranslations('agentAccess');
  const [expanded, setExpanded] = useState(false);
  const [sortBy, setSortBy] = useState<PlanSortKey>('name');
  useEffect(() => {
    if (autoExpand) setExpanded(true);
  }, [autoExpand]);
  const [preparing, setPreparing] = useState<Set<string>>(new Set());
  const [pendingJobs, setPendingJobs] = useState<Set<string>>(new Set());
  const unmountedRef = useRef(false);
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  const setBusy = (itemId: string, on: boolean) =>
    setPreparing((prev) => {
      const next = new Set(prev);
      if (on) next.add(itemId);
      else next.delete(itemId);
      return next;
    });

  const readOutcome = (response: Response): Promise<PrepareOutcome> =>
    readPrepareOutcome(response, t('m365PrepareFailedGeneric'));

  /** Polls the chunked transcription job, then stores the transcript. */
  const completePending = async (item: M365ManifestItem, jobId: string) => {
    setPendingJobs((prev) => new Set(prev).add(item.itemId));
    try {
      for (;;) {
        if (unmountedRef.current) return;
        await sleep(PREPARE_POLL_MS);
        const status = await fetch(
          `/api/transcription/status/${encodeURIComponent(jobId)}`,
        );
        const statusBody = await status.json().catch(() => null);
        const state: string | undefined =
          unwrapApiData<{ status?: string }>(statusBody)?.status ??
          statusBody?.status;
        if (state !== 'Succeeded' && state !== 'Failed') continue;
        const outcome = await readOutcome(
          await fetch('/api/agent-access/m365-agents/prepare/complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: agentId, itemId: item.itemId }),
          }),
        );
        if (outcome.status === 'running') continue;
        if (outcome.status === 'failed') {
          toast.error(
            t('m365PrepareFailed', { name: item.name, error: outcome.error }),
          );
        } else if (outcome.status === 'prepared') {
          toast.success(
            t('m365PrepareDone', { name: item.name, chars: outcome.chars }),
          );
          onPrepared?.();
        }
        return;
      }
    } catch (error) {
      toast.error(
        t('m365PrepareFailed', {
          name: item.name,
          error: error instanceof Error ? error.message : '',
        }),
      );
    } finally {
      setPendingJobs((prev) => {
        const next = new Set(prev);
        next.delete(item.itemId);
        return next;
      });
    }
  };

  const prepare = async (item: M365ManifestItem) => {
    if (!agentId || preparing.has(item.itemId)) return;
    setBusy(item.itemId, true);
    try {
      const outcome = await readOutcome(
        await fetch('/api/agent-access/m365-agents/prepare', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: agentId,
            driveId: item.driveId,
            itemId: item.itemId,
          }),
        }),
      );
      if (outcome.status === 'prepared') {
        toast.success(
          t('m365PrepareDone', { name: item.name, chars: outcome.chars }),
        );
        onPrepared?.();
      } else if (outcome.status === 'pending') {
        toast(t('m365PrepareStarted', { name: item.name }));
        void completePending(item, outcome.jobId);
      } else if (outcome.status === 'failed') {
        toast.error(
          t('m365PrepareFailed', { name: item.name, error: outcome.error }),
        );
      }
    } catch (error) {
      toast.error(
        t('m365PrepareFailed', {
          name: item.name,
          error: error instanceof Error ? error.message : '',
        }),
      );
    } finally {
      setBusy(item.itemId, false);
    }
  };

  const prepareHint = (item: M365ManifestItem): string => {
    const ext = item.name.toLowerCase().split('.').pop() ?? '';
    if (ext === 'pdf')
      return t('m365PrepareHintOcr', {
        pages: ocrMaxPages ?? DEFAULT_OCR_MAX_PAGES,
      });
    if (
      [
        'mp3',
        'm4a',
        'wav',
        'ogg',
        'oga',
        'flac',
        'aac',
        'opus',
        'wma',
        'mpeg',
        'mpga',
        'mp4',
        'mov',
        'webm',
        'mkv',
        'avi',
        'wmv',
        'm4v',
      ].includes(ext)
    ) {
      return t('m365PrepareHintMedia', {
        minutes: estimateMediaMinutes(item.size),
      });
    }
    return t('m365PrepareHintImage');
  };

  const prepareButton = (item: M365ManifestItem, ocr: boolean) => {
    if (!agentId) {
      return <span className="text-gray-400">{t('m365PrepareSaveFirst')}</span>;
    }
    const busy = preparing.has(item.itemId);
    const pending = pendingJobs.has(item.itemId);
    return (
      <button
        type="button"
        disabled={busy || pending}
        onClick={() => void prepare(item)}
        className="rounded border border-amber-300 px-1.5 py-0.5 text-amber-800 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-900/40"
        title={prepareHint(item)}
      >
        {busy
          ? t('m365PreparePreparing')
          : pending
            ? t('m365PreparePending')
            : t(ocr ? 'm365PrepareOcrButton' : 'm365PrepareButton')}
      </button>
    );
  };
  const [extensionsDraft, setExtensionsDraft] = useState(
    selection.includeExtensions?.join(', ') ?? '',
  );
  // Keep the draft in step when the selection changes from outside (e.g.
  // "take theirs" on a save conflict swaps the whole source list).
  const committedExtensions = selection.includeExtensions?.join(', ') ?? '';
  useEffect(() => {
    setExtensionsDraft(committedExtensions);
  }, [committedExtensions]);

  const statusByItem = useMemo(() => {
    const map = new Map<string, M365ManifestItem>();
    for (const item of manifestSource?.items ?? []) {
      map.set(item.itemId, item);
    }
    return map;
  }, [manifestSource]);

  const excluded = useMemo(
    () => new Set(selection.excludedItemIds),
    [selection.excludedItemIds],
  );

  // Scanned PDFs the last run could not read, still unprepared — the
  // batch "Prepare all" walks exactly these (status from the manifest,
  // preparation state from the plan so a just-prepared file drops out).
  const scannedPdfs = useMemo(() => {
    const planned = new Map((plan?.items ?? []).map((i) => [i.itemId, i]));
    return selectUnpreparedScannedPdfs(
      [...statusByItem.values()].map((status) => ({
        ...status,
        prepared: planned.get(status.itemId)?.prepared ?? status.prepared,
      })),
    );
  }, [plan, statusByItem]);

  /** Folders sorted by path, with the count of indexable files beneath each. */
  const folderRows = useMemo(() => {
    if (!plan) return [];
    const rows = [...plan.folders].sort((a, b) => a.path.localeCompare(b.path));
    return rows.map((folder) => ({
      folder,
      indexableBelow: plan.items.filter(
        (item) =>
          item.tier === 'indexable' &&
          (item.path === folder.path ||
            item.path.startsWith(`${folder.path}/`)),
      ).length,
      ancestorExcluded: isAncestorExcluded(folder, plan.folders, excluded),
    }));
  }, [plan, excluded]);

  /** Folder ids that are excluded directly or through an excluded ancestor. */
  const excludedFolderIds = useMemo(() => {
    const set = new Set<string>();
    for (const folder of plan?.folders ?? []) {
      if (
        excluded.has(folder.itemId) ||
        isAncestorExcluded(folder, plan?.folders ?? [], excluded)
      ) {
        set.add(folder.itemId);
      }
    }
    return set;
  }, [plan, excluded]);
  /** A file whose containing folder (or one above it) is unticked. */
  const folderExcluded = (item: M365ManifestItem) =>
    excludedFolderIds.has(item.parentItemId);

  const groups = useMemo(() => {
    const items = plan?.items ?? [];
    const byTier = {
      // Files unticked by id stay in the indexable list (unchecked) so
      // they can be ticked back in place instead of hunting through
      // "Skipped"; folder-excluded ones show there disabled.
      indexable: items.filter(
        (i) =>
          i.tier === 'indexable' ||
          (i.tier === 'skipped' && i.reason === 'excluded'),
      ),
      needsPreparation: items.filter((i) => i.tier === 'needsPreparation'),
      skipped: items.filter(
        (i) => i.tier === 'skipped' && i.reason !== 'excluded',
      ),
    };
    return byTier;
  }, [plan]);

  const toggleFolder = (itemId: string) => {
    const next = new Set(selection.excludedItemIds);
    if (next.has(itemId)) next.delete(itemId);
    else next.add(itemId);
    onChange({ excludedItemIds: [...next] });
  };

  const toggleFile = (item: M365ManifestItem) => {
    if (folderExcluded(item)) return;
    const next = new Set(selection.excludedItemIds);
    if (next.has(item.itemId)) next.delete(item.itemId);
    else next.add(item.itemId);
    onChange({ excludedItemIds: [...next] });
  };

  /** Ids of files (not folders) excluded by id in this source. */
  const fileExclusions = useMemo(() => {
    const fileIds = new Set((plan?.items ?? []).map((i) => i.itemId));
    return selection.excludedItemIds.filter((id) => fileIds.has(id));
  }, [plan, selection.excludedItemIds]);

  const includedIndexable = groups.indexable.filter(
    (i) => i.tier === 'indexable',
  ).length;
  const offerKeepNewest =
    keepNewestLimit !== undefined &&
    keepNewestLimit >= 0 &&
    includedIndexable > keepNewestLimit;

  const keepNewest = () => {
    if (!plan || keepNewestLimit === undefined) return;
    const { excludeIds } = planKeepNewest(plan.items, keepNewestLimit);
    if (excludeIds.length === 0) return;
    const confirmed = window.confirm(
      t('m365PlanKeepNewestConfirm', {
        keep: keepNewestLimit,
        exclude: excludeIds.length,
      }),
    );
    if (!confirmed) return;
    onChange({
      excludedItemIds: [
        ...new Set([...selection.excludedItemIds, ...excludeIds]),
      ],
    });
  };

  const includeAllFiles = () => {
    const fileIds = new Set(fileExclusions);
    onChange({
      excludedItemIds: selection.excludedItemIds.filter(
        (id) => !fileIds.has(id),
      ),
    });
  };

  const commitExtensions = () => {
    const parsed = parseExtensions(extensionsDraft);
    setExtensionsDraft(parsed?.join(', ') ?? '');
    if (
      (parsed ?? []).join(',') !== (selection.includeExtensions ?? []).join(',')
    ) {
      onChange({ includeExtensions: parsed });
    }
  };

  /**
   * Single-file sources: the one item's classification and last-run
   * outcome belong on the chip row, not behind "Details" — "0 files will
   * be indexed" in gray told the tester nothing about WHY.
   */
  const fileItem = kind === 'file' ? (plan?.items[0] ?? null) : null;
  const fileStatus = fileItem ? statusByItem.get(fileItem.itemId) : undefined;
  const fileOutcome =
    fileStatus?.status === 'failed' ||
    fileStatus?.status === 'missing' ||
    fileStatus?.status === 'noText'
      ? fileStatus
      : undefined;
  const fileVerdict = (): { label: string; tone: 'amber' | 'red' } | null => {
    if (!fileItem) return null;
    if (fileItem.tier === 'skipped') {
      const reason = fileItem.reason ?? 'unsupported';
      const ext = fileItem.name.toLowerCase().split('.').pop() ?? '';
      return {
        label:
          reason === 'unsupported'
            ? t('m365PlanFileUnsupported', { ext })
            : t('m365PlanFileSkipped', {
                reason: t(`m365SkipReason.${reason}`),
              }),
        tone: 'red',
      };
    }
    if (fileItem.tier === 'needsPreparation') {
      return {
        label: t('m365PlanFileNeedsPreparation', {
          hint: prepareHint(fileItem),
        }),
        tone: 'amber',
      };
    }
    return null;
  };

  const chip = (label: string, tone: 'green' | 'amber' | 'gray' | 'red') => {
    const tones = {
      green:
        'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
      amber:
        'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
      gray: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
      red: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
    };
    return (
      <span className={`rounded-full px-2 py-0.5 text-xs ${tones[tone]}`}>
        {label}
      </span>
    );
  };

  return (
    <div className="mt-1 space-y-1 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        {loading && !plan && (
          <span className="text-gray-500 dark:text-gray-400">
            {t('m365PlanScanning')}
          </span>
        )}
        {plan?.missing && chip(t('m365PlanMissing'), 'red')}
        {plan && !plan.missing && (
          <>
            {(() => {
              const verdict = fileVerdict();
              if (verdict) return chip(verdict.label, verdict.tone);
              return chip(
                t('m365PlanIndexable', { count: plan.counts.indexable }),
                plan.counts.indexable > 0 ? 'green' : 'gray',
              );
            })()}
            {fileOutcome &&
              chip(
                t('m365PlanFileLastRun', {
                  status:
                    fileOutcome.status === 'noText' &&
                    fileItem?.name.toLowerCase().endsWith('.pdf')
                      ? t('m365ItemNoTextOcr')
                      : fileOutcome.error
                        ? `${t(`m365ItemStatus.${fileOutcome.status}`)} — ${fileOutcome.error}`
                        : t(`m365ItemStatus.${fileOutcome.status}`),
                }),
                'red',
              )}
            {fileItem?.tier !== 'needsPreparation' &&
              plan.counts.needsPreparation > 0 &&
              chip(
                t('m365PlanNeedsPreparation', {
                  count: plan.counts.needsPreparation,
                }),
                'amber',
              )}
            {fileItem?.tier !== 'skipped' &&
              plan.counts.skipped > 0 &&
              chip(
                t('m365PlanSkipped', { count: plan.counts.skipped }),
                'gray',
              )}
            {plan.counts.bytes > 0 && (
              <span className="text-gray-500 dark:text-gray-400">
                {formatBytes(plan.counts.bytes)}
              </span>
            )}
            {loading && (
              <span className="text-gray-400">{t('m365PlanRefreshing')}</span>
            )}
            {(plan.items.length > 0 || plan.folders.length > 0) && (
              <button
                type="button"
                onClick={() => setExpanded((e) => !e)}
                aria-expanded={expanded}
                className="flex items-center gap-0.5 text-blue-700 hover:underline dark:text-blue-400"
              >
                {expanded ? (
                  <IconChevronDown size={12} />
                ) : (
                  <IconChevronRight size={12} />
                )}
                {t(expanded ? 'm365PlanHideDetails' : 'm365PlanShowDetails')}
              </button>
            )}
          </>
        )}
      </div>

      {plan?.truncated && (
        <p className="flex items-center gap-1 text-amber-700 dark:text-amber-400">
          <IconAlertTriangle size={12} /> {t('m365PlanTruncated')}
        </p>
      )}

      {kind === 'folder' && (
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1 text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              checked={selection.recursive}
              onChange={(e) => onChange({ recursive: e.target.checked })}
            />
            {t('m365PlanRecursive')}
          </label>
          <label className="flex items-center gap-1 text-gray-700 dark:text-gray-300">
            <span>{t('m365PlanExtensionsLabel')}</span>
            <input
              type="text"
              value={extensionsDraft}
              placeholder={t('m365PlanExtensionsPlaceholder')}
              onChange={(e) => setExtensionsDraft(e.target.value)}
              onBlur={commitExtensions}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitExtensions();
                }
              }}
              className="w-40 rounded border border-gray-300 bg-white px-1.5 py-0.5 text-xs dark:border-gray-600 dark:bg-surface-dark-elevated"
            />
          </label>
        </div>
      )}

      {expanded && plan && (
        <div className="space-y-2 rounded-md border border-gray-200 p-2 dark:border-gray-700">
          {autoExpand && (
            <p className="text-amber-700 dark:text-amber-400">
              {t('m365PlanTrimHint')}
            </p>
          )}
          {(plan.items.length > 0 || offerKeepNewest) && (
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1 text-gray-600 dark:text-gray-400">
                <span>{t('m365PlanSortLabel')}</span>
                <select
                  aria-label={t('m365PlanSortLabel')}
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as PlanSortKey)}
                  className="rounded border border-gray-300 bg-white px-1 py-0.5 text-xs dark:border-gray-600 dark:bg-surface-dark-elevated"
                >
                  <option value="name">{t('m365PlanSort.name')}</option>
                  <option value="size">{t('m365PlanSort.size')}</option>
                  <option value="modified">{t('m365PlanSort.modified')}</option>
                </select>
              </label>
              {offerKeepNewest && (
                <button
                  type="button"
                  onClick={keepNewest}
                  className="rounded-md border border-blue-300 px-2 py-0.5 font-medium text-blue-700 hover:bg-blue-50 dark:border-blue-700 dark:text-blue-300 dark:hover:bg-blue-900/20"
                >
                  {t('m365PlanKeepNewest', { count: keepNewestLimit })}
                </button>
              )}
              {fileExclusions.length > 0 && (
                <button
                  type="button"
                  onClick={includeAllFiles}
                  className="rounded-md border border-neutral-300 px-2 py-0.5 text-gray-700 hover:bg-gray-100 dark:border-neutral-600 dark:text-gray-300 dark:hover:bg-neutral-700"
                >
                  {t('m365PlanIncludeAll', { count: fileExclusions.length })}
                </button>
              )}
            </div>
          )}
          {folderRows.length > 0 && (
            <div>
              <p className="mb-1 font-semibold text-gray-700 dark:text-gray-300">
                {t('m365PlanSubfolders')}
              </p>
              <ul className="max-h-48 space-y-0.5 overflow-y-auto">
                {folderRows.map(
                  ({ folder, indexableBelow, ancestorExcluded }) => (
                    <li key={folder.itemId}>
                      <label
                        className={`flex items-center gap-1.5 ${
                          ancestorExcluded ? 'opacity-50' : ''
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={
                            !excluded.has(folder.itemId) && !ancestorExcluded
                          }
                          disabled={ancestorExcluded}
                          onChange={() => toggleFolder(folder.itemId)}
                        />
                        <span className="truncate text-gray-800 dark:text-gray-200">
                          {folder.path || folder.name}
                        </span>
                        <span className="shrink-0 text-gray-500 dark:text-gray-400">
                          {t('m365PlanFolderCount', { count: indexableBelow })}
                        </span>
                      </label>
                    </li>
                  ),
                )}
              </ul>
            </div>
          )}

          {agentId && scannedPdfs.length > 0 && (
            <M365PrepareAllButton
              agentId={agentId}
              items={scannedPdfs}
              ocrMaxPages={ocrMaxPages}
              onDone={(result) => {
                if (result.prepared > 0) {
                  toast.success(
                    t('m365PrepareAllDone', {
                      prepared: result.prepared,
                      total: result.total,
                    }),
                  );
                  onPrepared?.();
                }
              }}
            />
          )}
          <FileGroup
            title={t('m365PlanGroupIndexable')}
            items={groups.indexable}
            statusByItem={statusByItem}
            sortBy={sortBy}
            selectable={{
              isChecked: (item) => item.tier === 'indexable',
              isDisabled: folderExcluded,
              onToggle: toggleFile,
            }}
            renderNote={(item) => {
              if (item.tier !== 'indexable') {
                return (
                  <span className="text-gray-400">
                    {t('m365PlanFileExcluded')}
                  </span>
                );
              }
              const status = statusByItem.get(item.itemId);
              const isPdf = item.name.toLowerCase().endsWith('.pdf');
              const ocrNote = ocrNoteFor(status, t, autoOcrMaxPagesPerFile);
              return (
                <span className="flex items-center gap-1.5">
                  {ocrNote && (
                    <span
                      className={
                        status?.ocrSkipped
                          ? 'text-amber-700 dark:text-amber-400'
                          : 'text-gray-500 dark:text-gray-400'
                      }
                    >
                      {ocrNote}
                    </span>
                  )}
                  {item.prepared && (
                    <span className="text-green-700 dark:text-green-400">
                      {t('m365PreparedNote', {
                        kind: t(`m365PreparedKind.${item.prepared.kind}`),
                      })}
                    </span>
                  )}
                  {status?.status && (
                    <span
                      className={
                        status.status === 'indexed'
                          ? 'text-green-700 dark:text-green-400'
                          : 'text-red-700 dark:text-red-400'
                      }
                      title={status.error}
                    >
                      {status.status === 'noText' && isPdf
                        ? t('m365ItemNoTextOcr')
                        : t(`m365ItemStatus.${status.status}`)}
                    </span>
                  )}
                  {status?.status === 'noText' &&
                    isPdf &&
                    !item.prepared &&
                    prepareButton(item, true)}
                </span>
              );
            }}
          />
          <FileGroup
            title={t('m365PlanGroupNeedsPreparation')}
            items={groups.needsPreparation}
            statusByItem={statusByItem}
            sortBy={sortBy}
            renderNote={(item) => (
              <span className="flex items-center gap-1.5">
                <span className="text-amber-700 dark:text-amber-400">
                  {prepareHint(item)}
                </span>
                {prepareButton(item, false)}
              </span>
            )}
          />
          <FileGroup
            title={t('m365PlanGroupSkipped')}
            items={groups.skipped}
            statusByItem={statusByItem}
            sortBy={sortBy}
            renderNote={(item) => (
              <span className="text-gray-500 dark:text-gray-400">
                {t(`m365SkipReason.${item.reason ?? 'unsupported'}`)}
              </span>
            )}
          />
        </div>
      )}
    </div>
  );
};

function isAncestorExcluded(
  folder: M365ManifestFolder,
  folders: M365ManifestFolder[],
  excluded: Set<string>,
): boolean {
  const parentOf = new Map(folders.map((f) => [f.itemId, f.parentItemId]));
  let cursor = parentOf.get(folder.itemId);
  let hops = 0;
  while (cursor && hops < 32) {
    if (excluded.has(cursor)) return true;
    cursor = parentOf.get(cursor);
    hops += 1;
  }
  return false;
}

interface FileGroupProps {
  title: string;
  items: M365ManifestItem[];
  statusByItem: Map<string, M365ManifestItem>;
  sortBy?: PlanSortKey;
  /** File-level include checkboxes (indexable group). */
  selectable?: {
    isChecked: (item: M365ManifestItem) => boolean;
    isDisabled: (item: M365ManifestItem) => boolean;
    onToggle: (item: M365ManifestItem) => void;
  };
  renderNote: (item: M365ManifestItem) => React.ReactNode;
}

const FileGroup: FC<FileGroupProps> = ({
  title,
  items,
  sortBy = 'name',
  selectable,
  renderNote,
}) => {
  const t = useTranslations('agentAccess');
  if (items.length === 0) return null;
  const shown = sortPlanItems(items, sortBy).slice(0, MAX_ROWS_PER_GROUP);
  return (
    <div>
      <p className="mb-1 font-semibold text-gray-700 dark:text-gray-300">
        {title} ({items.length})
      </p>
      <ul className="max-h-48 space-y-0.5 overflow-y-auto">
        {shown.map((item) => (
          <li
            key={item.itemId}
            className={`flex items-center gap-2 text-gray-800 dark:text-gray-200 ${
              selectable && !selectable.isChecked(item) ? 'opacity-60' : ''
            }`}
          >
            {selectable && (
              <input
                type="checkbox"
                aria-label={t('m365PlanIncludeFile', { name: item.name })}
                checked={selectable.isChecked(item)}
                disabled={selectable.isDisabled(item)}
                onChange={() => selectable.onToggle(item)}
              />
            )}
            <span className="min-w-0 flex-1 truncate" title={item.name}>
              {item.path ? `${item.path}/` : ''}
              {item.name}
            </span>
            <span className="shrink-0 text-gray-400">
              {formatBytes(item.size)}
            </span>
            <span className="shrink-0">{renderNote(item)}</span>
          </li>
        ))}
        {items.length > shown.length && (
          <li className="text-gray-500 dark:text-gray-400">
            {t('m365PlanMoreRows', { count: items.length - shown.length })}
          </li>
        )}
      </ul>
    </div>
  );
};
