'use client';

import {
  IconBrandTeams,
  IconCalendarEvent,
  IconChecklist,
  IconChevronDown,
  IconChevronRight,
  IconExternalLink,
  IconHash,
  IconMail,
  IconMessageCircle,
  IconRefresh,
} from '@tabler/icons-react';
import { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { useConversations } from '@/client/hooks/conversation/useConversations';

import { patchDigestMessage } from '@/client/services/m365/digest/digestMessage';
import {
  M365ClientError,
  createTodoTasks,
  deleteDigestJob,
  fetchDigestJob,
} from '@/client/services/m365/m365Client';
import { digestWindowDays } from '@/lib/services/m365/digest/digestWindow';

import {
  type CommsDigest,
  DIGEST_CATEGORIES,
  type DigestCategory,
  type DigestItem,
  type DigestMessageState,
  type DigestSourceKind,
} from '@/types/m365Digest';

import { useChatInputStore } from '@/client/stores/chatInputStore';
import { useConversationStore } from '@/client/stores/conversationStore';
import { useDigestLauncherStore } from '@/client/stores/digestLauncherStore';

interface DigestCardProps {
  state: DigestMessageState;
  conversationId: string;
}

const POLL_MS = 2_500;
/** Back off up to this factor after consecutive poll failures. */
const POLL_MAX_BACKOFF = 8;
/** A job the server never reports on after this long is treated as lost. */
const POLL_GIVE_UP_MS = 10 * 60_000;
/** Poll errors that can never resolve on their own. */
const TERMINAL_POLL_CODES = new Set([
  'UNAUTHORIZED',
  'FORBIDDEN',
  'VALIDATION_ERROR',
]);

const SOURCE_ICON: Record<DigestSourceKind, typeof IconMail> = {
  mail: IconMail,
  chat: IconMessageCircle,
  channel: IconHash,
  calendar: IconCalendarEvent,
};

/** Categories open by default: the ones that ask something of the reader. */
const OPEN_BY_DEFAULT: readonly DigestCategory[] = [
  'needsReply',
  'askedOfMe',
  'scheduling',
];

const CATEGORY_TONE: Record<DigestCategory, string> = {
  needsReply:
    'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200',
  askedOfMe:
    'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200',
  waitingOnOthers:
    'border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200',
  scheduling:
    'border-purple-200 bg-purple-50 text-purple-900 dark:border-purple-900 dark:bg-purple-950/40 dark:text-purple-200',
  companyUpdates:
    'border-teal-200 bg-teal-50 text-teal-900 dark:border-teal-900 dark:bg-teal-950/40 dark:text-teal-200',
  fyi: 'border-gray-200 bg-gray-50 text-gray-800 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-200',
  bulk: 'border-gray-200 bg-gray-50 text-gray-600 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-400',
};

function ageLabel(
  hours: number,
  t: ReturnType<typeof useTranslations>,
): string {
  if (hours < 1) return t('age.now');
  if (hours < 24) return t('age.hours', { count: hours });
  return t('age.days', { count: Math.round(hours / 24) });
}

/**
 * The Daily digest card (docs/M365_DAILY_DIGEST.md §6). Drives the job
 * while it runs (polling, then writing the result into the message), and
 * renders the result as fixed category sections with the deterministic
 * signals shown as badges. Every title/preview/sender is untrusted text and
 * is rendered as text only.
 */
export const DigestCard: FC<DigestCardProps> = ({ state, conversationId }) => {
  const t = useTranslations('m365.digest');
  const { updateConversation } = useConversations();
  const openLauncher = useDigestLauncherStore((s) => s.open);
  const setTextFieldValue = useChatInputStore((s) => s.setTextFieldValue);
  const [stage, setStage] = useState<string | null>(null);
  const [creatingTasks, setCreatingTasks] = useState(false);
  const [selectedActions, setSelectedActions] = useState<Set<string>>(
    () => new Set(),
  );
  const [openCategories, setOpenCategories] = useState<Set<DigestCategory>>(
    () => new Set(OPEN_BY_DEFAULT),
  );

  const patch = useCallback(
    (
      apply: (current: DigestMessageState) => {
        digest: DigestMessageState;
        content?: string;
      },
    ) => {
      // Read the live store at write time: a patch built from a render-time
      // snapshot would revert ticks made while a request was in flight.
      const conversation = useConversationStore
        .getState()
        .conversations.find((c) => c.id === conversationId);
      if (!conversation) return;
      const messages = patchDigestMessage(conversation, state.jobId, apply);
      if (messages) updateConversation(conversationId, { messages });
    },
    [conversationId, state.jobId, updateConversation],
  );

  // Poll while the job runs. The result is written INTO the message, so a
  // reload after completion needs no network at all.
  const active = state.status === 'pending' || state.status === 'processing';
  const pollStartedAt = useRef<number | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    pollStartedAt.current ??= Date.now();
    const fail = (error: string) =>
      patch((current) => ({
        digest: { ...current, status: 'failed', error },
        content: `${t('failedPrefix')} ${error}`,
      }));
    const schedule = () => {
      if (cancelled) return;
      const factor = Math.min(2 ** failures, POLL_MAX_BACKOFF);
      timer = setTimeout(() => void tick(), POLL_MS * factor);
    };
    const tick = async () => {
      if (cancelled) return;
      if (
        Date.now() - (pollStartedAt.current ?? Date.now()) >
        POLL_GIVE_UP_MS
      ) {
        fail(t('failed'));
        return;
      }
      try {
        const job = await fetchDigestJob(state.jobId);
        if (cancelled) return;
        failures = 0;
        setStage(job.progress?.stage ?? null);
        if (job.status === 'succeeded' && job.result) {
          const result = job.result;
          patch((current) => ({
            digest: { ...current, status: 'succeeded', result },
            content: result.markdown,
          }));
          // The message now holds the result; the server copy can go.
          void deleteDigestJob(state.jobId).catch(() => undefined);
          return;
        } else if (job.status === 'failed') {
          fail(job.error ?? t('failed'));
          return;
        } else if (job.status !== state.status) {
          patch((current) => ({
            digest: { ...current, status: job.status },
          }));
        }
      } catch (error) {
        if (cancelled) return;
        failures += 1;
        const code = error instanceof M365ClientError ? error.code : undefined;
        const message = error instanceof Error ? error.message : '';
        // A 404 means the job expired or never existed: terminal.
        if (code === 'NOT_FOUND' || /not found|404/i.test(message)) {
          patch((current) => ({
            digest: { ...current, status: 'failed', error: t('expired') },
            content: t('expired'),
          }));
          return;
        }
        // Auth and validation failures will not fix themselves; network
        // and server errors are retried with backoff.
        if (
          (code && TERMINAL_POLL_CODES.has(code)) ||
          /\b(401|403)\b/.test(message)
        ) {
          fail(message || t('failed'));
          return;
        }
      }
      schedule();
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, state.jobId, state.status, patch, t]);

  const result = state.result;
  const doneIds = useMemo(
    () => new Set(state.doneItemIds ?? []),
    [state.doneItemIds],
  );
  const createdTaskIds = useMemo(
    () => new Set(state.createdTaskIds ?? []),
    [state.createdTaskIds],
  );

  const toggleDone = (itemId: string) =>
    patch((current) => {
      const next = new Set(current.doneItemIds ?? []);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return { digest: { ...current, doneItemIds: [...next] } };
    });

  const askAbout = (item: DigestItem) => {
    const prompt = t('askPrompt', {
      title: item.title,
      from: item.from,
      source: t(`source.${item.source}`),
      when: item.whenIso.slice(0, 10),
    });
    setTextFieldValue((previous) => {
      const typed = previous.trimEnd();
      return typed ? `${typed}\n\n${prompt}` : prompt;
    });
  };

  const createTasks = async () => {
    if (!result) return;
    const chosen = result.actionItems.filter(
      (action) =>
        selectedActions.has(action.id) && !createdTaskIds.has(action.id),
    );
    if (chosen.length === 0) return;
    setCreatingTasks(true);
    try {
      const response = await createTodoTasks(
        chosen.map((action) => action.title),
      );
      toast.success(
        t('tasksCreated', { count: response.created, list: response.listName }),
      );
      patch((current) => ({
        digest: {
          ...current,
          createdTaskIds: [
            ...(current.createdTaskIds ?? []),
            ...chosen.map((action) => action.id),
          ],
        },
      }));
      setSelectedActions(new Set());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('tasksFailed'));
    } finally {
      setCreatingTasks(false);
    }
  };

  const windowLabel = (window: DigestMessageState['request']['window']) =>
    window.preset === 'lastWorkday'
      ? t('period.lastWorkday')
      : t('period.lastDays', { count: digestWindowDays(window) });

  // ── Pending / failed ────────────────────────────────────────────────────
  if (!result) {
    return (
      <div
        className="rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700"
        data-testid="digest-card"
      >
        <div className="flex items-center gap-2 font-medium text-gray-900 dark:text-gray-100">
          <IconChecklist size={18} aria-hidden="true" />
          {t('title')} · {windowLabel(state.request.window)}
        </div>
        {state.status === 'failed' ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-red-700 dark:text-red-300">
            <span>{state.error ?? t('failed')}</span>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-800 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
              onClick={() =>
                openLauncher({ preset: state.request.window.preset })
              }
            >
              <IconRefresh size={14} aria-hidden="true" />
              {t('runAgain')}
            </button>
          </div>
        ) : (
          <p className="mt-2 text-gray-600 dark:text-gray-400" role="status">
            {t('working')}
            {stage ? ` — ${stage}` : ''}
          </p>
        )}
      </div>
    );
  }

  // ── Result ──────────────────────────────────────────────────────────────
  const byCategory = new Map<DigestCategory, DigestItem[]>();
  for (const item of result.items) {
    const list = byCategory.get(item.category) ?? [];
    list.push(item);
    byCategory.set(item.category, list);
  }
  const problems = result.sources.filter(
    (source) => source.status !== 'ok' && source.status !== 'skipped',
  );
  const pendingActions = result.actionItems.filter(
    (action) => !createdTaskIds.has(action.id),
  );

  return (
    <div
      className="rounded-lg border border-gray-200 text-sm dark:border-gray-700"
      data-testid="digest-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-700">
        <div className="flex items-center gap-2 font-medium text-gray-900 dark:text-gray-100">
          <IconChecklist size={18} aria-hidden="true" />
          {t('title')} · {windowLabel(result.window)}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {result.sources.map((source) => {
            const Icon = SOURCE_ICON[source.kind];
            return (
              <span
                key={source.kind}
                title={source.note ?? t(`sourceStatus.${source.status}`)}
                className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] ${
                  source.status === 'ok'
                    ? 'border-gray-200 text-gray-600 dark:border-gray-700 dark:text-gray-400'
                    : 'border-amber-300 text-amber-800 dark:border-amber-800 dark:text-amber-300'
                }`}
              >
                <Icon size={12} aria-hidden="true" />
                {t(`source.${source.kind}`)} {source.scanned}
              </span>
            );
          })}
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-800 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
            onClick={() => openLauncher({ preset: result.window.preset })}
          >
            <IconRefresh size={14} aria-hidden="true" />
            {t('changePeriod')}
          </button>
        </div>
      </div>

      {(problems.length > 0 || result.degraded || result.withheldCount > 0) && (
        <ul className="border-b border-gray-200 px-3 py-2 text-xs text-amber-800 dark:border-gray-700 dark:text-amber-300">
          {problems.map((source) => (
            <li key={source.kind}>
              {t(`source.${source.kind}`)}: {t(`sourceStatus.${source.status}`)}
              {source.note ? ` — ${source.note}` : ''}
            </li>
          ))}
          {result.degraded && <li>{t('degraded')}</li>}
          {result.withheldCount > 0 && (
            <li>{t('withheld', { count: result.withheldCount })}</li>
          )}
        </ul>
      )}

      {result.items.length === 0 && (
        <p className="px-3 py-3 text-gray-600 dark:text-gray-400">
          {t('empty')}
        </p>
      )}

      {result.actionItems.length > 0 && (
        <div className="border-b border-gray-200 px-3 py-2 dark:border-gray-700">
          <div className="mb-1 flex items-center justify-between gap-2">
            <h4 className="font-medium text-gray-900 dark:text-gray-100">
              {t('actionItems')} ({result.actionItems.length})
            </h4>
            {pendingActions.length > 0 && (
              <button
                type="button"
                disabled={creatingTasks || selectedActions.size === 0}
                onClick={() => void createTasks()}
                className="inline-flex items-center gap-1 rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <IconBrandTeams size={14} aria-hidden="true" />
                {t('createTasks', { count: selectedActions.size })}
              </button>
            )}
          </div>
          <ul className="space-y-1">
            {result.actionItems.map((action) => {
              const created = createdTaskIds.has(action.id);
              return (
                <li key={action.id} className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4"
                    aria-label={action.title}
                    disabled={created}
                    checked={created || selectedActions.has(action.id)}
                    onChange={(event) =>
                      setSelectedActions((previous) => {
                        const next = new Set(previous);
                        if (event.target.checked) next.add(action.id);
                        else next.delete(action.id);
                        return next;
                      })
                    }
                  />
                  <span
                    className={
                      created
                        ? 'text-gray-500 line-through dark:text-gray-500'
                        : 'text-gray-800 dark:text-gray-200'
                    }
                  >
                    {action.title}
                    {(action.askedBy || action.dueHint) && (
                      <span className="ms-1 text-xs text-gray-500 dark:text-gray-400">
                        {[action.askedBy, action.dueHint]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    )}
                    {created && (
                      <span className="ms-1 text-xs text-green-700 dark:text-green-400">
                        {t('taskCreated')}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {DIGEST_CATEGORIES.map((category) => {
        const items = byCategory.get(category) ?? [];
        if (items.length === 0) return null;
        const open = openCategories.has(category);
        const themes = result.themes.filter(
          (theme) => theme.category === category,
        );
        return (
          <section
            key={category}
            className="border-b border-gray-200 last:border-b-0 dark:border-gray-700"
          >
            <button
              type="button"
              aria-expanded={open}
              onClick={() =>
                setOpenCategories((previous) => {
                  const next = new Set(previous);
                  if (next.has(category)) next.delete(category);
                  else next.add(category);
                  return next;
                })
              }
              className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-800/60"
            >
              {open ? (
                <IconChevronDown size={16} aria-hidden="true" />
              ) : (
                <IconChevronRight size={16} aria-hidden="true" />
              )}
              <span className="font-medium text-gray-900 dark:text-gray-100">
                {t(`category.${category}`)}
              </span>
              <span
                className={`rounded-full border px-1.5 text-[11px] ${CATEGORY_TONE[category]}`}
              >
                {items.length}
              </span>
              {category === 'companyUpdates' && (
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {t('companyUpdatesHint')}
                </span>
              )}
            </button>
            {open && (
              <div className="px-3 pb-2">
                {themes.length > 0 && (
                  <ul className="mb-2 space-y-1 rounded bg-gray-50 p-2 text-xs dark:bg-gray-800/60">
                    {themes.map((theme) => (
                      <li key={theme.title}>
                        <span className="font-medium text-gray-900 dark:text-gray-100">
                          {theme.title}
                        </span>{' '}
                        <span className="text-gray-700 dark:text-gray-300">
                          {theme.summary}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <ul className="space-y-1.5">
                  {items.map((item) => {
                    const Icon = SOURCE_ICON[item.source];
                    const done = doneIds.has(item.id);
                    return (
                      <li
                        key={item.id}
                        className={`flex items-start gap-2 ${done ? 'opacity-60' : ''}`}
                      >
                        <input
                          type="checkbox"
                          className="mt-1 h-4 w-4"
                          aria-label={t('markDone', { title: item.title })}
                          checked={done}
                          onChange={() => toggleDone(item.id)}
                        />
                        <Icon
                          size={16}
                          aria-label={t(`source.${item.source}`)}
                          className="mt-0.5 shrink-0 text-gray-500 dark:text-gray-400"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-baseline gap-x-2">
                            <span
                              className={`font-medium text-gray-900 dark:text-gray-100 ${done ? 'line-through' : ''}`}
                            >
                              {item.title}
                            </span>
                            <span className="text-xs text-gray-500 dark:text-gray-400">
                              {item.from} · {ageLabel(item.signals.ageHours, t)}
                            </span>
                            {item.signals.unanswered && (
                              <span className="rounded bg-red-100 px-1 text-[11px] text-red-800 dark:bg-red-900/50 dark:text-red-200">
                                {t('badge.unanswered')}
                              </span>
                            )}
                            {item.signals.mentionsMe &&
                              item.source !== 'mail' &&
                              !item.signals.invitation && (
                                <span className="rounded bg-blue-100 px-1 text-[11px] text-blue-800 dark:bg-blue-900/50 dark:text-blue-200">
                                  {t('badge.mentioned')}
                                </span>
                              )}
                            {item.signals.important && (
                              <span className="rounded bg-amber-100 px-1 text-[11px] text-amber-900 dark:bg-amber-900/50 dark:text-amber-200">
                                {t('badge.important')}
                              </span>
                            )}
                          </div>
                          {item.preview && (
                            <p className="truncate text-xs text-gray-600 dark:text-gray-400">
                              {item.preview}
                            </p>
                          )}
                          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs">
                            {item.reason && (
                              <span className="text-gray-500 dark:text-gray-500">
                                {item.reason}
                              </span>
                            )}
                            <button
                              type="button"
                              className="text-blue-700 hover:underline dark:text-blue-300"
                              onClick={() => askAbout(item)}
                            >
                              {t('askAbout')}
                            </button>
                            {item.webLink &&
                              /^https:\/\//i.test(item.webLink) && (
                                <a
                                  href={item.webLink}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-0.5 text-blue-700 hover:underline dark:text-blue-300"
                                >
                                  <IconExternalLink
                                    size={12}
                                    aria-hidden="true"
                                  />
                                  {t(`open.${item.source}`)}
                                </a>
                              )}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </section>
        );
      })}
      <p className="px-3 py-2 text-[11px] text-gray-500 dark:text-gray-400">
        {t('footnote')}
      </p>
    </div>
  );
};
