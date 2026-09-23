'use client';

import {
  IconAlertTriangle,
  IconArrowLeft,
  IconArrowRight,
  IconArrowsMaximize,
  IconCheck,
  IconCircleCheck,
  IconCopy,
  IconDotsVertical,
  IconEye,
  IconEyeCheck,
  IconEyeOff,
  IconInfoCircle,
  IconListCheck,
  IconMessage2,
  IconMicrophone,
  IconPhotoPlus,
  IconPin,
  IconPinFilled,
  IconSend,
  IconSparkles,
  IconX,
} from '@tabler/icons-react';
import { KeyboardEvent, ReactNode, useState } from 'react';

import { useTranslations } from 'next-intl';

import { BRIEF_ITSELF } from '@/lib/utils/shared/drafter/core/grounding';
import { PublishBlocker } from '@/lib/utils/shared/drafter/core/publishing';
import { pendingEdits } from '@/lib/utils/shared/drafter/core/revisions';
import {
  approvalStatus,
  changedSinceCopied,
  changedSinceSent,
  hasText,
} from '@/lib/utils/shared/drafter/core/versions';
import { CheckFinding } from '@/lib/utils/shared/review/deterministicChecks';

import {
  Brief,
  DraftSource,
  GroundingMark,
  Segment,
  ToneRef,
  Version,
  VersionSnapshot,
  VersionSpec,
  VersionStatus,
} from '@/types/drafter';

import { InlineWordDiff } from '@/components/Workflows/Shared/Review/InlineWordDiff';

import { MediaThumb } from './MediaThumb';
import { Popover, iconButton, menuItem } from './Popover';
import { ProofCard } from './ProofCard';
import { ProofList } from './ProofList';
import { VersionPreview } from './VersionPreview';
import { SpecAdapterUi } from './adapterUi';
import { shortSpecName } from './specNames';

/** A voice the user may pick: one of their tones, or an organisation guide. */
export interface VoiceOption {
  ref: ToneRef;
  name: string;
  /** True for organisation tone guides, which the user cannot edit. */
  shared: boolean;
}

/**
 * Why a version may not be sent onward: the core gate's reasons, plus what
 * only the caller knows (a thread needs reply-chaining the tool may lack).
 */
export type SendBlocker = PublishBlocker | 'thread' | 'media';

export const voiceKey = (ref: ToneRef | undefined): string =>
  ref ? `${ref.kind}:${ref.id}` : '';

export interface VersionColumnProps {
  spec: VersionSpec;
  version: Version | undefined;
  ui: SpecAdapterUi;
  /** `column` in Compare; `focus` gives the version the whole area. */
  layout: 'column' | 'focus';
  statuses: VersionStatus[];
  findings: CheckFinding[];
  marks: GroundingMark[];
  brief: Brief;
  sources: DraftSource[];
  writing: boolean;
  error?: string;
  pinned: boolean;
  canMoveEarlier: boolean;
  canMoveLater: boolean;
  tracedItemId: string | null;
  /** Lets the workspace focus this column's header (number-key jump). */
  registerHeader?: (node: HTMLElement | null) => void;
  onTrace: (itemId: string | null) => void;
  onEdit: (segmentId: string, text: string) => void;
  onSplit: (segmentId: string, caret: number) => void;
  onMerge: (segmentId: string) => void;
  /** Moves text between posts until the version fits; rewords nothing. */
  onFit: () => void;
  onDropHashtags: (segmentId: string) => void;
  /** Asks for cuts that make this post fit; they arrive as suggestions. */
  onTighten: (segmentId: string) => void;
  /** The segment a tighten request is running for, if any. */
  tighteningId: string | null;
  onApprove: (approved: boolean) => void;
  onCopied: () => void;
  onUseProposed: () => void;
  onKeepMine: () => void;
  onRestore: (snapshot: VersionSnapshot) => void;
  voices: VoiceOption[];
  /** `null` = no voice: the spec's own guidance alone. */
  onVoice: (ref: ToneRef | null) => void;
  /**
   * An accepted instruction worth keeping in this version's voice. `shared`
   * voices (organisation guides) cannot be edited, so the offer there is to
   * save a personal copy carrying the new rule.
   */
  teachOffer?: { instruction: string; voiceName: string; shared: boolean };
  onTeach: (accept: boolean) => void;
  /** Attaching images. Absent = this workspace does not offer them. */
  media?: {
    /** Id of the image being described or the segment being uploaded to. */
    busyId: string | null;
    onAdd: (segmentId: string, files: File[]) => void;
    onRemove: (segmentId: string, mediaId: string) => void;
    onAlt: (segmentId: string, mediaId: string, alt: string) => void;
    onSuggestAlt: (segmentId: string, mediaId: string) => void;
  };
  /** Whether this version is shown as its target will roughly show it. */
  previewing: boolean;
  onPreviewChange: (on: boolean) => void;
  /**
   * Present only when the server says this user may send this version's
   * posts onward (a kind's own action; for channels, to Hootsuite). Absent
   * = no button at all, not a disabled one advertising a feature.
   */
  send?: {
    /** Why it may not be sent yet, worst first; empty = it may. */
    blockers: SendBlocker[];
    /** False when the user has not connected the service in Settings. */
    connected: boolean;
    sending: boolean;
  };
  onSend?: () => void;
  /** Display names for `guide:<id>` criteria, from the last assessment. */
  criterionNames?: Record<string, string>;
  onAcceptEdit: (editId: string) => void;
  onRejectEdit: (editId: string) => void;
  onAcceptAllEdits: () => void;
  /** Opens the rail addressed to this version, or to one of its segments. */
  onRevise: (segmentId?: string) => void;
  onHide: () => void;
  onTogglePin: () => void;
  onMove: (delta: -1 | 1) => void;
  onFocusMode: () => void;
  onRetry: () => void;
}

