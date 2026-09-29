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
import { KeyboardEvent, MouseEvent, ReactNode, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { PublishBlocker } from '@/lib/utils/shared/drafter/core/publishing';
import { pendingEdits } from '@/lib/utils/shared/drafter/core/revisions';
import { changedRanges } from '@/lib/utils/shared/drafter/core/statements';
import { TextRange } from '@/lib/utils/shared/drafter/core/verify';
import {
  approvalStatus,
  changedSinceCopied,
  changedSinceSent,
  hasText,
} from '@/lib/utils/shared/drafter/core/versions';
import { CheckFinding } from '@/lib/utils/shared/review/deterministicChecks';

import {
  Brief,
  CitationMark,
  DRAFTER_LIMITS,
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

import { CitationChip } from './CitationChip';
import { MediaThumb } from './MediaThumb';
import { Popover, iconButton, menuItem } from './Popover';
import {
  CitationPanel,
  ProofList,
  VerifyClaim,
  citationClass,
  citationState,
  hardProblems,
  innerMarksOf,
} from './ProofList';
import { VersionPreview } from './VersionPreview';
import { SpecAdapterUi } from './adapterUi';
import { isBriefRef, refLabel, refNames, refTags } from './itemRefs';
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
  /** The hard checks: every quote and number, grounded or not. */
  marks: GroundingMark[];
  /** One per sentence: what the cite step says it rests on. */
  citations: CitationMark[];
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
  /** Runs the cite step on these sentences of one segment (or of the whole version when segmentId is null). */
  onVerify: (segmentId: string | null, claims: VerifyClaim[]) => void;
  /** The segment being cited, 'all' for a whole-column run, null when idle. */
  verifyingId: string | 'all' | null;
  verifyError?: string;
}

const ghostButton =
  'inline-flex min-h-[32px] items-center gap-1 rounded-lg px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-300 dark:hover:bg-surface-dark-elevated';

/** Resting on a sentence before its item lights up in the brief. */
const HOVER_TRACE_MS = 200;

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
  /** The sentence this run belongs to, if the cite step has one for it. */
  cite?: CitationMark;
  /** The narrowest quote or number mark containing the run. */
  inner?: GroundingMark;
  /** Inside the user's last edit, until the strip is dismissed. */
  fresh: boolean;
  overflow: boolean;
}

const contains = (range: TextRange, start: number, end: number): boolean =>
  start >= range.start && end <= range.end;

/**
 * Splits a segment into runs that render alike: cut at every sentence and
 * mark edge, at the writer's own parts of a shortened quotation, at the
 * last edit's edges and at the overflow point.
 */
function piecesOf(
  text: string,
  marks: GroundingMark[],
  citations: CitationMark[],
  overflowAt: number | null,
  fresh: TextRange[],
): Piece[] {
  const cuts = new Set<number>([0, text.length]);
  for (const mark of marks) {
    cuts.add(mark.start);
    cuts.add(mark.end);
    for (const range of [
      ...(mark.verbatim ?? []),
      ...(mark.insertions ?? []),
    ]) {
      cuts.add(range.start);
      cuts.add(range.end);
    }
  }
  for (const range of [...citations, ...fresh]) {
    cuts.add(range.start);
    cuts.add(range.end);
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
    let inner: GroundingMark | undefined;
    for (const mark of marks) {
      if (!contains(mark, start, end)) continue;
      if (!inner || mark.end - mark.start < inner.end - inner.start) {
        inner = mark;
      }
    }
    pieces.push({
      start,
      end,
      cite: citations.find((mark) => contains(mark, start, end)),
      inner,
      fresh: fresh.some((range) => range.start < end && start < range.end),
      overflow: overflowAt !== null && start >= overflowAt,
    });
  }
  return pieces;
}

/**
 * Where in the segment a press on its text landed: the caret the browser
 * placed, read back through the piece it sits in, or failing that the start
 * of the pressed piece. The editor then opens at that offset.
 */
