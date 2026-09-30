'use client';

import {
  IconAlertTriangle,
  IconHelpCircle,
  IconRefreshAlert,
  IconSparkles,
} from '@tabler/icons-react';

import { useTranslations } from 'next-intl';

import {
  Brief,
  CitationMark,
  CitationVerdict,
  DRAFTER_LIMITS,
  DraftSource,
  GroundingMark,
  Segment,
  Version,
} from '@/types/drafter';

import { ProofCard } from './ProofCard';
import {
  CALL_TO_ACTION_REF,
  KEY_MESSAGE_REF,
  isBriefRef,
  refNames,
  refTags,
} from './itemRefs';

/** One sentence sent to the cite step ("Check with AI"). */
export interface VerifyClaim {
  segmentId: string;
  text: string;
}

/** The translator shape the helpers need; next-intl's `t` fits it. */
type Translate = (
  key: string,
  values?: Record<string, string | number>,
) => string;

export const ghostButton =
  'inline-flex min-h-[32px] items-center gap-1 rounded-lg px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-300 dark:hover:bg-surface-dark-elevated';

/**
 * How a sentence is underlined for its verdict. Only an unsupported one
 * shows outside evidence mode; the others are plain text there. Never red:
 * nothing here blocks.
 */
export function citationClass(
  verdict: CitationVerdict,
  evidence: boolean,
): string {
  if (verdict === 'unsupported') {
    return 'underline decoration-wavy decoration-amber-700 underline-offset-4 bg-amber-50 dark:bg-amber-900/30';
  }
  if (!evidence) return '';
  if (verdict === 'supported') {
    return 'underline decoration-solid decoration-gray-300 underline-offset-4 dark:decoration-gray-600';
  }
  if (verdict === 'partly') {
    return 'underline decoration-dashed decoration-gray-500 underline-offset-4';
  }
  return 'underline decoration-dotted decoration-gray-400 underline-offset-4';
}

/** The short state a chip announces: "in the brief: #2 Figure". */
export function citationState(
  t: Translate,
  brief: Brief,
  mark: CitationMark,
): string {
  switch (mark.verdict) {
    case 'supported':
      return t('markSupportedBy', { items: refNames(t, brief, mark.itemIds) });
    case 'partly':
      return t('markPartlyCite', { items: refNames(t, brief, mark.itemIds) });
    case 'unsupported':
      return t('markUnsupported');
    case 'unclear':
      return t('markUnclear');
    case 'pending':
      return t('markPending');
    default:
      return t('markStale');
  }
}

/** The quotes and numbers of a segment that a sentence contains. */
export function innerMarksOf(
  marks: GroundingMark[],
  mark: Pick<CitationMark, 'segmentId' | 'start' | 'end'>,
): GroundingMark[] {
  return marks.filter(
    (inner) =>
      inner.segmentId === mark.segmentId &&
      inner.start >= mark.start &&
      inner.end <= mark.end,
  );
}

/** What a chip must add to its state: the hard findings inside the sentence. */
export function hardProblems(t: Translate, inner: GroundingMark[]): string {
  return inner
    .filter((mark) => mark.itemId === undefined)
    .map((mark) =>
      mark.kind === 'quote'
        ? t('markQuoteNotInBrief')
        : t('markNumberNotInBrief'),
    )
    .join(' · ');
}

/**
 * Why a verdict lapsed: an item it cited left the brief, or the brief
 * changed under it. Read from the stored verdict, since the mark only says
 * 'stale'.
 */
export function staleReason(
  version: Pick<Version, 'verdicts'> | undefined,
  mark: CitationMark,
  brief: Brief,
): 'item-excluded' | 'brief-changed' {
  const stored = (version?.verdicts ?? [])
    .filter(
      (verdict) =>
        verdict.segmentId === mark.segmentId &&
        verdict.sentenceKey === mark.key,
    )
    .sort((a, b) => b.at.localeCompare(a.at))[0];
  const included = new Set(
    brief.items
      .filter((item) => item.decision === 'included')
      .map((item) => item.id),
  );
  return stored?.itemIds.some((id) => !isBriefRef(id) && !included.has(id))
    ? 'item-excluded'
    : 'brief-changed';
}