const ghostButton =
  'inline-flex min-h-[32px] items-center gap-1 rounded-lg px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-300 dark:hover:bg-surface-dark-elevated';

const STATUS_TONE: Record<VersionStatus, string> = {
  empty: 'text-gray-600 dark:text-gray-400',
  'to-fix': 'text-amber-900 dark:text-amber-300',
  suggestions: 'text-gray-800 dark:text-gray-200',
  proposed: 'text-gray-800 dark:text-gray-200',
  'brief-changed': 'text-amber-900 dark:text-amber-300',
  'approval-changed': 'text-amber-900 dark:text-amber-300',
  ready: 'text-gray-800 dark:text-gray-200',
  approved: 'text-green-800 dark:text-green-300',
};

interface Piece {
  start: number;
  end: number;
  mark?: GroundingMark;
  overflow: boolean;
}

/** Splits a segment into runs by mark and by the overflow boundary. */
function piecesOf(
  text: string,
  marks: GroundingMark[],
  overflowAt: number | null,
): Piece[] {
  const cuts = new Set<number>([0, text.length]);
  for (const mark of marks) {
    cuts.add(mark.start);
    cuts.add(mark.end);
  }
  if (overflowAt !== null) cuts.add(overflowAt);
  const points = [...cuts]
    .filter((point) => point >= 0 && point <= text.length)
    .sort((a, b) => a - b);
  const pieces: Piece[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const start = points[i];
    const end = points[i + 1];
    if (start === end) continue;
    pieces.push({
      start,
      end,
      mark: marks.find((mark) => start >= mark.start && end <= mark.end),
      overflow: overflowAt !== null && start >= overflowAt,
    });
  }
  return pieces;
}

/**
 * One version: what it says, whether it fits, whether it is grounded, and
 * whether a person has called it final. Kind-agnostic; counters and the fold
 * arrive through the adapter. Focus is the same component given more room,
 * so it is a zoom of Compare and never a second place to learn.
 */