function caretOffsetIn(
  container: HTMLElement,
  target: EventTarget | null,
): number {
  const selection =
    typeof window.getSelection === 'function' ? window.getSelection() : null;
  const anchor = selection?.anchorNode ?? null;
  if (selection && anchor && container.contains(anchor)) {
    const element = anchor instanceof Element ? anchor : anchor.parentElement;
    const piece = element?.closest<HTMLElement>('[data-start]');
    if (piece && piece.firstChild === anchor) {
      return Number(piece.dataset.start) + selection.anchorOffset;
    }
  }
  const pressed =
    target instanceof Element
      ? target.closest<HTMLElement>('[data-start]')
      : null;
  return pressed ? Number(pressed.dataset.start) : 0;
}

/** The user's last edit of a segment, kept until the text changes again. */
interface LastEdit {
  segmentId: string;
  /** Offsets into `text`. */
  ranges: TextRange[];
  text: string;
}

/** Whether an edit range touches a mark; a pure deletion is a point. */
function touches(mark: TextRange, ranges: TextRange[]): boolean {
  return ranges.some(
    (range) =>
      (range.start < mark.end && mark.start < range.end) ||
      (range.start === range.end &&
        mark.start <= range.start &&
        range.start <= mark.end),
  );
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
  const {
    spec,
    version,
    ui,
    layout,
    statuses,
    marks,
    citations,
    brief,
    tracedItemId,
  } = props;
  const t = useTranslations('workflows.drafter');
  const tKind = useTranslations(ui.namespace);
  const [editingId, setEditingId] = useState<string | null>(null);
  /** The text when the editor opened; null while no editor is open. */
  const editStartText = useRef<string | null>(null);
  const [lastEdit, setLastEdit] = useState<LastEdit | null>(null);
  /** The sentence whose popover is open: `${segmentId}:${start}`. */
  const [proofFor, setProofFor] = useState<string | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Traces after a short pause: sweeping the mouse over a post must not
   *  flicker every column; resting on a sentence should light its item. */
  const hoverTrace = (itemId: string | null) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (itemId === null) {
      hoverTimer.current = null;
      props.onTrace(null);
      return;
    }
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null;
      props.onTrace(itemId);
    }, HOVER_TRACE_MS);
  };
  /** The user's Evidence choice; null = the layout's default (on in Focus). */
  const [proofChoice, setProofChoice] = useState<boolean | null>(null);
  /** Focus below lg: whether the checks and evidence are unfolded under the text. */
  const [detailsOpen, setDetailsOpen] = useState(false);
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
  // The last edit applies only while its segment still reads as it did
  // when the editor closed; any later change drops it.
  const activeEdit =
    lastEdit &&
    segments.find((segment) => segment.id === lastEdit.segmentId)?.text ===
      lastEdit.text
      ? lastEdit
      : null;
  const approval = approvalStatus(version);
  const status = statuses[0] ?? 'empty';
  const blocking = props.findings.filter((f) => f.severity === 'block');
  // Quotes and numbers are already marked in the text and listed in the
  // evidence, so the findings list carries everything else.
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
    !tracedItemId ||
    marks.some((mark) => mark.itemId === tracedItemId) ||
    citations.some((mark) => mark.itemIds.includes(tracedItemId));
  // Evidence mode: what every sentence, quote and number rests on. On by
  // default in Focus, and the user may turn it off there too.
  const showProof = proofChoice ?? focus;
  const verifyMessage =
    props.verifyError === 'VERIFY_FAILED'
      ? t('verifyFailed')
      : props.verifyError;
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
      setProofChoice((choice) => !(choice ?? focus));
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

  /** Opens the editor on a segment, remembering the text it started from. */
  const openEditor = (segment: Segment) => {
    if (lastEdit && lastEdit.segmentId !== segment.id) setLastEdit(null);
    editStartText.current = segment.text;
    setEditingId(segment.id);
  };

  /** Closes the editor; a changed text gets the edit strip. */
  const commitEdit = (segment: Segment) => {
    const before = editStartText.current;
    editStartText.current = null;
    setEditingId(null);
    if (before !== null && segment.text !== before) {
      setLastEdit({
        segmentId: segment.id,
        ranges: changedRanges(before, segment.text),
        text: segment.text,
      });
    }
  };

  const toggleProof = (key: string) =>
    setProofFor(proofFor === key ? null : key);

  /** The control a sentence's popover or the edit strip ends with. */
  const checkControl = (segment: Segment, claims: VerifyClaim[]) => ({
    onCheck: () => props.onVerify(segment.id, claims),
    checking: props.verifyingId === segment.id,
    disabled: props.verifyingId !== null,
    error: verifyMessage,
  });

  /**
   * The one interactive element of a sentence: its chip, with the popover
   * that holds its evidence. Rendered after the sentence's last run, outside
   * the underlined text.
   */
  const chip = (segment: Segment, cite: CitationMark) => {
    const key = `${segment.id}:${cite.start}`;
    const inner = innerMarksOf(marks, cite);
    const problems = hardProblems(t, inner);
    const state = citationState(t, brief, cite);
    const label = t('citeChip', {
      state: problems ? `${state} · ${problems}` : state,
    });
    const firstItem = cite.itemIds.find((id) => !isBriefRef(id)) ?? null;
    return (
      <CitationChip
        key={`chip:${key}`}
        tag={refTags(t, brief, cite.itemIds)}
        verdict={cite.verdict}
        label={label}
        open={proofFor === key}
        onToggle={() => toggleProof(key)}
        onClose={() => setProofFor(null)}
        onTrace={(on) => props.onTrace(on ? firstItem : null)}
      >
        <CitationPanel
          mark={cite}
          segmentText={segment.text}
          marks={marks}
          brief={brief}
          sources={props.sources}
          version={version}
          showSentence
          check={
            cite.note === 'ungrounded-inside'
              ? undefined
              : checkControl(segment, [
                  {
                    segmentId: segment.id,
                    text: segment.text.slice(cite.start, cite.end),
                  },
                ])
          }
        />
      </CitationChip>
    );
  };

  /**
   * The post's text as plain runs: sentence underlines for their verdicts,
   * quotes and numbers dotted (amber when the brief lacks them), the
   * writer's own parts of a shortened quotation greyed. Nothing here is a
   * control, so a press anywhere opens the editor at that spot.
   */
  const renderText = (
    segment: Segment,
    overflowAt: number | null,
    fresh: TextRange[],
  ) => {
    const segmentMarks = marks.filter((m) => m.segmentId === segment.id);
    const segmentCites = citations.filter((m) => m.segmentId === segment.id);
    const nodes: ReactNode[] = [];
    for (const piece of piecesOf(
      segment.text,
      segmentMarks,
      segmentCites,
      overflowAt,
      fresh,
    )) {
      const content = segment.text.slice(piece.start, piece.end);
      const overflowClass = piece.overflow
        ? 'bg-amber-100 dark:bg-amber-900/40'
        : '';
      const key = `${piece.start}-${piece.end}`;
      const { cite, inner } = piece;
      const freshClass = piece.fresh ? 'bg-blue-50 dark:bg-blue-950/30' : '';
      const unsupported = cite?.verdict === 'unsupported';

      if (inner) {
        const grounded = inner.itemId !== undefined;
        const traced = grounded && inner.itemId === tracedItemId;
        const item = inner.itemId ? itemsById.get(inner.itemId) : undefined;
        // In a shortened quotation, the … and [bracketed] parts are the
        // writer's, not the speaker's, and read as such.
        const writersWords =
          !!inner.elided &&
          ((inner.insertions ?? []).some((range) =>
            contains(range, piece.start, piece.end),
          ) ||
            !(inner.verbatim ?? []).some((range) =>
              contains(range, piece.start, piece.end),
            ));
        const background = !grounded
          ? 'bg-amber-100 decoration-amber-700 dark:bg-amber-900/40'
          : traced
            ? 'bg-blue-100 decoration-gray-500 dark:bg-blue-900/60'
            : unsupported
              ? 'bg-amber-50 decoration-gray-500 dark:bg-amber-900/30'
              : `decoration-gray-500 ${freshClass}`;
        nodes.push(
          <span
            key={key}
            data-start={piece.start}
            className={`rounded-sm underline decoration-dotted underline-offset-4 ${overflowClass} ${background} ${
              writersWords ? 'text-gray-700 dark:text-gray-400' : ''
            }`}
            title={
              inner.elided && item
                ? `${t('quoteFull')}: ${item.text.slice(0, 240)}`
                : !grounded
                  ? inner.kind === 'quote'
                    ? t('quoteNotInBrief')
                    : t('numberNotInBrief')
                  : undefined
            }
          >
            {content}
          </span>,
        );
      } else if (cite) {
        // A supported sentence is plain text until evidence mode, but it
        // LIGHTS UP whenever its brief item is traced (from the brief pane
        // or from another sentence), and hovering it traces its item back:
        // a fact or context item shows what rests on it as readily as a
        // quote does. An unsupported one always shows.
        const tracedHere =
          !!tracedItemId && cite.itemIds.includes(tracedItemId);
        const background = tracedHere
          ? 'bg-blue-100 dark:bg-blue-900/60'
          : unsupported
            ? ''
            : freshClass;
        const firstItem = cite.itemIds.find((id) => !isBriefRef(id)) ?? null;
        nodes.push(
          <span
            key={key}
            data-start={piece.start}
            className={`rounded-sm ${citationClass(cite.verdict, showProof)} ${overflowClass} ${background}`}
            onMouseEnter={firstItem ? () => hoverTrace(firstItem) : undefined}
            onMouseLeave={firstItem ? () => hoverTrace(null) : undefined}
          >
            {content}
          </span>,
        );
      } else {
        nodes.push(
          <span
            key={key}
            data-start={piece.start}
            className={`${overflowClass} ${freshClass}`}
          >
            {content}
          </span>,
        );
      }

      if (cite && piece.end === cite.end) {
        if (showProof) {
          nodes.push(chip(segment, cite));
        } else if (unsupported) {
          // No chip outside evidence mode: the state is still announced,
          // once per sentence.
          nodes.push(
            <span key={`said:${key}`} className="sr-only">
              {`, ${citationState(t, brief, cite)}`}
            </span>,
          );
        }
      }
    }
    return nodes;
  };

  /**
   * After an edit: what the changed sentences rest on now, with a way to
   * ask the model again and a way to dismiss. Never while the editor is
   * open, and never when the edit touched no sentence and no mark.
   */
  const editStrip = (segment: Segment) => {
    if (
      !activeEdit ||
      activeEdit.segmentId !== segment.id ||
      editingId === segment.id
    ) {
      return null;
    }
    const sentences = citations.filter(
      (m) => m.segmentId === segment.id && touches(m, activeEdit.ranges),
    );
    const inners = marks.filter(
      (m) => m.segmentId === segment.id && touches(m, activeEdit.ranges),
    );
    if (sentences.length === 0 && inners.length === 0) return null;
    const textOf = (m: TextRange) => segment.text.slice(m.start, m.end);
    const verdicts = new Set(sentences.map((m) => m.verdict));
    const hard = inners.some((m) => m.itemId === undefined);
    const itemIds = [
      ...new Set([
        ...sentences.flatMap((m) => m.itemIds),
        ...inners.flatMap((m) => (m.itemId !== undefined ? [m.itemId] : [])),
      ]),
    ];
    const items = refNames(t, brief, itemIds);
    const claims: VerifyClaim[] = sentences
      .filter((m) => m.note !== 'ungrounded-inside')
      .map((m) => ({ segmentId: segment.id, text: textOf(m) }))
      .slice(0, DRAFTER_LIMITS.MAX_VERIFY_CLAIMS);
    const checking = props.verifyingId === segment.id;
    const amber = 'text-amber-900 dark:text-amber-300';
    const line = hard ? (
      <span className={`inline-flex items-center gap-1 ${amber}`}>
        <IconAlertTriangle size={14} className="shrink-0" aria-hidden />
        {t('editHardProblem')}
      </span>
    ) : verdicts.has('unsupported') ? (
      <span className={`inline-flex items-center gap-1 ${amber}`}>
        <IconAlertTriangle size={14} className="shrink-0" aria-hidden />
        {t('editUnsupported')}
      </span>
    ) : verdicts.has('pending') ? (
      <span className="inline-flex items-center gap-1 text-gray-800 dark:text-gray-200">
        <IconSparkles size={14} className="shrink-0" aria-hidden />
        {t('editChecking')}
      </span>
    ) : verdicts.has('partly') ? (
      <span className={`inline-flex items-center gap-1 ${amber}`}>
        <IconInfoCircle size={14} className="shrink-0" aria-hidden />
        {t('editPartlyCite')}
      </span>
    ) : verdicts.has('unclear') || verdicts.has('stale') ? (
      <span className="inline-flex items-center gap-1 text-gray-800 dark:text-gray-200">
        <IconInfoCircle size={14} className="shrink-0" aria-hidden />
        {t('editUnchecked')}
      </span>
    ) : (
      <span className="inline-flex items-center gap-1 text-gray-800 dark:text-gray-200">
        <IconCircleCheck size={14} className="shrink-0" aria-hidden />
        {t('editSupported', { items })}
      </span>
    );
    return (
      <div className="space-y-1">
        <p
          role="status"
          className="mt-1 flex flex-wrap items-center gap-x-2 text-xs"
        >
          {line}
          {claims.length > 0 && (
            <button
              type="button"
              className={ghostButton}
              disabled={props.verifyingId !== null}
              aria-busy={checking || undefined}
              title={
                props.verifyingId !== null && !checking
                  ? t('checkRunning')
                  : t('citeExplainer')
              }
              onClick={() => props.onVerify(segment.id, claims)}
            >
              <IconSparkles size={14} aria-hidden />
              {checking ? t('checkingWithAi') : t('checkWithAi')}
            </button>
          )}
          <button
            type="button"
            className={ghostButton}
            onClick={() => setLastEdit(null)}
          >
            {t('dismiss')}
          </button>
          {verifyMessage && (
            <span className="text-amber-900 dark:text-amber-300">
              {verifyMessage}
            </span>
          )}
        </p>
        {sentences
          .filter((m) => m.reason)
          .map((m) => (
            <p
              key={`${m.start}-${m.end}`}
              className="flex items-start gap-1 text-xs text-gray-800 dark:text-gray-200"
            >
              <IconSparkles size={14} className="mt-0.5 shrink-0" aria-hidden />
              <span dir="auto">{t('aiSays', { reason: m.reason ?? '' })}</span>
            </p>
          ))}
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
          <span className="flex items-center gap-1">
            {/* The keyboard's way into the editor; the mouse presses the
                text itself. Visible only while focused. */}
            <button
              type="button"
              className={`${ghostButton} sr-only focus:not-sr-only`}
              onClick={() => {
                setCaretAt(0);
                openEditor(segment);
              }}
            >
              {t('editPost', { n: index + 1 })}
            </button>
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
            onBlur={() => commitEdit(segment)}
            onKeyDown={(event) => {
              const target = event.currentTarget;
              event.stopPropagation();
              if (event.key === 'Escape') commitEdit(segment);
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                props.onSplit(segment.id, target.selectionStart);
                commitEdit(segment);
              }
              if (
                event.key === 'Backspace' &&
                index > 0 &&
                target.selectionStart === 0 &&
                target.selectionEnd === 0
              ) {
                event.preventDefault();
                props.onMerge(segment.id);
                commitEdit(segment);
              }
            }}
          />
        ) : (
          // Text, not a control: the chips inside it are the buttons, and a
          // press on the words opens the editor where they were pressed.
          <div
            lang={brief.language || undefined}
            dir="auto"
            className="cursor-text whitespace-pre-wrap break-words rounded-lg px-2 py-1.5 text-sm leading-relaxed text-gray-900 hover:bg-gray-50 dark:text-gray-100 dark:hover:bg-surface-dark-elevated"
            onClick={(event: MouseEvent<HTMLDivElement>) => {
              setCaretAt(caretOffsetIn(event.currentTarget, event.target));
              openEditor(segment);
            }}
          >
            {renderText(
              segment,
              meta?.overflowAt ?? null,
              activeEdit?.segmentId === segment.id ? activeEdit.ranges : [],
            )}
          </div>
        )}
        {editStrip(segment)}
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
          citations={citations}
          segments={segments}
          brief={brief}
          sources={props.sources}
          version={version}
          verifyingId={props.verifyingId}
          error={verifyMessage}
          onVerify={(claims) => props.onVerify(null, claims)}
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
          </>
        )}
        <button
          type="button"
          className={iconButton}
          aria-pressed={showProof}
          aria-label={t('showProof')}
          title={t('showProofHint')}
          onClick={() => setProofChoice(!showProof)}
        >
          <IconListCheck size={14} aria-hidden />
        </button>
        {!focus && (
          <>
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

      <div
        className={`flex min-h-0 flex-1 ${focus ? 'flex-col lg:flex-row' : 'flex-col'}`}
      >
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
                  const segment = segments.find((s) => s.id === segmentId);
                  if (segment) openEditor(segment);
                }}
              />
            ) : (
              segmentList
            )}
            {!focus && details}
          </div>
        </div>

        {focus && (
          // Beside the text from lg up; below it, folded, on narrower
          // screens, so evidence mode never shows marks with nowhere to
          // read them.
          <aside
            aria-label={t('checksAndProof')}
            className="min-h-0 shrink-0 overflow-y-auto border-t border-gray-200 lg:w-96 lg:border-s lg:border-t-0 dark:border-gray-700"
          >
            <button
              type="button"
              className={`${ghostButton} m-2 lg:hidden`}
              aria-expanded={detailsOpen}
              onClick={() => setDetailsOpen((open) => !open)}
            >
              {t('checksAndProof')}
            </button>
            <div
              className={`space-y-3 p-3 ${detailsOpen ? '' : 'hidden lg:block'}`}
            >
              {details}
            </div>
          </aside>
        )}
      </div>

      <footer className="space-y-1 border-t border-gray-200 px-2 py-1.5 dark:border-gray-700">
        {hasText(version) && citations.length > 0 && (
          // What the citation step found, always in view: a press opens
          // evidence mode. Errors show here too, not only in that mode.
          <div className="flex items-center gap-2 text-xs">
            <button
              type="button"
              className="min-w-0 truncate text-start text-gray-600 hover:underline dark:text-gray-400"
              aria-pressed={showProof}
              onClick={() => setProofChoice(!showProof)}
            >
              {props.verifyingId
                ? t('citing')
                : t('citeSummary', {
                    traced: citations.filter(
                      (m) =>
                        m.verdict === 'supported' || m.verdict === 'partly',
                    ).length,
                    total: citations.length,
                    unsupported: citations.filter(
                      (m) => m.verdict === 'unsupported',
                    ).length,
                  })}
            </button>
            {verifyMessage && !showProof && (
              <span
                role="status"
                className="min-w-0 truncate text-amber-900 dark:text-amber-300"
                title={verifyMessage}
              >
                {verifyMessage}
              </span>
            )}
          </div>
        )}
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
