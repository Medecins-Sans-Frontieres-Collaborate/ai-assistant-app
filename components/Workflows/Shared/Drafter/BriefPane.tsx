'use client';

import {
  IconAlertTriangle,
  IconArrowDown,
  IconArrowUp,
  IconChevronDown,
  IconChevronRight,
  IconCircleCheck,
  IconDotsVertical,
  IconExternalLink,
  IconFileText,
  IconHash,
  IconInfoCircle,
  IconKeyboard,
  IconLoader,
  IconMessage,
  IconPlus,
  IconQuote,
  IconSparkles,
  IconTrash,
  IconUserCheck,
} from '@tabler/icons-react';
import { KeyboardEvent, ReactNode, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  briefCounts,
  briefLink,
  canInclude,
  countIncludable,
  isHttpUrl,
} from '@/lib/utils/shared/drafter/core/brief';
import { sourceLinkFor } from '@/lib/utils/shared/drafter/core/textFragment';

import { Brief, BriefItem, DraftSource } from '@/types/drafter';

import { Popover, iconButton } from './Popover';
import { ProofCard } from './ProofCard';
import { shortSpecName } from './specNames';

export interface BriefPaneProps {
  /** Rendered above the fields: the sources strip. */
  header?: ReactNode;
  brief: Brief;
  sources: DraftSource[];
  /** Names of the specs whose versions use an item, keyed by item id. */
  usedIn: Record<string, string[]>;
  hasVersions: boolean;
  /** Versions whose brief inputs changed; drives the primary action. */
  staleCount: number;
  extracting: boolean;
  writing: boolean;
  /** Writing is paused (the draft's rule set is gone): the button is off. */
  paused?: boolean;
  tracedItemId: string | null;
  onTrace: (itemId: string | null) => void;
  /**
   * The one web page the draft is based on, when there is exactly one (or
   * the page whose link is already included, so it can be turned off).
   */
  articleSource?: { name: string; url: string };
  /** The donation address remembered in settings; never turns the ask on. */
  rememberedDonationUrl: string;
  onArticleLink: (include: boolean) => void;
  /** `url` null = stop asking for donations. */
  onDonationLink: (url: string | null) => void;
  onKeyMessage: (text: string) => void;
  onCallToAction: (text: string) => void;
  onDecision: (itemId: string, decision: BriefItem['decision']) => void;
  onVouch: (itemId: string) => void;
  onEditText: (itemId: string, text: string) => void;
  onMove: (itemId: string, delta: -1 | 1) => void;
  onRemove: (itemId: string) => void;
  onAddOwn: (text: string) => void;
  /**
   * Opens the source viewer: on a source to pick words from, or, with an
   * item id, to find the passage that proves a "Not found" item.
   */
  onOpenSource: (sourceId?: string, itemId?: string) => void;
  /** Includes every found-in-source item, then writes or updates. */
  onPrimary: () => void;
}

const fieldClass =
  'w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-900 placeholder-gray-500 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100 dark:placeholder-gray-400';
const ghostButton =
  'inline-flex min-h-[32px] items-center gap-1 rounded-lg px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-300 dark:hover:bg-surface-dark-elevated';

const KIND_ICONS: Record<BriefItem['kind'], typeof IconQuote> = {
  quote: IconQuote,
  testimony: IconMessage,
  fact: IconFileText,
  figure: IconHash,
  context: IconInfoCircle,
};

/** The kind as one small icon; the word is its tooltip and its label. */
function KindMark({ kind, label }: { kind: BriefItem['kind']; label: string }) {
  const Icon = KIND_ICONS[kind];
  return (
    <span
      className="inline-flex text-gray-600 dark:text-gray-400"
      title={label}
      aria-label={label}
      role="img"
    >
      <Icon size={14} aria-hidden />
    </span>
  );
}

/**
 * Verification as an icon. "Found in source" is the normal state, so it is
 * a tick with the words in a tooltip; the state that needs the user is the
 * one spelled out.
 */