/** The "Check with AI" control a sentence panel ends with. */
export interface CheckControl {
  onCheck: () => void;
  checking: boolean;
  disabled: boolean;
  error?: string;
  /** Id of an explainer already on the page; absent = the panel shows its own. */
  describedBy?: string;
}

function CheckButton({ check }: { check: CheckControl }) {
  const t = useTranslations('workflows.drafter');
  const blockedByOther = check.disabled && !check.checking;
  return (
    <button
      type="button"
      className={ghostButton}
      disabled={check.disabled}
      aria-busy={check.checking || undefined}
      aria-describedby={check.describedBy}
      title={blockedByOther ? t('checkRunning') : undefined}
      onClick={check.onCheck}
    >
      <IconSparkles size={14} aria-hidden />
      {check.checking ? t('checkingWithAi') : t('checkWithAi')}
    </button>
  );
}

interface CitationPanelProps {
  mark: CitationMark;
  /** The whole segment: the mark's ranges are offsets into it. */
  segmentText: string;
  /** The segment's quote and number marks (any segment's; filtered here). */
  marks: GroundingMark[];
  brief: Brief;
  sources: DraftSource[];
  version?: Version;
  check?: CheckControl;
  /** Repeat the sentence on top (the popover); the list already shows it. */
  showSentence?: boolean;
}

/**
 * What one sentence rests on: the verdict, why, any hard finding inside
 * it, one card per cited item, and "Check with AI". Shared by the chip's
 * popover and the evidence list, so proof reads the same in both.
 */