export function VersionColumn({
  // Kept out of `props`: handing `props.registerHeader` to `ref` makes the
  // hooks lint treat the whole props object as a ref.
  registerHeader,
  ...props
}: VersionColumnProps) {
  const { spec, version, ui, layout, statuses, marks, brief, tracedItemId } =
    props;
  const t = useTranslations('workflows.drafter');
  const tKind = useTranslations(ui.namespace);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [proofFor, setProofFor] = useState<string | null>(null);
  const [proofOpen, setProofOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState(-1);
  const [confirmCopy, setConfirmCopy] = useState(false);
  const [confirmSend, setConfirmSend] = useState(false);
  /** Where to put the caret when the editor opens from a preview press. */
  const [caretAt, setCaretAt] = useState<number | null>(null);

  const focus = layout === 'focus';
  // Plain values: the React Compiler memoizes these, and hand-written
  // useMemo here only makes it skip the component.
  const segments = version?.segments ?? [];
  const itemsById = new Map(brief.items.map((item) => [item.id, item]));
  const markNumber = new Map(
    marks.map((m, index) => [`${m.segmentId}:${m.start}`, index + 1]),
  );
  const approval = approvalStatus(version);
  const status = statuses[0] ?? 'empty';
  const blocking = props.findings.filter((f) => f.severity === 'block');
  // Quotes and numbers are already marked in the text and listed in the
  // proof, so the findings list carries everything else.
  const listed = props.findings.filter(
    (f) => f.checkId !== 'quote-verbatim' && f.checkId !== 'number-grounded',
  );
  const slot = ui.firstSegmentSlot(spec, segments);
  // Whether moving text between posts would change anything. Only worked
  // out when something is over; the ids are throwaway, this is a dry run.
  const anyOver = segments.some(
    (_, index) => (ui.segmentMeta(spec, segments, index)?.over ?? 0) > 0,
  );
  const canFit =
    anyOver &&
    !!ui.fit &&
    ui.fit(spec, segments, brief, () => 'dry-run') !== segments;
  const copyPlan = version ? ui.copyPlan(spec, version) : [];
  const usesTraced =
    !tracedItemId || marks.some((mark) => mark.itemId === tracedItemId);
  const showProof = proofOpen || focus;
  const previewModel =
    props.previewing && ui.preview && hasText(version)
      ? ui.preview(spec, segments, brief.links)
      : null;
  const suggestions = pendingEdits(version);
  const voiceName = props.voices.find(
    (voice) => voiceKey(voice.ref) === voiceKey(version?.toneRef),
  )?.name;
  // A voice the version names but the user does not have (a set's default
  // guide they may not read, a deleted tone): shown as such, never blank.
  const unavailableVoice = version?.toneRef && !voiceName;

  const copyNext = async () => {
    if (blocking.length > 0 && !confirmCopy) {
      setConfirmCopy(true);
      return;
    }
    const index = copyPlan.length > 1 ? (copiedIndex + 1) % copyPlan.length : 0;
    const step = copyPlan[index];
    if (!step) return;
    try {
      await navigator.clipboard.writeText(step.text);
      setCopiedIndex(index);
      setConfirmCopy(false);
      if (index === copyPlan.length - 1) props.onCopied();
    } catch {
      // Clipboard denied: the text stays selectable in the column.
    }
  };

  const copyLabel = (): string => {
    if (confirmCopy) return t('copyWithProblems', { count: blocking.length });
    if (copyPlan.length > 1) {
      const next = (copiedIndex + 1) % copyPlan.length;
      return t('copyPost', { n: next + 1 });
    }
    return approval === 'approved' ? t('copy') : t('copyDraft');
  };

  const onArticleKey = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') return;
    if (
      event.key === 'p' &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      setProofOpen((open) => !open);
    }
  };

  const onHeaderKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      props.onFocusMode();
      return;
    }
    if (!event.altKey) return;
    const rtl = document.documentElement.dir === 'rtl';
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const earlier = (event.key === 'ArrowLeft') !== rtl;
      props.onMove(earlier ? -1 : 1);
    }
  };

  const renderText = (segment: Segment, overflowAt: number | null) => {
    const segmentMarks = marks.filter((m) => m.segmentId === segment.id);
    const nodes: ReactNode[] = [];
    for (const piece of piecesOf(segment.text, segmentMarks, overflowAt)) {
      const content = segment.text.slice(piece.start, piece.end);
      const overflowClass = piece.overflow
        ? 'bg-amber-100 dark:bg-amber-900/40'
        : '';
      const key = `${piece.start}-${piece.end}`;
      if (!piece.mark) {
        nodes.push(
          <span key={key} className={overflowClass}>
            {content}
          </span>,
        );
        continue;
      }
      const grounded = piece.mark.itemId !== undefined;
      const traced = grounded && piece.mark.itemId === tracedItemId;
      const markKey = `${segment.id}:${piece.mark.start}`;
      const closesMark = piece.end === piece.mark.end;
      nodes.push(
        <button
          key={key}
          type="button"
          className={`rounded-sm text-start underline decoration-dotted underline-offset-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${overflowClass} ${
            grounded
              ? traced
                ? 'bg-blue-100 dark:bg-blue-900/60'
                : 'decoration-gray-500'
              : 'bg-amber-100 decoration-amber-700 dark:bg-amber-900/40'
          }`}
          aria-expanded={proofFor === markKey}
          onMouseEnter={() =>
            grounded && props.onTrace(piece.mark?.itemId ?? null)
          }
          onMouseLeave={() => props.onTrace(null)}
          onClick={(event) => {
            event.stopPropagation();
            setProofFor(proofFor === markKey ? null : markKey);
          }}
        >
          {content}
          {showProof && closesMark && (
            <sup className="ms-0.5 font-semibold tabular-nums no-underline">
              {markNumber.get(markKey)}
            </sup>
          )}
        </button>,
      );
    }
    return nodes;
  };

  const proofPanel = (segment: Segment) => {
    const mark = marks.find(
      (m) =>
        `${m.segmentId}:${m.start}` === proofFor && m.segmentId === segment.id,
    );
    if (!mark) return null;
    const item = mark.itemId ? itemsById.get(mark.itemId) : undefined;
    return (
      <div className="mt-1 rounded-lg bg-gray-50 p-2 text-xs dark:bg-surface-dark-elevated">
        {item ? (
          <ProofCard item={item} sources={props.sources} />
        ) : mark.itemId === BRIEF_ITSELF ? (
          <p className="text-gray-700 dark:text-gray-300">
            {t('fromKeyMessage')}
          </p>
        ) : (
          <p className="flex items-start gap-1 text-amber-900 dark:text-amber-300">
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
      </div>
    );
  };

  // Captured once: narrowing on `props.media` does not survive the callbacks
  // below, and a local keeps them free of optional chaining.
  const mediaProps = props.media;
  const segmentList = segments.map((segment, index) => {
    const meta = ui.segmentMeta(spec, segments, index);
    const showFold =
      index === 0 && !!slot?.foldLabelKey && segment.text.includes('\n');
    return (
      <section
        key={segment.id}
        className={
          segments.length > 1
            ? 'border-s border-gray-300 ps-3 dark:border-gray-600'
            : ''
        }
      >
        <div className="mb-1 flex items-center justify-between gap-2 text-xs tabular-nums text-gray-700 dark:text-gray-300">
          <span>
            {index === 0 && slot
              ? `${tKind(`slots.${slot.labelKey}`)} ${slot.count} / ${slot.max}`
              : (meta?.numbering ?? '')}
          </span>
          {meta && (
            <span
              className={
                meta.over > 0
                  ? 'font-medium text-amber-900 dark:text-amber-300'
                  : ''
              }
            >
              {meta.over > 0 ? (
                <span className="inline-flex items-center gap-1">
                  <IconAlertTriangle size={13} aria-hidden />
                  {t('overBy', { count: meta.over })}
                </span>
              ) : (
                `${meta.count} / ${meta.limit}`
              )}
            </span>
          )}
        </div>

        {editingId === segment.id ? (
          <textarea
            autoFocus
            ref={(node) => {
              // Opened from a preview press: land on the word that was
              // pressed, once, then let the user move freely.
              if (node && caretAt !== null) {
                const at = Math.min(caretAt, node.value.length);
                node.setSelectionRange(at, at);
                setCaretAt(null);
              }
            }}
            lang={brief.language || undefined}
            dir="auto"
            rows={Math.max(
              4,
              Math.ceil(segment.text.length / (focus ? 70 : 38)),
            )}
            className="w-full resize-y rounded-lg border border-blue-600 bg-gray-50 px-2 py-1.5 text-sm leading-relaxed text-gray-900 focus:outline-none dark:bg-surface-dark-elevated dark:text-gray-100"
            value={segment.text}
            onChange={(event) => props.onEdit(segment.id, event.target.value)}
            onBlur={() => setEditingId(null)}
            onKeyDown={(event) => {
              const target = event.currentTarget;
              event.stopPropagation();
              if (event.key === 'Escape') setEditingId(null);
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                props.onSplit(segment.id, target.selectionStart);
                setEditingId(null);
              }
              if (
                event.key === 'Backspace' &&
                index > 0 &&
                target.selectionStart === 0 &&
                target.selectionEnd === 0
              ) {
                event.preventDefault();
                props.onMerge(segment.id);
                setEditingId(null);
              }
            }}
          />
        ) : (
          <div
            role="button"
            tabIndex={0}
            lang={brief.language || undefined}
            dir="auto"
            aria-label={t('editPost', { n: index + 1 })}
            className="cursor-text whitespace-pre-wrap break-words rounded-lg px-2 py-1.5 text-sm leading-relaxed text-gray-900 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 dark:text-gray-100 dark:hover:bg-surface-dark-elevated"
            onClick={() => setEditingId(segment.id)}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                setEditingId(segment.id);
              }
            }}
          >
            {renderText(segment, meta?.overflowAt ?? null)}
          </div>
        )}
        {showFold && slot?.foldLabelKey && (
          <p className="mt-1 flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
            <span className="h-px flex-1 border-t border-dashed border-gray-400" />
            {t('foldAfterFirstLine', {
              label: tKind(`slots.${slot.foldLabelKey}`),
            })}
            <span className="h-px flex-1 border-t border-dashed border-gray-400" />
          </p>
        )}
        {meta && meta.over > 0 && (
          // A hard limit gets fixes, not just a red number. Only the ones
          // that would change something are offered: no button that does
          // nothing. Moving and dropping tags reword nothing; shortening is
          // a model's work and arrives as suggestions to accept or reject.
          <div className="mt-1 flex flex-wrap gap-x-1">
            {canFit && (
              <button
                type="button"
                className={ghostButton}
                onClick={props.onFit}
              >
                {segments.length > 1 ? t('moveOverflow') : t('makeThread')}
              </button>
            )}
            {ui.dropHashtags &&
              ui.dropHashtags(spec, segments, segment.id, brief) !==
                segments && (
                <button
                  type="button"
                  className={ghostButton}
                  onClick={() => props.onDropHashtags(segment.id)}
                >
                  {t('dropHashtags')}
                </button>
              )}
            <button
              type="button"
              className={ghostButton}
              disabled={props.tighteningId !== null}
              onClick={() => props.onTighten(segment.id)}
            >
              {props.tighteningId === segment.id
                ? t('tightening')
                : t('tighten', { count: meta.over })}
            </button>
          </div>
        )}
        {mediaProps && (
          <div className="mt-2 space-y-2">
            {(segment.media ?? []).map((item) => (
              <div
                key={item.id}
                className="flex gap-2 rounded-lg border border-gray-200 p-2 dark:border-gray-700"
              >
                <MediaThumb
                  imageRef={item.ref}
                  alt={item.alt}
                  className="h-16 w-16 shrink-0"
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <label className="block text-xs text-gray-700 dark:text-gray-300">
                    {t('altText')}
                    <textarea
                      className="mt-0.5 w-full resize-y rounded-md border border-gray-300 bg-gray-50 px-2 py-1 text-xs text-gray-900 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100"
                      rows={2}
                      dir="auto"
                      lang={brief.language || undefined}
                      aria-invalid={!item.alt.trim()}
                      placeholder={t('altTextPlaceholder')}
                      value={item.alt}
                      onChange={(event) =>
                        mediaProps.onAlt(
                          segment.id,
                          item.id,
                          event.target.value,
                        )
                      }
                      onKeyDown={(event) => event.stopPropagation()}
                    />
                  </label>
                  <div className="flex flex-wrap gap-1">
                    <button
                      type="button"
                      className={ghostButton}
                      disabled={mediaProps.busyId !== null}
                      title={t('suggestAltHint')}
                      onClick={() =>
                        mediaProps.onSuggestAlt(segment.id, item.id)
                      }
                    >
                      <IconSparkles size={14} aria-hidden />
                      {mediaProps.busyId === item.id
                        ? t('suggestingAlt')
                        : t('suggestAlt')}
                    </button>
                    <button
                      type="button"
                      className={ghostButton}
                      aria-label={t('removeImage', { name: item.name })}
                      onClick={() => mediaProps.onRemove(segment.id, item.id)}
                    >
                      <IconX size={14} aria-hidden />
                      {t('remove')}
                    </button>
                  </div>
                </div>
              </div>
            ))}
            <label
              className={`${ghostButton} cursor-pointer ${
                mediaProps.busyId !== null
                  ? 'pointer-events-none opacity-30'
                  : ''
              }`}
            >
              <IconPhotoPlus size={14} aria-hidden />
              {mediaProps.busyId === segment.id
                ? t('uploadingImage')
                : t('addImage')}
              <input
                type="file"
                accept="image/*"
                multiple
                className="sr-only"
                disabled={mediaProps.busyId !== null}
                onChange={(event) => {
                  const files = [...(event.target.files ?? [])];
                  // Reset so choosing the same file again fires a change.
                  event.target.value = '';
                  if (files.length > 0) mediaProps.onAdd(segment.id, files);
                }}
              />
            </label>
          </div>
        )}
        {proofPanel(segment)}
      </section>
    );
  });

  /** Findings, proof and history: under the text in Compare, beside it in Focus. */
  const details = (
    <>
      {props.teachOffer && (
        <div className="space-y-1 rounded-lg border border-gray-300 p-2 text-xs dark:border-gray-600">
          <p className="text-gray-900 dark:text-gray-100">
            {t('teachQuestion', { channel: spec.name })}
          </p>
          <p className="text-gray-700 dark:text-gray-300" dir="auto">
            <ins className="rounded-sm bg-green-50 text-green-800 no-underline dark:bg-green-900/20 dark:text-green-300">
              {`- ${props.teachOffer.instruction}`}
            </ins>
          </p>
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              className={ghostButton}
              onClick={() => props.onTeach(true)}
            >
              <IconCheck size={14} aria-hidden />
              {props.teachOffer.shared
                ? t('teachSaveCopy', { voice: props.teachOffer.voiceName })
                : t('teachAdd', { voice: props.teachOffer.voiceName })}
            </button>
            <button
              type="button"
              className={ghostButton}
              onClick={() => props.onTeach(false)}
            >
              {t('notNow')}
            </button>
          </div>
        </div>
      )}

      {suggestions.length > 0 && (
        <div className="space-y-2" aria-label={t('suggestions')}>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-gray-900 dark:text-gray-100">
              {t('suggestionCount', { count: suggestions.length })}
            </p>
            {suggestions.length > 1 && (
              <button
                type="button"
                className={ghostButton}
                onClick={props.onAcceptAllEdits}
              >
                <IconCheck size={14} aria-hidden />
                {t('acceptAll', { count: suggestions.length })}
              </button>
            )}
          </div>
          {suggestions[0].instruction && (
            <p className="text-xs text-gray-600 dark:text-gray-400" dir="auto">
              {t('fromInstruction', {
                instruction: suggestions[0].instruction,
              })}
            </p>
          )}
          <ul className="space-y-2">
            {suggestions.map((edit) => {
              const at = segments.findIndex((s) => s.id === edit.segmentId);
              return (
                <li
                  key={edit.id}
                  className="rounded-lg border border-gray-300 p-2 dark:border-gray-600"
                >
                  <p className="mb-1 flex flex-wrap gap-x-2 text-xs text-gray-600 dark:text-gray-400">
                    {edit.criterion !== 'revision' && (
                      <span className="font-medium text-gray-900 dark:text-gray-100">
                        {props.criterionNames?.[edit.criterion] ??
                          (t.has(`criteria.${edit.criterion}`)
                            ? t(`criteria.${edit.criterion}`)
                            : edit.criterion)}
                      </span>
                    )}
                    {segments.length > 1 && at >= 0 && (
                      <span className="tabular-nums">
                        {t('postN', { n: at + 1 })}
                      </span>
                    )}
                  </p>
                  <p className="text-sm leading-relaxed" dir="auto">
                    <InlineWordDiff before={edit.before} after={edit.after} />
                  </p>
                  {edit.reason && (
                    <p
                      className="mt-1 text-xs text-gray-700 dark:text-gray-300"
                      dir="auto"
                    >
                      {edit.reason}
                    </p>
                  )}
                  <div className="mt-1 flex gap-1">
                    <button
                      type="button"
                      className={ghostButton}
                      onClick={() => props.onAcceptEdit(edit.id)}
                    >
                      <IconCheck size={14} aria-hidden />
                      {t('accept')}
                    </button>
                    <button
                      type="button"
                      className={ghostButton}
                      onClick={() => props.onRejectEdit(edit.id)}
                    >
                      {t('reject')}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {listed.length > 0 && (
        <ul className="space-y-1" aria-label={t('findings')}>
          {listed.map((finding, index) => {
            const message =
              finding.scope === 'kind'
                ? tKind(`checks.${finding.messageKey}`, finding.values)
                : t(`checks.${finding.messageKey}`, finding.values);
            return (
              <li
                key={`${finding.checkId}:${finding.targetId ?? ''}:${index}`}
                className={`flex items-start gap-1 text-xs ${
                  finding.severity === 'block'
                    ? 'text-amber-900 dark:text-amber-300'
                    : 'text-gray-700 dark:text-gray-300'
                }`}
              >
                {finding.severity === 'block' ? (
                  <IconAlertTriangle
                    size={14}
                    className="mt-0.5 shrink-0"
                    aria-hidden
                  />
                ) : (
                  <IconInfoCircle
                    size={14}
                    className="mt-0.5 shrink-0"
                    aria-hidden
                  />
                )}
                {message}
              </li>
            );
          })}
        </ul>
      )}

      {approval === 'changed' && version?.approval && (
        <div className="space-y-1 rounded-lg border border-amber-300 p-2 dark:border-amber-800">
          <p className="text-xs font-medium text-amber-900 dark:text-amber-300">
            {t('changedSinceApproved')}
          </p>
          <div className="text-sm leading-relaxed" dir="auto">
            <InlineWordDiff
              before={version.approval.texts.join('\n\n')}
              after={segments.map((s) => s.text).join('\n\n')}
            />
          </div>
        </div>
      )}

      {showProof && hasText(version) && (
        <ProofList
          marks={marks}
          segments={segments}
          brief={brief}
          sources={props.sources}
        />
      )}

      {version && version.history.length > 0 && (
        <div>
          <button
            type="button"
            className={ghostButton}
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((open) => !open)}
          >
            {t('history', { count: version.history.length })}
          </button>
          {historyOpen && (
            <ol className="mt-1 space-y-1">
              {version.history.map((snapshot) => (
                <li
                  key={snapshot.at}
                  className="rounded-lg border border-gray-200 p-2 text-xs dark:border-gray-700"
                >
                  <p className="mb-1 text-gray-600 dark:text-gray-400">
                    {new Date(snapshot.at).toLocaleString()}
                  </p>
                  <p
                    className="line-clamp-3 whitespace-pre-wrap text-gray-900 dark:text-gray-100"
                    dir="auto"
                  >
                    {snapshot.texts.join('\n\n')}
                  </p>
                  <button
                    type="button"
                    className={`${ghostButton} mt-1`}
                    onClick={() => props.onRestore(snapshot)}
                  >
                    {t('restore')}
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </>
  );

  return (
    <article
      aria-label={spec.name}
      onKeyDown={onArticleKey}
      className={`flex h-full min-h-0 flex-col border-e border-gray-200 transition-opacity duration-150 motion-reduce:transition-none dark:border-gray-700 ${
        focus ? 'min-w-0 flex-1' : 'w-[320px] shrink-0 snap-start'
      } ${usesTraced ? '' : 'opacity-50'}`}
    >
      <header
        ref={registerHeader}
        tabIndex={0}
        onKeyDown={onHeaderKey}
        className="flex items-center gap-0.5 border-b border-gray-200 px-3 py-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600 dark:border-gray-700"
      >
        <h3
          className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-900 dark:text-gray-100"
          title={spec.name}
        >
          {focus ? spec.name : shortSpecName(spec.name)}
          {segments.length > 1 && (
            <span className="ms-1 font-normal text-gray-600 dark:text-gray-400">
              {t('postCount', { count: segments.length })}
            </span>
          )}
        </h3>
        {(props.voices.length > 0 || unavailableVoice) && (
          <span className="relative">
            <button
              type="button"
              className={iconButton}
              aria-haspopup="dialog"
              aria-expanded={voiceOpen}
              aria-label={t('voice')}
              title={
                voiceName
                  ? `${t('voice')}: ${voiceName}`
                  : unavailableVoice
                    ? `${t('voice')}: ${t('voiceUnavailableOption', { id: version.toneRef?.id ?? '' })}`
                    : t('voice')
              }
              onClick={() => setVoiceOpen((open) => !open)}
            >
              <IconMicrophone
                size={14}
                aria-hidden
                className={
                  voiceName
                    ? 'text-blue-700 dark:text-blue-300'
                    : unavailableVoice
                      ? 'text-amber-700 dark:text-amber-300'
                      : ''
                }
              />
            </button>
            <Popover
              open={voiceOpen}
              onClose={() => setVoiceOpen(false)}
              placement="below-start"
              className="w-60 p-2"
            >
              <label className="block text-xs text-gray-700 dark:text-gray-300">
                {t('voice')}
                <select
                  autoFocus
                  className="mt-1 w-full rounded-md border border-gray-300 bg-gray-50 px-1.5 py-1 text-xs text-gray-900 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100"
                  value={voiceKey(version?.toneRef)}
                  onChange={(event) => {
                    const picked = props.voices.find(
                      (voice) => voiceKey(voice.ref) === event.target.value,
                    );
                    props.onVoice(picked ? picked.ref : null);
                    setVoiceOpen(false);
                  }}
                >
                  <option value="">{t('voiceNone')}</option>
                  {unavailableVoice && version.toneRef && (
                    <option value={voiceKey(version.toneRef)}>
                      {t('voiceUnavailableOption', { id: version.toneRef.id })}
                    </option>
                  )}
                  {props.voices.some((voice) => !voice.shared) && (
                    <optgroup label={t('voicesMine')}>
                      {props.voices
                        .filter((voice) => !voice.shared)
                        .map((voice) => (
                          <option
                            key={voiceKey(voice.ref)}
                            value={voiceKey(voice.ref)}
                          >
                            {voice.name}
                          </option>
                        ))}
                    </optgroup>
                  )}
                  {props.voices.some((voice) => voice.shared) && (
                    <optgroup label={t('voicesOrganisation')}>
                      {props.voices
                        .filter((voice) => voice.shared)
                        .map((voice) => (
                          <option
                            key={voiceKey(voice.ref)}
                            value={voiceKey(voice.ref)}
                          >
                            {voice.name}
                          </option>
                        ))}
                    </optgroup>
                  )}
                </select>
              </label>
              {hasText(version) && (
                <p className="mt-1 text-[11px] text-gray-600 dark:text-gray-400">
                  {t('voiceChangeHint')}
                </p>
              )}
            </Popover>
          </span>
        )}
        {!focus && (
          <>
            <button
              type="button"
              className={iconButton}
              aria-label={t('reviseChannel', { channel: spec.name })}
              title={t('reviseChannel', { channel: spec.name })}
              disabled={!hasText(version)}
              onClick={() => props.onRevise()}
            >
              <IconMessage2 size={14} aria-hidden />
            </button>
            {ui.preview && (
              <button
                type="button"
                className={iconButton}
                aria-pressed={props.previewing}
                aria-label={t('preview')}
                title={t('previewHint')}
                disabled={!hasText(version)}
                onClick={() => props.onPreviewChange(!props.previewing)}
              >
                <IconEyeCheck size={14} aria-hidden />
              </button>
            )}
            <button
              type="button"
              className={iconButton}
              aria-pressed={proofOpen}
              aria-label={t('showProof')}
              title={t('showProof')}
              onClick={() => setProofOpen((open) => !open)}
            >
              <IconListCheck size={14} aria-hidden />
            </button>
            <button
              type="button"
              className={iconButton}
              aria-label={t('focusChannel', { channel: spec.name })}
              title={t('focusChannel', { channel: spec.name })}
              onClick={props.onFocusMode}
            >
              <IconArrowsMaximize size={14} aria-hidden />
            </button>
            <span className="relative">
              <button
                type="button"
                className={iconButton}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label={t('columnMenu')}
                title={t('columnMenu')}
                onClick={() => setMenuOpen((open) => !open)}
              >
                <IconDotsVertical size={14} aria-hidden />
              </button>
              <Popover
                open={menuOpen}
                onClose={() => setMenuOpen(false)}
                placement="below-end"
              >
                <div role="menu" className="flex flex-col">
                  <button
                    type="button"
                    role="menuitem"
                    className={menuItem}
                    disabled={!props.canMoveEarlier}
                    onClick={() => {
                      setMenuOpen(false);
                      props.onMove(-1);
                    }}
                  >
                    <IconArrowLeft
                      size={14}
                      aria-hidden
                      className="rtl:-scale-x-100"
                    />
                    {t('moveEarlier')}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={menuItem}
                    disabled={!props.canMoveLater}
                    onClick={() => {
                      setMenuOpen(false);
                      props.onMove(1);
                    }}
                  >
                    <IconArrowRight
                      size={14}
                      aria-hidden
                      className="rtl:-scale-x-100"
                    />
                    {t('moveLater')}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={menuItem}
                    aria-pressed={props.pinned}
                    onClick={() => {
                      setMenuOpen(false);
                      props.onTogglePin();
                    }}
                  >
                    {props.pinned ? (
                      <IconPinFilled size={14} aria-hidden />
                    ) : (
                      <IconPin size={14} aria-hidden />
                    )}
                    {t('pinToStart')}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={menuItem}
                    onClick={() => {
                      setMenuOpen(false);
                      props.onHide();
                    }}
                  >
                    <IconEyeOff size={14} aria-hidden />
                    {t('hideChannel', { channel: spec.name })}
                  </button>
                </div>
              </Popover>
            </span>
          </>
        )}
      </header>

      <div className={`flex min-h-0 flex-1 ${focus ? 'flex-row' : 'flex-col'}`}>
        <div
          className={`min-h-0 flex-1 space-y-3 overflow-y-auto p-3 ${
            focus ? 'min-w-0' : ''
          }`}
        >
          <div className={focus ? 'mx-auto max-w-2xl space-y-3' : 'space-y-3'}>
            {props.error && (
              <div className="space-y-1 text-sm text-red-800 dark:text-red-300">
                <p className="flex items-start gap-1">
                  <IconAlertTriangle
                    size={15}
                    className="mt-0.5 shrink-0"
                    aria-hidden
                  />
                  {props.error === 'VOICE_UNAVAILABLE'
                    ? t('voiceUnavailable')
                    : t('channelFailed')}
                </p>
                <button
                  type="button"
                  className={ghostButton}
                  onClick={props.onRetry}
                >
                  {t('tryAgain')}
                </button>
              </div>
            )}
            {props.writing && !hasText(version) && (
              <div aria-busy="true" className="space-y-2">
                <span className="sr-only">{t('writing')}</span>
                {[88, 100, 72].map((width) => (
                  <div
                    key={width}
                    className="h-3 animate-pulse rounded bg-gray-200 motion-reduce:animate-none dark:bg-gray-700"
                    style={{ width: `${width}%` }}
                  />
                ))}
              </div>
            )}
            {!props.writing && !hasText(version) && !props.error && (
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {t('columnEmpty')}
              </p>
            )}

            {version?.proposed && (
              <div className="space-y-2 rounded-lg border border-gray-300 p-2 dark:border-gray-600">
                <p className="text-xs font-medium text-gray-900 dark:text-gray-100">
                  {t('proposedRewrite')}
                </p>
                <div className="text-sm leading-relaxed" dir="auto">
                  <InlineWordDiff
                    before={segments.map((s) => s.text).join('\n\n')}
                    after={version.proposed.segments
                      .map((s) => s.text)
                      .join('\n\n')}
                  />
                </div>
                <div className="flex gap-1">
                  <button
                    type="button"
                    className={ghostButton}
                    onClick={props.onKeepMine}
                  >
                    {t('keepMine')}
                  </button>
                  <button
                    type="button"
                    className={ghostButton}
                    onClick={props.onUseProposed}
                  >
                    <IconCheck size={14} aria-hidden />
                    {t('useNew')}
                  </button>
                </div>
              </div>
            )}

            {previewModel ? (
              <VersionPreview
                name={spec.name}
                segments={previewModel}
                namespace={ui.namespace}
                language={brief.language}
                onEditAt={(segmentId, offset) => {
                  // Preview is read-only: a press goes back to the editor,
                  // at the word that was pressed.
                  props.onPreviewChange(false);
                  setCaretAt(offset);
                  setEditingId(segmentId);
                }}
              />
            ) : (
              segmentList
            )}
            {!focus && details}
          </div>
        </div>

        {focus && (
          <aside
            aria-label={t('checksAndProof')}
            className="hidden min-h-0 w-96 shrink-0 space-y-3 overflow-y-auto border-s border-gray-200 p-3 lg:block dark:border-gray-700"
          >
            {details}
          </aside>
        )}
      </div>

      <footer className="space-y-1 border-t border-gray-200 px-2 py-1.5 dark:border-gray-700">
        <div className="flex items-center gap-1">
          <span
            className={`flex min-w-0 flex-1 items-center gap-1 text-xs font-medium ${STATUS_TONE[status]}`}
            title={statuses
              .map((entry) => t(`status.${entry}`, { count: blocking.length }))
              .join(' · ')}
          >
            {status === 'approved' ? (
              <IconCircleCheck size={14} aria-hidden className="shrink-0" />
            ) : status === 'ready' || status === 'empty' ? (
              <IconEye size={14} aria-hidden className="shrink-0" />
            ) : (
              <IconAlertTriangle size={14} aria-hidden className="shrink-0" />
            )}
            <span className="truncate">
              {t(`status.${status}`, { count: blocking.length })}
            </span>
            {changedSinceCopied(version) && (
              <span
                className="shrink-0 text-amber-900 dark:text-amber-300"
                title={t('changedSinceCopied')}
                aria-label={t('changedSinceCopied')}
                role="img"
              >
                <IconAlertTriangle size={12} aria-hidden />
              </span>
            )}
          </span>
          {/* Approval is an act, not a form field: a toggle button that
              reads "Approved" once it holds. */}
          <button
            type="button"
            className={`inline-flex min-h-[28px] shrink-0 items-center gap-1 rounded-lg border px-2 text-xs font-medium disabled:opacity-30 ${
              approval === 'approved'
                ? 'border-green-700 bg-green-50 text-green-900 dark:border-green-500 dark:bg-green-950/40 dark:text-green-300'
                : 'border-gray-300 text-gray-900 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-100 dark:hover:bg-surface-dark-elevated'
            }`}
            aria-pressed={approval === 'approved'}
            disabled={!hasText(version)}
            onClick={() => props.onApprove(approval !== 'approved')}
          >
            {approval === 'approved' ? (
              <IconCircleCheck size={14} aria-hidden />
            ) : (
              <IconCheck size={14} aria-hidden />
            )}
            {approval === 'approved'
              ? t('approved')
              : approval === 'changed'
                ? t('approveAgain')
                : t('approve')}
          </button>
          <button
            type="button"
            className={iconButton}
            disabled={!hasText(version)}
            aria-label={copyLabel()}
            title={copyLabel()}
            onClick={() => void copyNext()}
          >
            {copiedIndex >= 0 && !confirmCopy && copyPlan.length <= 1 ? (
              <IconCheck size={14} aria-hidden />
            ) : (
              <IconCopy size={14} aria-hidden />
            )}
            {copyPlan.length > 1 && (
              <span className="sr-only">{copyLabel()}</span>
            )}
          </button>
        </div>
        {props.send && (
          <div className="space-y-1 border-t border-gray-200 pt-2 dark:border-gray-700">
            <button
              type="button"
              className={ghostButton}
              disabled={
                props.send.sending ||
                !props.send.connected ||
                props.send.blockers.length > 0
              }
              onClick={() => {
                // Two presses: what leaves here goes out under the
                // organisation's name.
                if (!confirmSend) {
                  setConfirmSend(true);
                  return;
                }
                setConfirmSend(false);
                props.onSend?.();
              }}
              onBlur={() => setConfirmSend(false)}
            >
              <IconSend size={14} aria-hidden />
              {props.send.sending
                ? t('sending')
                : confirmSend
                  ? t('sendConfirm', { channel: spec.name })
                  : t('sendToHootsuite')}
            </button>
            {!props.send.connected ? (
              <p className="text-xs text-gray-700 dark:text-gray-300">
                {t('sendNotConnected')}
              </p>
            ) : props.send.blockers.length > 0 ? (
              <p className="text-xs text-gray-700 dark:text-gray-300">
                {t(`sendBlocker.${props.send.blockers[0]}`)}
              </p>
            ) : null}
            {version?.sent && (
              <p className="text-xs text-gray-700 dark:text-gray-300">
                {t('sentAt', {
                  time: new Date(version.sent.at).toLocaleString(),
                })}
                {changedSinceSent(version) && (
                  <span className="text-amber-900 dark:text-amber-300">
                    {' · '}
                    {t('changedSinceSent')}
                  </span>
                )}
              </p>
            )}
          </div>
        )}
      </footer>
    </article>
  );
}