function VerificationIcon({
  verified,
  labels,
}: {
  verified: BriefItem['verified'];
  labels: { verbatim: string; vouched: string; notFound: string };
}) {
  if (verified === 'verbatim') {
    return (
      <span
        className="inline-flex text-green-800 dark:text-green-300"
        title={labels.verbatim}
        aria-label={labels.verbatim}
        role="img"
      >
        <IconCircleCheck size={14} aria-hidden />
      </span>
    );
  }
  if (verified === 'user-asserted') {
    return (
      <span
        className="inline-flex text-gray-700 dark:text-gray-300"
        title={labels.vouched}
        aria-label={labels.vouched}
        role="img"
      >
        <IconUserCheck size={14} aria-hidden />
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-amber-900 dark:text-amber-300">
      <IconAlertTriangle size={14} aria-hidden />
      {labels.notFound}
    </span>
  );
}

/** A small tooltip-carrying info icon beside a short label. */
function InfoTip({ text }: { text: string }) {
  return (
    <span
      className="inline-flex text-gray-500 dark:text-gray-400"
      title={text}
      aria-label={text}
      role="img"
    >
      <IconInfoCircle size={14} aria-hidden />
    </span>
  );
}

type Filter = 'all' | 'needsYou' | 'unused';

/**
 * The brief as a triage list: one row is one decision. Reviewed once here,
 * every version is then checked against it by code.
 *
 * Laid out for the space it has: the fields collapse to one summary line
 * once the posts are written, each item is one line until it is selected,
 * and every explanation lives in a tooltip rather than on the page.
 */
export function BriefPane(props: BriefPaneProps) {
  const {
    brief,
    sources,
    usedIn,
    hasVersions,
    staleCount,
    extracting,
    writing,
    tracedItemId,
    onTrace,
  } = props;
  const t = useTranslations('workflows.drafter');
  const [openId, setOpenId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [ownDraft, setOwnDraft] = useState('');
  const article = briefLink(brief, 'article');
  const donation = briefLink(brief, 'donation');
  // The ask can be switched on before a valid address exists; it only
  // reaches the brief (and so the posts) once the address is a web URL.
  const [donationOpen, setDonationOpen] = useState(false);
  const [donationDraft, setDonationDraft] = useState<string | null>(null);
  const donationOn = !!donation || donationOpen;
  const donationValue =
    donationDraft ?? donation?.url ?? props.rememberedDonationUrl;
  const donationInvalid =
    donationOn && donationValue.trim() !== '' && !isHttpUrl(donationValue);
  const rowRefs = useRef<Record<string, HTMLLIElement | null>>({});
  // Per-pane UI only, never workflow state: which card is expanded, whether
  // the fields are folded, the list filter, and which menus are open.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [fieldsFolded, setFieldsFolded] = useState<boolean | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [menuId, setMenuId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [ownOpen, setOwnOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const counts = briefCounts(brief);
  const includable = countIncludable(brief);
  // Folded once the posts exist, unless the user chose otherwise: that is
  // when the fields are done and the columns want the room.
  const folded = fieldsFolded ?? hasVersions;
  const goodSources = sources.filter((source) => !source.error);
  // With one source, naming it on every card only repeats the title.
  const showSourceNames = goodSources.length > 1;
  const unusedIds = new Set(
    brief.items
      .filter(
        (item) =>
          hasVersions &&
          item.decision === 'included' &&
          (usedIn[item.id] ?? []).length === 0,
      )
      .map((item) => item.id),
  );
  const needsYouIds = new Set(
    brief.items
      .filter((item) => item.verified === 'unverified')
      .map((item) => item.id),
  );
  const visibleItems = brief.items.filter((item) =>
    filter === 'needsYou'
      ? needsYouIds.has(item.id)
      : filter === 'unused'
        ? unusedIds.has(item.id)
        : true,
  );

  const focusRow = (index: number) => {
    const item = visibleItems[index];
    if (item) rowRefs.current[item.id]?.focus();
  };

  const startEdit = (item: BriefItem) => {
    setEditingId(item.id);
    setDraft(item.text);
  };

  const commitEdit = (item: BriefItem) => {
    const text = draft.trim();
    if (text && text !== item.text) props.onEditText(item.id, text);
    setEditingId(null);
  };

  /** Keyboard triage: the row is the unit, not the controls inside it. */
  const onRowKey = (
    event: KeyboardEvent<HTMLLIElement>,
    item: BriefItem,
    index: number,
  ) => {
    if (event.target !== event.currentTarget) return;
    switch (event.key) {
      case 'j':
      case 'ArrowDown':
        event.preventDefault();
        focusRow(index + 1);
        break;
      case 'k':
      case 'ArrowUp':
        event.preventDefault();
        focusRow(index - 1);
        break;
      case ' ':
        event.preventDefault();
        if (canInclude(item)) {
          props.onDecision(
            item.id,
            item.decision === 'included' ? 'excluded' : 'included',
          );
        }
        break;
      case 's':
        setExpandedId(item.id);
        setOpenId(openId === item.id ? null : item.id);
        break;
      case 'e':
        event.preventDefault();
        setExpandedId(item.id);
        startEdit(item);
        break;
      case 'Enter':
        event.preventDefault();
        setExpandedId(expandedId === item.id ? null : item.id);
        break;
      case 'v':
        if (item.verified === 'unverified') props.onVouch(item.id);
        break;
      default:
    }
  };

  const primaryLabel = hasVersions
    ? staleCount > 0
      ? t('updateChannels', { count: staleCount })
      : t('writeAgain')
    : includable > 0
      ? t('includeAndWrite', { count: includable })
      : t('writePosts');
  const primaryDisabled =
    writing ||
    extracting ||
    !!props.paused ||
    (counts.included === 0 && includable === 0);

  const fieldsSummary = [
    brief.keyMessage.trim() ? t('summaryKeyMessage') : null,
    brief.callToAction?.trim() ? t('summaryCallToAction') : null,
    article ? t('summaryPageLink') : null,
    donation ? t('summaryDonationLink') : null,
  ].filter((part): part is string => !!part);

  const shortcutRows: Array<[string, string]> = [
    ['J / K', t('shortcutMove')],
    ['Space', t('shortcutInclude')],
    ['Enter', t('shortcutExpand')],
    ['S', t('shortcutSource')],
    ['E', t('shortcutEdit')],
    ['V', t('shortcutVouch')],
  ];

  const filterChip = (value: Filter, label: string, count: number) => (
    <button
      type="button"
      className={`min-h-[28px] rounded-full px-2 text-xs ${
        filter === value
          ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
          : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-surface-dark-elevated'
      } ${value !== 'all' && count === 0 ? 'hidden' : ''}`}
      aria-pressed={filter === value}
      onClick={() => setFilter(value)}
    >
      {label} {count}
    </button>
  );

  return (
    <section aria-label={t('brief')} className="flex h-full min-h-0 flex-col">
      {props.header}
      <div className="border-b border-gray-200 dark:border-gray-700">
        <button
          type="button"
          className="flex min-h-[36px] w-full items-center gap-1 px-3 py-1.5 text-start text-xs font-medium text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-surface-dark-elevated"
          aria-expanded={!folded}
          onClick={() => setFieldsFolded(!folded)}
        >
          {folded ? (
            <IconChevronRight
              size={14}
              aria-hidden
              className="shrink-0 rtl:rotate-180"
            />
          ) : (
            <IconChevronDown size={14} aria-hidden className="shrink-0" />
          )}
          <span className="shrink-0">{t('briefDetails')}</span>
          {folded && (
            <span className="min-w-0 truncate font-normal text-gray-600 dark:text-gray-400">
              {fieldsSummary.length > 0
                ? fieldsSummary.join(' · ')
                : t('summaryEmpty')}
            </span>
          )}
        </button>
        {!folded && (
          <div className="space-y-2 px-3 pb-3">
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
              {t('keyMessage')}
              <textarea
                className={`${fieldClass} mt-1 resize-none`}
                rows={Math.min(
                  4,
                  Math.max(
                    2,
                    brief.keyMessage.split('\n').length +
                      Math.floor(brief.keyMessage.length / 48),
                  ),
                )}
                dir="auto"
                value={brief.keyMessage}
                placeholder={t('keyMessagePlaceholder')}
                onChange={(event) => props.onKeyMessage(event.target.value)}
              />
            </label>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
              {t('callToAction')}
              <input
                className={`${fieldClass} mt-1`}
                dir="auto"
                value={brief.callToAction ?? ''}
                placeholder={t('callToActionPlaceholder')}
                onChange={(event) => props.onCallToAction(event.target.value)}
              />
            </label>

            {/* min-w-0: a fieldset's default min-inline-size is min-content,
                which let a long nowrap title push it out of the pane. */}
            <fieldset className="min-w-0 space-y-1">
              <legend className="text-xs font-medium text-gray-700 dark:text-gray-300">
                {t('links')}
              </legend>
              {props.articleSource && (
                <label className="flex min-w-0 items-center gap-2 text-sm text-gray-900 dark:text-gray-100">
                  <input
                    type="checkbox"
                    className="h-4 w-4 shrink-0 accent-blue-600"
                    checked={!!article}
                    onChange={(event) =>
                      props.onArticleLink(event.target.checked)
                    }
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {t('pageLink')}
                  </span>
                  <InfoTip
                    text={`${props.articleSource.name}\n${t('linksPlacementHint')}`}
                  />
                </label>
              )}
              <label className="flex min-w-0 items-center gap-2 text-sm text-gray-900 dark:text-gray-100">
                <input
                  type="checkbox"
                  className="h-4 w-4 shrink-0 accent-blue-600"
                  checked={donationOn}
                  onChange={(event) => {
                    const on = event.target.checked;
                    setDonationOpen(on);
                    if (!on) {
                      setDonationDraft(null);
                      props.onDonationLink(null);
                    } else if (isHttpUrl(donationValue)) {
                      props.onDonationLink(donationValue);
                    }
                  }}
                />
                <span className="min-w-0 flex-1 truncate">
                  {t('donationLink')}
                </span>
                <InfoTip
                  text={
                    donationOn ? t('donationsOnHint') : t('donationsOffHint')
                  }
                />
              </label>
              {donationOn && (
                <div className="ps-6">
                  <input
                    type="url"
                    inputMode="url"
                    className={fieldClass}
                    aria-label={t('donationUrl')}
                    aria-invalid={donationInvalid}
                    placeholder={t('donationUrlPlaceholder')}
                    value={donationValue}
                    onChange={(event) => setDonationDraft(event.target.value)}
                    onBlur={() => {
                      if (isHttpUrl(donationValue)) {
                        props.onDonationLink(donationValue);
                      } else if (donation) {
                        // An address that stopped being valid is not published.
                        props.onDonationLink(null);
                        setDonationOpen(true);
                      }
                    }}
                  />
                  {donationInvalid && (
                    <p className="mt-1 text-xs text-red-800 dark:text-red-300">
                      {t('donationUrlInvalid')}
                    </p>
                  )}
                </div>
              )}
            </fieldset>
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 px-2 py-1.5">
        {filterChip('all', t('filterAll'), brief.items.length)}
        {filterChip('needsYou', t('filterNeedsYou'), needsYouIds.size)}
        {filterChip('unused', t('filterUnused'), unusedIds.size)}
        <span className="relative ms-auto">
          <button
            type="button"
            className={iconButton}
            aria-label={t('shortcuts')}
            title={t('shortcuts')}
            aria-expanded={shortcutsOpen}
            onClick={() => setShortcutsOpen((open) => !open)}
          >
            <IconKeyboard size={16} aria-hidden />
          </button>
          <Popover
            open={shortcutsOpen}
            onClose={() => setShortcutsOpen(false)}
            placement="below-end"
          >
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 p-1 text-xs">
              {shortcutRows.map(([key, label]) => (
                <div key={key} className="contents">
                  <dt>
                    <kbd className="rounded border border-gray-300 px-1 font-mono dark:border-gray-600">
                      {key}
                    </kbd>
                  </dt>
                  <dd className="text-gray-700 dark:text-gray-300">{label}</dd>
                </div>
              ))}
            </dl>
          </Popover>
        </span>
      </div>

      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
        {brief.items.length === 0 && !extracting && (
          <li className="px-1 py-6 text-sm text-gray-700 dark:text-gray-300">
            {t('briefEmpty')}
          </li>
        )}
        {brief.items.length > 0 && visibleItems.length === 0 && (
          <li className="px-1 py-4 text-xs text-gray-600 dark:text-gray-400">
            {t('filterEmpty')}
          </li>
        )}
        {visibleItems.map((item, index) => {
          const expanded = expandedId === item.id;
          const open = expanded && openId === item.id;
          const provenance = item.provenance[0];
          const source = provenance
            ? sources.find((entry) => entry.id === provenance.sourceId)
            : undefined;
          const link =
            source && provenance
              ? sourceLinkFor(source, provenance.excerpt)
              : null;
          const used = usedIn[item.id] ?? [];
          const spoken = item.kind === 'quote' || item.kind === 'testimony';
          const shownText = spoken ? `“${item.text}”` : item.text;
          const position = brief.items.indexOf(item);
          const verificationLabels = {
            verbatim: t('foundInSource'),
            vouched: t('youVouched'),
            notFound: t('notFoundInSource'),
          };
          return (
            <li
              key={item.id}
              ref={(node) => {
                rowRefs.current[item.id] = node;
              }}
              tabIndex={0}
              aria-expanded={expanded}
              onKeyDown={(event) => onRowKey(event, item, index)}
              onMouseEnter={() => onTrace(item.id)}
              onMouseLeave={() => onTrace(null)}
              onFocus={() => onTrace(item.id)}
              onBlur={() => onTrace(null)}
              className={`group rounded-lg border p-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
                tracedItemId === item.id
                  ? 'border-blue-300 bg-blue-50 dark:border-blue-700 dark:bg-blue-950/40'
                  : expanded
                    ? 'border-gray-300 dark:border-gray-600'
                    : 'border-transparent hover:border-gray-200 dark:hover:border-gray-700'
              }`}
            >
              <div className="flex items-start gap-1.5">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 shrink-0 accent-blue-600"
                  checked={item.decision === 'included'}
                  disabled={!canInclude(item)}
                  aria-label={t('includeItem')}
                  onChange={(event) =>
                    props.onDecision(
                      item.id,
                      event.target.checked ? 'included' : 'excluded',
                    )
                  }
                />
                <div className="min-w-0 flex-1">
                  {/* The one line every card shows: kind, verification,
                      the words, and what needs attention. */}
                  <div
                    className="flex min-w-0 cursor-pointer items-start gap-1.5"
                    onClick={() => setExpandedId(expanded ? null : item.id)}
                  >
                    <span className="mt-0.5 flex shrink-0 items-center gap-1">
                      <KindMark
                        kind={item.kind}
                        label={t(`kinds.${item.kind}`)}
                      />
                      <VerificationIcon
                        verified={item.verified}
                        labels={verificationLabels}
                      />
                    </span>
                    {editingId === item.id ? (
                      <textarea
                        autoFocus
                        className={`${fieldClass} resize-none`}
                        rows={3}
                        dir="auto"
                        value={draft}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => setDraft(event.target.value)}
                        onBlur={() => commitEdit(item)}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') setEditingId(null);
                          if (event.key === 'Enter' && !event.shiftKey) {
                            event.preventDefault();
                            commitEdit(item);
                          }
                        }}
                      />
                    ) : (
                      <p
                        className={`min-w-0 flex-1 text-sm leading-snug text-gray-900 dark:text-gray-100 ${
                          expanded ? '' : 'truncate'
                        }`}
                        dir="auto"
                        onDoubleClick={(event) => {
                          event.stopPropagation();
                          startEdit(item);
                        }}
                      >
                        {shownText}
                      </p>
                    )}
                    {!expanded && unusedIds.has(item.id) && (
                      <span
                        className="mt-0.5 shrink-0 text-xs text-amber-900 dark:text-amber-300"
                        title={t('notUsed')}
                      >
                        {t('notUsedShort')}
                      </span>
                    )}
                  </div>

                  {expanded && (
                    <div className="mt-1 space-y-1">
                      {(item.attribution || link || showSourceNames) && (
                        <p className="flex min-w-0 items-center gap-1 text-xs text-gray-700 dark:text-gray-300">
                          <span className="min-w-0 truncate">
                            {item.attribution
                              ? `${item.attribution.name}${
                                  item.attribution.role
                                    ? `, ${item.attribution.role}`
                                    : ''
                                }`
                              : showSourceNames && source
                                ? source.name
                                : ''}
                          </span>
                          {showSourceNames && item.attribution && source && (
                            <span className="min-w-0 truncate text-gray-600 dark:text-gray-400">
                              · {source.name}
                            </span>
                          )}
                          {link && (
                            <a
                              href={link.href}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={`${iconButton} ms-auto`}
                              aria-label={t('openSource')}
                              title={t('openSource')}
                            >
                              <IconExternalLink size={14} aria-hidden />
                            </a>
                          )}
                        </p>
                      )}
                      {item.verified === 'unverified' && (
                        <p className="text-xs text-amber-900 dark:text-amber-300">
                          {t('notFoundHelper')}
                        </p>
                      )}
                      <div className="flex flex-wrap items-center gap-1">
                        {source && (
                          <button
                            type="button"
                            className={ghostButton}
                            aria-expanded={open}
                            onClick={() => setOpenId(open ? null : item.id)}
                          >
                            {open ? (
                              <IconChevronDown size={14} aria-hidden />
                            ) : (
                              <IconChevronRight
                                size={14}
                                aria-hidden
                                className="rtl:rotate-180"
                              />
                            )}
                            {t('showProof')}
                          </button>
                        )}
                        {item.verified === 'unverified' && (
                          <>
                            <button
                              type="button"
                              className={ghostButton}
                              disabled={sources.length === 0}
                              onClick={() =>
                                props.onOpenSource(undefined, item.id)
                              }
                            >
                              {t('findInSource')}
                            </button>
                            <button
                              type="button"
                              className={ghostButton}
                              onClick={() => props.onVouch(item.id)}
                            >
                              {t('vouch')}
                            </button>
                          </>
                        )}
                        {hasVersions && item.decision === 'included' && (
                          <span className="flex flex-wrap items-center gap-0.5">
                            {used.length > 0 ? (
                              used.map((name) => (
                                <span
                                  key={name}
                                  className="rounded bg-gray-100 px-1 text-[11px] text-gray-700 dark:bg-surface-dark-elevated dark:text-gray-300"
                                  title={t('usedIn', { channels: name })}
                                >
                                  {shortSpecName(name)}
                                </span>
                              ))
                            ) : (
                              <span className="text-xs text-amber-900 dark:text-amber-300">
                                {t('notUsed')}
                              </span>
                            )}
                          </span>
                        )}
                        <span className="relative ms-auto">
                          <button
                            type="button"
                            className={iconButton}
                            aria-label={t('itemActions')}
                            title={t('itemActions')}
                            aria-haspopup="menu"
                            aria-expanded={menuId === item.id}
                            onClick={() =>
                              setMenuId(menuId === item.id ? null : item.id)
                            }
                          >
                            <IconDotsVertical size={14} aria-hidden />
                          </button>
                          <Popover
                            open={menuId === item.id}
                            onClose={() => setMenuId(null)}
                            placement="below-end"
                          >
                            <div role="menu" className="flex flex-col">
                              <button
                                type="button"
                                role="menuitem"
                                className={`${ghostButton} justify-start`}
                                onClick={() => {
                                  setMenuId(null);
                                  startEdit(item);
                                }}
                              >
                                {t('editItem')}
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                className={`${ghostButton} justify-start`}
                                disabled={position === 0}
                                onClick={() => {
                                  setMenuId(null);
                                  props.onMove(item.id, -1);
                                }}
                              >
                                <IconArrowUp size={14} aria-hidden />
                                {t('moveUp')}
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                className={`${ghostButton} justify-start`}
                                disabled={position === brief.items.length - 1}
                                onClick={() => {
                                  setMenuId(null);
                                  props.onMove(item.id, 1);
                                }}
                              >
                                <IconArrowDown size={14} aria-hidden />
                                {t('moveDown')}
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                className={`${ghostButton} justify-start text-red-800 dark:text-red-300`}
                                onClick={() => {
                                  setMenuId(null);
                                  props.onRemove(item.id);
                                }}
                              >
                                <IconTrash size={14} aria-hidden />
                                {t('removeItem')}
                              </button>
                            </div>
                          </Popover>
                        </span>
                      </div>
                      {open && (
                        <div className="rounded-lg bg-gray-50 p-2 dark:bg-surface-dark-elevated">
                          <ProofCard item={item} sources={sources} />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </li>
          );
        })}
        {extracting && (
          <li className="flex items-center gap-2 px-1 py-3 text-sm text-gray-700 dark:text-gray-300">
            <IconLoader size={15} className="animate-spin" aria-hidden />
            {t('extracting')}
          </li>
        )}
      </ul>

      <div className="space-y-2 border-t border-gray-200 p-3 dark:border-gray-700">
        {ownOpen ? (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!ownDraft.trim()) return;
              props.onAddOwn(ownDraft);
              setOwnDraft('');
              setOwnOpen(false);
            }}
          >
            <input
              autoFocus
              className={fieldClass}
              dir="auto"
              value={ownDraft}
              placeholder={t('addOwnPlaceholder')}
              aria-label={t('addOwnPlaceholder')}
              onChange={(event) => setOwnDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setOwnDraft('');
                  setOwnOpen(false);
                }
              }}
            />
            <button
              type="submit"
              className={ghostButton}
              disabled={!ownDraft.trim()}
            >
              {t('add')}
            </button>
          </form>
        ) : (
          <span className="relative block">
            <button
              type="button"
              className={ghostButton}
              aria-haspopup="menu"
              aria-expanded={addOpen}
              onClick={() => {
                // With nothing to pick from, the only choice is your own.
                if (goodSources.length === 0) setOwnOpen(true);
                else setAddOpen((open) => !open);
              }}
            >
              <IconPlus size={14} aria-hidden />
              {t('add')}
            </button>
            <Popover
              open={addOpen}
              onClose={() => setAddOpen(false)}
              placement="above-start"
            >
              <div role="menu" className="flex flex-col">
                <button
                  type="button"
                  role="menuitem"
                  className={`${ghostButton} justify-start`}
                  onClick={() => {
                    setAddOpen(false);
                    props.onOpenSource();
                  }}
                >
                  {t('addFromSource')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={`${ghostButton} justify-start`}
                  onClick={() => {
                    setAddOpen(false);
                    setOwnOpen(true);
                  }}
                >
                  {t('addOwn')}
                </button>
              </div>
            </Popover>
          </span>
        )}
        <button
          type="button"
          className="inline-flex min-h-[40px] w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-30"
          disabled={primaryDisabled}
          onClick={props.onPrimary}
        >
          {writing ? (
            <IconLoader size={16} className="animate-spin" aria-hidden />
          ) : (
            <IconSparkles size={16} aria-hidden />
          )}
          {writing ? t('writing') : primaryLabel}
        </button>
        {primaryDisabled && !writing && !extracting && !props.paused && (
          <p className="text-xs text-gray-700 dark:text-gray-300">
            {t('nothingIncluded')}
          </p>
        )}
      </div>
    </section>
  );
}