export function CitationPanel({
  mark,
  segmentText,
  marks,
  brief,
  sources,
  version,
  check,
  showSentence = false,
}: CitationPanelProps) {
  const t = useTranslations('workflows.drafter');
  const itemsById = new Map(brief.items.map((item) => [item.id, item]));
  const inner = innerMarksOf(marks, mark);
  const ungrounded = inner.filter((entry) => entry.itemId === undefined);
  // The model's items first, then anything a verbatim quote or a number
  // inside the sentence proves on its own: a hard fact never goes missing.
  const itemIds = [...mark.itemIds];
  for (const entry of inner) {
    if (entry.itemId !== undefined && !itemIds.includes(entry.itemId)) {
      itemIds.push(entry.itemId);
    }
  }
  const names = refNames(t, brief, mark.itemIds);
  const verdictLine = (): { text: string; tone: 'plain' | 'amber' } => {
    switch (mark.verdict) {
      case 'supported':
        return {
          text: t('statementSupportedBy', { items: names }),
          tone: 'plain',
        };
      case 'partly':
        return { text: t('citePartly', { items: names }), tone: 'plain' };
      case 'unsupported':
        return { text: t('citeUnsupported'), tone: 'amber' };
      case 'unclear':
        return { text: t('citeUnclear'), tone: 'plain' };
      case 'pending':
        return { text: t('citePending'), tone: 'plain' };
      default:
        return {
          text:
            staleReason(version, mark, brief) === 'item-excluded'
              ? t('citeStaleExcluded')
              : t('citeStaleBrief'),
          tone: 'plain',
        };
    }
  };
  const line = verdictLine();
  const Icon =
    mark.verdict === 'unsupported'
      ? IconAlertTriangle
      : mark.verdict === 'stale'
        ? IconRefreshAlert
        : mark.verdict === 'unclear'
          ? IconHelpCircle
          : null;
  const explainerId = `${mark.segmentId}-${mark.start}-explainer`;

  return (
    <div className="space-y-2 text-xs">
      {showSentence && (
        <p className="text-gray-900 dark:text-gray-100" dir="auto">
          {segmentText.slice(mark.start, mark.end)}
        </p>
      )}
      <p
        className={`flex items-start gap-1 ${
          line.tone === 'amber'
            ? 'text-amber-900 dark:text-amber-300'
            : 'text-gray-800 dark:text-gray-200'
        }`}
      >
        {Icon && <Icon size={14} className="mt-0.5 shrink-0" aria-hidden />}
        <span>{line.text}</span>
      </p>
      {mark.note === 'ungrounded-inside' && ungrounded.length === 0 && (
        <p className="text-amber-900 dark:text-amber-300">
          {t('verdictNoteUngrounded')}
        </p>
      )}
      {ungrounded.map((entry) => (
        <p
          key={`${entry.kind}:${entry.start}`}
          className="flex items-start gap-1 text-amber-900 dark:text-amber-300"
        >
          <IconAlertTriangle
            size={14}
            className="mt-0.5 shrink-0"
            aria-hidden
          />
          <span>
            {entry.kind === 'quote'
              ? t('quoteNotInBrief')
              : t('numberNotInBrief')}
            <span className="ms-1 text-gray-700 dark:text-gray-300" dir="auto">
              {segmentText.slice(entry.start, entry.end)}
            </span>
          </span>
        </p>
      ))}
      {mark.reason && (
        <p className="flex flex-wrap items-start gap-x-2 gap-y-0.5 text-gray-800 dark:text-gray-200">
          <span className="inline-flex items-start gap-1">
            <IconSparkles size={14} className="mt-0.5 shrink-0" aria-hidden />
            <span dir="auto">{t('aiSays', { reason: mark.reason })}</span>
          </span>
          {mark.modelId && (
            <span className="text-gray-600 dark:text-gray-400">
              {mark.modelId}
            </span>
          )}
        </p>
      )}
      {itemIds.map((id) => {
        if (id === KEY_MESSAGE_REF) {
          return (
            <p key={id} className="text-gray-700 dark:text-gray-300">
              {t('fromKeyMessage')}
            </p>
          );
        }
        if (id === CALL_TO_ACTION_REF) {
          return (
            <p key={id} className="text-gray-700 dark:text-gray-300">
              {t('fromCallToAction')}
            </p>
          );
        }
        const item = itemsById.get(id);
        if (!item) return null;
        const quoted = inner.find(
          (entry) => entry.itemId === id && entry.elided,
        );
        return (
          <ProofCard
            key={id}
            item={item}
            sources={sources}
            elided={quoted ? { pieces: quoted.pieces ?? [] } : undefined}
          />
        );
      })}
      {check && (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-x-2">
            <CheckButton
              check={
                check.describedBy
                  ? check
                  : { ...check, describedBy: explainerId }
              }
            />
            {check.error && (
              <span className="text-amber-900 dark:text-amber-300">
                {check.error}
              </span>
            )}
          </div>
          {!check.describedBy && (
            <p
              id={explainerId}
              className="text-[11px] text-gray-600 dark:text-gray-400"
            >
              {t('citeExplainer')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

interface ProofListProps {
  /** The version's quote and number marks (the hard checks). */
  marks: GroundingMark[];
  /** One per sentence, from the cite step. */
  citations: CitationMark[];
  segments: Segment[];
  brief: Brief;
  sources: DraftSource[];
  /** Sends sentences to the cite step. Absent = no button. */
  onVerify?: (claims: VerifyClaim[]) => void;
  /** The segment being checked, 'all' for a whole-column check, null when idle. */
  verifyingId?: string | 'all' | null;
  /** The last check's failure, shown by the column button. */
  error?: string;
  version?: Version;
}

/**
 * "Evidence": every sentence of a version with what it rests on, then any
 * quote or number that fails the hard checks or sits outside a sentence.
 * The lines on top are the answer to "can I trust this post", readable in
 * a second.
 */
export function ProofList({
  marks,
  citations,
  segments,
  brief,
  sources,
  onVerify,
  verifyingId = null,
  error,
  version,
}: ProofListProps) {
  const t = useTranslations('workflows.drafter');
  const itemsById = new Map(brief.items.map((item) => [item.id, item]));
  const order = new Map(segments.map((segment, index) => [segment.id, index]));
  const textOfSegment = (id: string): string =>
    segments.find((segment) => segment.id === id)?.text ?? '';
  const textOf = (mark: { segmentId: string; start: number; end: number }) =>
    textOfSegment(mark.segmentId).slice(mark.start, mark.end);
  const byPosition = <T extends { segmentId: string; start: number }>(
    a: T,
    b: T,
  ): number =>
    (order.get(a.segmentId) ?? 0) - (order.get(b.segmentId) ?? 0) ||
    a.start - b.start;
  const sentences = [...citations].sort(byPosition);
  const counts = {
    supported: 0,
    partly: 0,
    unsupported: 0,
    unchecked: 0,
    stale: 0,
  };
  for (const mark of sentences) {
    if (mark.verdict === 'supported') counts.supported += 1;
    else if (mark.verdict === 'partly') counts.partly += 1;
    else if (mark.verdict === 'unsupported') counts.unsupported += 1;
    else if (mark.verdict === 'stale') counts.stale += 1;
    else counts.unchecked += 1;
  }
  const hard = { total: marks.length, traced: 0, vouched: 0, ungrounded: 0 };
  for (const mark of marks) {
    if (mark.itemId === undefined) hard.ungrounded += 1;
    else if (itemsById.get(mark.itemId)?.verified === 'user-asserted')
      hard.vouched += 1;
    else hard.traced += 1;
  }
  // Ungrounded quotes and numbers are always listed (they block); grounded
  // ones only when no sentence carries them (a hashtag line's figure).
  const loose = [...marks]
    .filter(
      (mark) =>
        mark.itemId === undefined ||
        !sentences.some(
          (sentence) =>
            sentence.segmentId === mark.segmentId &&
            sentence.start <= mark.start &&
            mark.end <= sentence.end,
        ),
    )
    .sort(byPosition);
  // A sentence code has already judged (an ungrounded quote or number
  // inside) is not sent: rewording it gives it a new turn.
  const toCheck = sentences.filter(
    (mark) => mark.verdict !== 'supported' && mark.note !== 'ungrounded-inside',
  );
  const claims: VerifyClaim[] = toCheck
    .slice(0, DRAFTER_LIMITS.MAX_VERIFY_CLAIMS)
    .map((mark) => ({ segmentId: mark.segmentId, text: textOf(mark) }));
  const busy = verifyingId !== null;
  const explainerId = 'drafter-cite-explainer';

  if (marks.length === 0 && citations.length === 0) {
    return (
      <p className="text-xs text-gray-700 dark:text-gray-300">
        {t('proofNothing')}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
        <div className="space-y-0.5">
          {citations.length > 0 && (
            <p
              className={`text-xs font-medium ${
                counts.unsupported > 0
                  ? 'text-amber-900 dark:text-amber-300'
                  : 'text-gray-900 dark:text-gray-100'
              }`}
            >
              {t('citeSummary', {
                supported: counts.supported,
                total: citations.length,
              })}
              {counts.partly > 0 &&
                ` · ${t('proofPartlyCount', { count: counts.partly })}`}
              {counts.unsupported > 0 && (
                <span className="text-amber-900 dark:text-amber-300">
                  {` · ${t('proofUnsupportedCount', { count: counts.unsupported })}`}
                </span>
              )}
              {counts.unchecked > 0 &&
                ` · ${t('proofUncheckedCount', { count: counts.unchecked })}`}
              {counts.stale > 0 &&
                ` · ${t('proofStaleCount', { count: counts.stale })}`}
            </p>
          )}
          {hard.total > 0 && (
            <p
              className={`text-xs ${
                hard.ungrounded > 0
                  ? 'font-medium text-amber-900 dark:text-amber-300'
                  : 'text-gray-700 dark:text-gray-300'
              }`}
            >
              {t('proofSummary', {
                traced: hard.traced + hard.vouched,
                total: hard.total,
              })}
              {hard.vouched > 0 &&
                ` · ${t('proofVouched', { count: hard.vouched })}`}
              {hard.ungrounded > 0 &&
                ` · ${t('proofUngroundedCount', { count: hard.ungrounded })}`}
            </p>
          )}
        </div>
        {onVerify && toCheck.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-2">
            <button
              type="button"
              className={ghostButton}
              disabled={busy}
              aria-busy={verifyingId === 'all' || undefined}
              aria-describedby={explainerId}
              title={
                busy && verifyingId !== 'all' ? t('checkRunning') : undefined
              }
              onClick={() => onVerify(claims)}
            >
              <IconSparkles size={14} aria-hidden />
              {verifyingId === 'all'
                ? t('checkingWithAi')
                : t('checkAllWithAi', { count: claims.length })}
            </button>
            {error && (
              <span className="text-xs text-amber-900 dark:text-amber-300">
                {error}
              </span>
            )}
          </div>
        )}
      </div>
      {onVerify && (
        <p
          id={explainerId}
          className="text-[11px] text-gray-600 dark:text-gray-400"
        >
          {t('citeExplainer')}
          {toCheck.length > DRAFTER_LIMITS.MAX_VERIFY_CLAIMS &&
            ` ${t('verifyMore', { count: DRAFTER_LIMITS.MAX_VERIFY_CLAIMS })}`}
        </p>
      )}
      <ol className="space-y-2">
        {sentences.map((mark) => {
          const tag = refTags(t, brief, mark.itemIds);
          const problem =
            mark.verdict === 'unsupported' || mark.verdict === 'unclear';
          return (
            <li
              key={`${mark.segmentId}:${mark.start}`}
              className="rounded-lg border border-gray-200 p-2 dark:border-gray-700"
            >
              <p
                className="mb-1 text-xs text-gray-900 dark:text-gray-100"
                dir="auto"
              >
                <span
                  className={`me-1 font-semibold tabular-nums ${
                    problem ? 'text-amber-900 dark:text-amber-300' : ''
                  }`}
                  aria-hidden
                >
                  {tag || '?'}
                </span>
                <span className={citationClass(mark.verdict, true)}>
                  {textOf(mark)}
                </span>
              </p>
              <CitationPanel
                mark={mark}
                segmentText={textOfSegment(mark.segmentId)}
                marks={marks}
                brief={brief}
                sources={sources}
                version={version}
                check={
                  onVerify && mark.note !== 'ungrounded-inside'
                    ? {
                        onCheck: () =>
                          onVerify([
                            { segmentId: mark.segmentId, text: textOf(mark) },
                          ]),
                        checking: verifyingId === mark.segmentId,
                        disabled: busy,
                        describedBy: explainerId,
                      }
                    : undefined
                }
              />
            </li>
          );
        })}
        {loose.map((mark) => {
          const item = mark.itemId ? itemsById.get(mark.itemId) : undefined;
          return (
            <li
              key={`${mark.segmentId}:${mark.kind}:${mark.start}`}
              className="rounded-lg border border-gray-200 p-2 dark:border-gray-700"
            >
              <p
                className="mb-1 text-xs text-gray-900 dark:text-gray-100"
                dir="auto"
              >
                {mark.itemId && (
                  <span className="me-1 font-semibold tabular-nums" aria-hidden>
                    {refTags(t, brief, [mark.itemId])}
                  </span>
                )}
                {textOf(mark)}
              </p>
              {item ? (
                <ProofCard
                  item={item}
                  sources={sources}
                  elided={
                    mark.elided ? { pieces: mark.pieces ?? [] } : undefined
                  }
                />
              ) : mark.itemId === KEY_MESSAGE_REF ? (
                <p className="text-xs text-gray-700 dark:text-gray-300">
                  {t('fromKeyMessage')}
                </p>
              ) : (
                <p className="flex items-start gap-1 text-xs text-amber-900 dark:text-amber-300">
                  <IconAlertTriangle
                    size={14}
                    className="mt-0.5 shrink-0"
                    aria-hidden
                  />
                  {mark.kind === 'quote'
                    ? t('quoteNotInBrief')
                    : t('numberNotInBrief')}
                </p>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
