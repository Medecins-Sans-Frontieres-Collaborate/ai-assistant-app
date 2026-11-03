/**
 * Digest collectors — one per source (docs/M365_DAILY_DIGEST.md §3). Each
 * returns candidate items with DETERMINISTIC signals (unanswered, mentioned,
 * broadcast, invitation); classification happens afterwards in
 * digestClassify.ts and may only explain these facts, never invent them.
 *
 * Binding constraints:
 *  - read-only Graph, ≤4 in flight, one wall-clock deadline for the run;
 *  - mail is envelopes + previews only (no bodies, no attachments);
 *  - Teams text is HTML-stripped and truncated, and treated as untrusted;
 *  - a source that lacks consent reports `unavailable` instead of failing
 *    the digest; any other failure reports `error` with a short note.
 */
import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import {
  computeAwaitingMyReply,
  computeAwaitingTheirReply,
} from '@/lib/services/m365/tools/mailCompositeTools';
import {
  CompositeRun,
  ENVELOPE_SELECT,
  MailEnvelopeLite,
  fetchWindowEnvelopes,
  graphGetJson,
} from '@/lib/services/m365/tools/mailOrchestration';
import { stripHtml, truncateText } from '@/lib/services/m365/tools/shared';

import type {
  DigestChannelRef,
  DigestItem,
  DigestItemSignals,
  DigestSourceKind,
  DigestSourceReport,
  DigestWindow,
} from '@/types/m365Digest';

// ---------------------------------------------------------------------------
// Run: limiter + deadline (longer than a tool composite: this is a job)
// ---------------------------------------------------------------------------

export const DIGEST_WALL_CLOCK_MS = 90_000;
const MAX_CONCURRENT = 4;

export const DIGEST_CAPS = {
  mailEnvelopes: 500,
  chats: 40,
  chatMessagesPerChat: 50,
  channelRootPages: 2,
  channelRootsPerPage: 50,
  channelReplyFetches: 10,
  channelItemsPerChannel: 25,
  calendarEvents: 100,
  previewChars: 200,
} as const;

export const SOURCE_SCOPES: Record<DigestSourceKind, string[]> = {
  mail: ['Mail.Read'],
  chat: ['Chat.Read'],
  channel: ['ChannelMessage.Read.All'],
  calendar: ['Calendars.ReadWrite'],
};

/** Floor for a single Graph call's abort timeout near the deadline. */
const MIN_CALL_TIMEOUT_MS = 15_000;

function createLimiter(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    if (active >= max) return;
    const run = queue.shift();
    if (run) run();
  };
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        active++;
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
}

export interface DigestRun extends CompositeRun {
  readonly deadlineAt: number;
}

export function createDigestRun(
  req: NextRequest,
  scopes: string[],
  now: number = Date.now(),
  budgetMs: number = DIGEST_WALL_CLOCK_MS,
): DigestRun {
  const deadlineAt = now + budgetMs;
  return {
    req,
    scopes,
    scanned: 0,
    bodiesFetched: 0,
    deadlineAt,
    timedOut: () => Date.now() >= deadlineAt,
    schedule: createLimiter(MAX_CONCURRENT),
    // Each fetch gets the remaining budget, never less than a grace period,
    // so a hung Graph connection is cut before the poller declares the job
    // stale (STALE_DIGEST_JOB_MS) instead of idling for undici's 300 s.
    signalFor: () =>
      AbortSignal.timeout(
        Math.max(MIN_CALL_TIMEOUT_MS, deadlineAt - Date.now()),
      ),
  };
}

/** A run view with the scopes a source needs (the limiter and clock are shared). */
function withScopes(run: DigestRun, scopes: string[]): DigestRun {
  return { ...run, scopes, schedule: run.schedule, timedOut: run.timedOut };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export interface CollectResult {
  items: DigestItem[];
  report: DigestSourceReport;
  /** Items dropped before they could become candidates (filters, screens). */
  withheld: number;
}

function isConsentMissing(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { kind?: unknown }).kind === 'consent_missing'
  );
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return truncateText(message.replace(/\s+/g, ' '), 160);
}

export function failedReport(
  kind: DigestSourceKind,
  error: unknown,
  scanned: number,
): DigestSourceReport {
  if (isConsentMissing(error)) {
    return {
      kind,
      status: 'unavailable',
      scanned,
      note: 'Permission for this source has not been granted.',
    };
  }
  return { kind, status: 'error', scanned, note: shortError(error) };
}

const hoursSince = (iso: string, nowMs: number): number =>
  Math.max(0, Math.round((nowMs - Date.parse(iso)) / 3_600_000));

function baseSignals(whenIso: string, nowMs: number): DigestItemSignals {
  return {
    unanswered: false,
    mentionsMe: false,
    waitingOnOthers: false,
    broadcast: false,
    invitation: false,
    important: false,
    ageHours: hoursSince(whenIso, nowMs),
  };
}

const inWindow = (iso: string | undefined, window: DigestWindow): boolean =>
  !!iso && iso >= window.startIso && iso <= window.endIso;

/** The signed-in user as Graph sees them; null when /me is not readable. */
export interface DigestMe {
  id: string | null;
  addresses: Set<string>;
  displayName: string | null;
}

export async function resolveMe(
  run: DigestRun,
  session: Session,
): Promise<DigestMe> {
  const addresses = new Set<string>();
  const user = session.user as
    | { email?: string | null; mail?: string | null; name?: string | null }
    | undefined;
  for (const address of [user?.mail, user?.email]) {
    if (address) addresses.add(address.toLowerCase());
  }
  try {
    const me = await graphGetJson<{
      id?: string;
      mail?: string;
      userPrincipalName?: string;
      displayName?: string;
    }>(run, '/me?$select=id,mail,userPrincipalName,displayName', {
      scopes: ['User.Read'],
    });
    for (const address of [me.mail, me.userPrincipalName]) {
      if (address) addresses.add(address.toLowerCase());
    }
    return {
      id: me.id ?? null,
      addresses,
      displayName: me.displayName ?? user?.name ?? null,
    };
  } catch {
    return { id: null, addresses, displayName: user?.name ?? null };
  }
}

// ---------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------

const BROADCAST_SENDER_RE =
  /^(all|allstaff|all-staff|everyone|staff|announcements?|news(letter)?|comms|communications?|hr|it-?(support|news)|noreply|no-reply|donotreply|notifications?)[@+-]/i;
const BULK_SENDER_RE =
  /no-?reply|donotreply|notifications?@|newsletter|mailer[-.@]|bounce|digest@/i;
export const BROADCAST_RECIPIENTS_MIN = 15;

function inboxWindowPath(sinceIso: string, untilIso: string): string {
  return (
    `/me/mailFolders/inbox/messages?$filter=receivedDateTime ge ${sinceIso}` +
    ` and receivedDateTime le ${untilIso}` +
    `&$orderby=receivedDateTime desc&$select=${ENVELOPE_SELECT}&$top=50`
  );
}

function sentWindowPath(sinceIso: string): string {
  return (
    `/me/mailFolders/sentitems/messages?$filter=sentDateTime ge ${sinceIso}` +
    `&$orderby=sentDateTime desc&$select=${ENVELOPE_SELECT}&$top=50`
  );
}

/** Outlook on the web deep link for a message id. */
export function outlookMessageLink(messageId: string): string {
  return `https://outlook.office.com/mail/deeplink/read/${encodeURIComponent(messageId)}`;
}

/** Latest envelope per conversation, newest first. */
export function latestPerConversation(
  envelopes: readonly MailEnvelopeLite[],
): MailEnvelopeLite[] {
  const latest = new Map<string, MailEnvelopeLite>();
  for (const envelope of envelopes) {
    const current = latest.get(envelope.conversationId);
    if (!current || envelope.receivedMs > current.receivedMs) {
      latest.set(envelope.conversationId, envelope);
    }
  }
  return [...latest.values()].sort((a, b) => b.receivedMs - a.receivedMs);
}

export function mailItemFromEnvelope(
  envelope: MailEnvelopeLite,
  me: DigestMe,
  nowMs: number,
  extra: Partial<DigestItemSignals> & { reason?: string } = {},
): DigestItem {
  const recipients = envelope.toAddresses.length + envelope.ccAddresses.length;
  const directTo = envelope.toAddresses.some((address) =>
    me.addresses.has(address.toLowerCase()),
  );
  const broadcast =
    recipients >= BROADCAST_RECIPIENTS_MIN ||
    BROADCAST_SENDER_RE.test(envelope.fromAddress) ||
    BULK_SENDER_RE.test(envelope.fromAddress);
  const { reason, ...signalOverrides } = extra;
  return {
    id: `mail:${envelope.id}`,
    source: 'mail',
    category: 'fyi',
    title: envelope.subject || '(no subject)',
    from: envelope.fromName || envelope.fromAddress || 'Unknown sender',
    fromAddress: envelope.fromAddress || undefined,
    whenIso: envelope.receivedIso,
    preview: truncateText(envelope.preview, DIGEST_CAPS.previewChars),
    reason: reason ?? '',
    signals: {
      ...baseSignals(envelope.receivedIso, nowMs),
      mentionsMe: directTo,
      broadcast,
      important: envelope.importance === 'high',
      recipients,
      ...signalOverrides,
    },
    webLink: outlookMessageLink(envelope.id),
    conversationId: envelope.conversationId,
    ref: { messageId: envelope.id },
  };
}

export async function collectMail(
  run: DigestRun,
  window: DigestWindow,
  me: DigestMe,
  nowMs: number = Date.now(),
): Promise<CollectResult> {
  const scoped = withScopes(run, SOURCE_SCOPES.mail);
  let scanned = 0;
  try {
    // Sent Items get a 2-day grace before the window so replies sent just
    // before the boundary still cancel their conversations.
    const sentSince = new Date(
      Date.parse(window.startIso) - 2 * 86_400_000,
    ).toISOString();
    const [received, sent] = await Promise.all([
      fetchWindowEnvelopes(
        scoped,
        inboxWindowPath(window.startIso, window.endIso),
      ),
      fetchWindowEnvelopes(scoped, sentWindowPath(sentSince)),
    ]);
    scanned = received.envelopes.length + sent.envelopes.length;
    const fromMe = (envelope: MailEnvelopeLite) =>
      me.addresses.has(envelope.fromAddress.toLowerCase());
    // The inbox copy of a self-addressed or DL-echoed send is not someone
    // writing to the user.
    const receivedInWindow = received.envelopes.filter(
      (envelope) => envelope.receivedIso <= window.endIso && !fromMe(envelope),
    );
    // Addressing is judged over the whole thread: a direct ask followed by
    // a reply-all that only cc's the user is still a direct ask.
    const addressedTo = new Map<string, { direct: boolean; cc: boolean }>();
    for (const envelope of receivedInWindow) {
      const entry = addressedTo.get(envelope.conversationId) ?? {
        direct: false,
        cc: false,
      };
      if (envelope.toAddresses.some((to) => me.addresses.has(to.toLowerCase())))
        entry.direct = true;
      if (envelope.ccAddresses.some((cc) => me.addresses.has(cc.toLowerCase())))
        entry.cc = true;
      addressedTo.set(envelope.conversationId, entry);
    }
    const userAddress = [...me.addresses][0];
    const awaitingMe = new Map(
      computeAwaitingMyReply({
        received: receivedInWindow,
        sent: sent.envelopes,
        ...(userAddress && { userAddress }),
        nowMs,
      }).map((candidate) => [candidate.envelope.conversationId, candidate]),
    );
    const awaitingThem = computeAwaitingTheirReply({
      sent: sent.envelopes.filter(
        (envelope) => envelope.receivedIso >= window.startIso,
      ),
      received: received.envelopes,
      minDaysSilent: 2,
      nowMs,
    });

    const items: DigestItem[] = latestPerConversation(receivedInWindow).map(
      (envelope) => {
        const waiting = awaitingMe.get(envelope.conversationId);
        const addressed = addressedTo.get(envelope.conversationId);
        // "Unanswered" means someone wrote TO the user (To or Cc) and got
        // nothing back — a DL copy nobody addressed to them does not count.
        const unanswered = !!waiting && !!(addressed?.direct || addressed?.cc);
        const item = mailItemFromEnvelope(envelope, me, nowMs, {
          unanswered,
          mentionsMe: !!addressed?.direct,
          reason: unanswered ? waiting!.reasons.join('; ') : '',
        });
        // Nobody is waiting on a reply to an all-staff note or a newsletter,
        // even when the user is one of the many explicit recipients.
        if (item.signals.broadcast && item.signals.unanswered) {
          item.signals.unanswered = false;
          item.reason = '';
        }
        return item;
      },
    );
    const covered = new Set(items.map((item) => item.conversationId));
    for (const candidate of awaitingThem) {
      if (covered.has(candidate.envelope.conversationId)) continue;
      const item = mailItemFromEnvelope(candidate.envelope, me, nowMs, {
        waitingOnOthers: true,
        mentionsMe: false,
        reason: `you wrote last, ${candidate.daysSilent} days without an answer`,
      });
      // The user's own announcements and bulk sends are not awaiting anyone.
      if (item.signals.broadcast) continue;
      items.push(item);
    }
    const partial = received.capReached || sent.capReached || run.timedOut();
    return {
      items,
      withheld: 0,
      report: {
        kind: 'mail',
        status: partial ? 'partial' : 'ok',
        scanned,
        ...(partial && {
          note: 'Scan capped: the newest mail was read first, older mail in the period may be missing.',
        }),
      },
    };
  } catch (error) {
    return {
      items: [],
      withheld: 0,
      report: failedReport('mail', error, scanned),
    };
  }
}

// ---------------------------------------------------------------------------
// Teams (shared message shape)
// ---------------------------------------------------------------------------

interface GraphTeamsMessage {
  id?: string;
  messageType?: string;
  createdDateTime?: string;
  deletedDateTime?: string | null;
  subject?: string | null;
  webUrl?: string;
  from?: {
    user?: { id?: string; displayName?: string };
    application?: { displayName?: string };
  } | null;
  body?: { content?: string; contentType?: string };
  mentions?: {
    mentioned?: { user?: { id?: string; displayName?: string } };
  }[];
}

function teamsSender(message: GraphTeamsMessage): string {
  return (
    message.from?.user?.displayName ||
    message.from?.application?.displayName ||
    'Unknown'
  );
}

export function isFromMe(message: GraphTeamsMessage, me: DigestMe): boolean {
  const id = message.from?.user?.id;
  if (me.id && id) return id === me.id;
  // Without /me we can only match the display name — weaker, stated in docs.
  return (
    !!me.displayName &&
    !!message.from?.user?.displayName &&
    message.from.user.displayName === me.displayName
  );
}

export function mentionsMe(message: GraphTeamsMessage, me: DigestMe): boolean {
  if (!me.id) return false;
  return (message.mentions ?? []).some(
    (mention) => mention.mentioned?.user?.id === me.id,
  );
}

const isRealMessage = (message: GraphTeamsMessage): boolean =>
  !!message.id &&
  (message.messageType ?? 'message') === 'message' &&
  !message.deletedDateTime &&
  !!message.createdDateTime;

function teamsPreview(message: GraphTeamsMessage): string {
  const raw = message.body?.content ?? '';
  const text =
    message.body?.contentType?.toLowerCase() === 'text' ? raw : stripHtml(raw);
  return truncateText(
    text.replace(/\s+/g, ' ').trim(),
    DIGEST_CAPS.previewChars,
  );
}

/**
 * Pure: given a chat's messages (any order), the latest message from
 * someone else in the window and whether it went unanswered. Mentions win
 * over plain latest so an @-ask is the item even if chatter followed.
 */
export function analyzeChatMessages(
  messages: readonly GraphTeamsMessage[],
  me: DigestMe,
  window: DigestWindow,
  oneOnOne: boolean,
): {
  candidate: GraphTeamsMessage | null;
  mentioned: boolean;
  unanswered: boolean;
  scanned: number;
} {
  const real = messages.filter(isRealMessage);
  const others = real.filter(
    (message) =>
      !isFromMe(message, me) && inWindow(message.createdDateTime, window),
  );
  if (others.length === 0) {
    return {
      candidate: null,
      mentioned: false,
      unanswered: false,
      scanned: real.length,
    };
  }
  const byTime = (a: GraphTeamsMessage, b: GraphTeamsMessage) =>
    (b.createdDateTime ?? '').localeCompare(a.createdDateTime ?? '');
  const mentionMessages = others
    .filter((message) => mentionsMe(message, me))
    .sort(byTime);
  const candidate = mentionMessages[0] ?? others.sort(byTime)[0];
  const mentioned = mentionMessages.length > 0;
  const repliedAfter = real.some(
    (message) =>
      isFromMe(message, me) &&
      (message.createdDateTime ?? '') > (candidate.createdDateTime ?? ''),
  );
  return {
    candidate,
    mentioned,
    unanswered: (oneOnOne || mentioned) && !repliedAfter,
    scanned: real.length,
  };
}

interface GraphChat {
  id?: string;
  topic?: string | null;
  chatType?: string;
  webUrl?: string;
  lastMessagePreview?: { createdDateTime?: string } | null;
}

export async function collectChats(
  run: DigestRun,
  window: DigestWindow,
  me: DigestMe,
  nowMs: number = Date.now(),
): Promise<CollectResult> {
  const scoped = withScopes(run, SOURCE_SCOPES.chat);
  let scanned = 0;
  try {
    const list = await graphGetJson<{ value?: GraphChat[] }>(
      scoped,
      `/me/chats?$expand=lastMessagePreview&$top=${DIGEST_CAPS.chats}` +
        '&$orderby=lastMessagePreview/createdDateTime desc',
    );
    const active = (list.value ?? []).filter(
      (chat) =>
        !!chat.id &&
        (chat.lastMessagePreview?.createdDateTime ?? '') >= window.startIso,
    );
    const items: DigestItem[] = [];
    // Every listed chat was active in the window ⇒ older active chats were cut.
    let partial =
      (list.value?.length ?? 0) >= DIGEST_CAPS.chats &&
      active.length === (list.value?.length ?? 0);
    await Promise.all(
      active.map(async (chat) => {
        if (scoped.timedOut()) {
          partial = true;
          return;
        }
        const data = await graphGetJson<{ value?: GraphTeamsMessage[] }>(
          scoped,
          `/me/chats/${encodeURIComponent(chat.id!)}/messages?$top=${DIGEST_CAPS.chatMessagesPerChat}`,
        );
        const analysis = analyzeChatMessages(
          data.value ?? [],
          me,
          window,
          chat.chatType === 'oneOnOne',
        );
        scanned += analysis.scanned;
        const message = analysis.candidate;
        if (!message?.id || !message.createdDateTime) return;
        const sender = teamsSender(message);
        items.push({
          id: `chat:${message.id}`,
          source: 'chat',
          category: 'fyi',
          title: chat.topic?.trim() || `Chat with ${sender}`,
          from: sender,
          whenIso: message.createdDateTime,
          preview: teamsPreview(message),
          reason: '',
          signals: {
            ...baseSignals(message.createdDateTime, nowMs),
            mentionsMe: analysis.mentioned,
            unanswered: analysis.unanswered,
          },
          ...(chat.webUrl && { webLink: chat.webUrl }),
          ref: { messageId: message.id, chatId: chat.id! },
        });
      }),
    );
    items.sort((a, b) => b.whenIso.localeCompare(a.whenIso));
    return {
      items,
      withheld: 0,
      report: {
        kind: 'chat',
        status: partial ? 'partial' : 'ok',
        scanned,
        ...(partial
          ? { note: 'Time budget reached before every chat was read.' }
          : {}),
      },
    };
  } catch (error) {
    return {
      items: [],
      withheld: 0,
      report: failedReport('chat', error, scanned),
    };
  }
}

// ---------------------------------------------------------------------------
// Teams channels (opt-in list)
// ---------------------------------------------------------------------------

export async function collectChannels(
  run: DigestRun,
  window: DigestWindow,
  channels: readonly DigestChannelRef[],
  me: DigestMe,
  nowMs: number = Date.now(),
): Promise<CollectResult> {
  if (channels.length === 0) {
    return {
      items: [],
      withheld: 0,
      report: {
        kind: 'channel',
        status: 'skipped',
        scanned: 0,
        note: 'No channels selected.',
      },
    };
  }
  const scoped = withScopes(run, SOURCE_SCOPES.channel);
  let scanned = 0;
  let partial = false;
  const items: DigestItem[] = [];
  const errors: string[] = [];
  for (const channel of channels) {
    if (scoped.timedOut()) {
      partial = true;
      break;
    }
    try {
      const base = `/teams/${encodeURIComponent(channel.teamId)}/channels/${encodeURIComponent(channel.channelId)}/messages`;
      const roots: GraphTeamsMessage[] = [];
      let path: string | null =
        `${base}?$top=${DIGEST_CAPS.channelRootsPerPage}`;
      for (
        let page = 0;
        path && page < DIGEST_CAPS.channelRootPages && !scoped.timedOut();
        page++
      ) {
        const data: {
          value?: GraphTeamsMessage[];
          '@odata.nextLink'?: string;
        } = await graphGetJson(scoped, path);
        const batch = (data.value ?? []).filter(isRealMessage);
        scanned += batch.length;
        roots.push(...batch);
        const oldest = batch[batch.length - 1]?.createdDateTime ?? '';
        path =
          oldest && oldest < window.startIso
            ? null
            : (data['@odata.nextLink'] ?? null);
      }
      const inRange = roots
        .filter((root) => inWindow(root.createdDateTime, window))
        .sort((a, b) =>
          (b.createdDateTime ?? '').localeCompare(a.createdDateTime ?? ''),
        );

      // Reply chains for the newest roots: catch @-mentions in replies and
      // check whether the user answered a mention.
      const repliesByRoot = new Map<string, GraphTeamsMessage[]>();
      await Promise.all(
        inRange.slice(0, DIGEST_CAPS.channelReplyFetches).map(async (root) => {
          if (scoped.timedOut()) return;
          try {
            const data = await graphGetJson<{ value?: GraphTeamsMessage[] }>(
              scoped,
              `${base}/${encodeURIComponent(root.id!)}/replies?$top=50`,
            );
            const replies = (data.value ?? []).filter(isRealMessage);
            scanned += replies.length;
            repliesByRoot.set(root.id!, replies);
          } catch {
            /* a single chain failing is not a source failure */
          }
        }),
      );

      let count = 0;
      for (const root of inRange) {
        if (count >= DIGEST_CAPS.channelItemsPerChannel) {
          partial = true;
          break;
        }
        const replies = repliesByRoot.get(root.id!) ?? [];
        const mentionIn = [root, ...replies].filter(
          (message) => mentionsMe(message, me) && !isFromMe(message, me),
        );
        const latestMention = mentionIn.sort((a, b) =>
          (b.createdDateTime ?? '').localeCompare(a.createdDateTime ?? ''),
        )[0];
        const fromMe = isFromMe(root, me);
        if (fromMe && !latestMention) continue; // my own posts are not news to me
        const focus = latestMention ?? root;
        const answered =
          !!latestMention &&
          replies.some(
            (reply) =>
              isFromMe(reply, me) &&
              (reply.createdDateTime ?? '') >
                (latestMention.createdDateTime ?? ''),
          );
        const whenIso = focus.createdDateTime!;
        items.push({
          id: `channel:${focus.id}`,
          source: 'channel',
          category: 'fyi',
          title: root.subject?.trim() || `${channel.name}`,
          from: teamsSender(focus),
          whenIso,
          preview: teamsPreview(focus),
          reason: '',
          signals: {
            ...baseSignals(whenIso, nowMs),
            mentionsMe: !!latestMention,
            unanswered: !!latestMention && !answered,
            broadcast: !latestMention,
          },
          ...(focus.webUrl && { webLink: focus.webUrl }),
          ref: {
            messageId: focus.id!,
            teamId: channel.teamId,
            channelId: channel.channelId,
          },
        });
        count++;
      }
    } catch (error) {
      if (isConsentMissing(error)) {
        return {
          items,
          withheld: 0,
          report: failedReport('channel', error, scanned),
        };
      }
      errors.push(`${channel.name}: ${shortError(error)}`);
    }
  }
  const note = [
    ...(partial
      ? ['Not every channel or post could be read in the time budget.']
      : []),
    ...errors,
  ].join(' ');
  return {
    items,
    withheld: 0,
    report: {
      kind: 'channel',
      status:
        errors.length === channels.length
          ? 'error'
          : partial || errors.length
            ? 'partial'
            : 'ok',
      scanned,
      ...(note && { note }),
    },
  };
}

// ---------------------------------------------------------------------------
// Calendar: invitations without a response, and my meetings others ignored
// ---------------------------------------------------------------------------

interface GraphEvent {
  id?: string;
  subject?: string;
  isOrganizer?: boolean;
  isCancelled?: boolean;
  webLink?: string;
  createdDateTime?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  organizer?: { emailAddress?: { name?: string; address?: string } };
  seriesMasterId?: string;
  type?: string;
  responseStatus?: { response?: string };
  attendees?: {
    type?: string;
    status?: { response?: string };
    emailAddress?: { name?: string; address?: string };
  }[];
}

const LOOKAHEAD_DAYS = 14;

/** Pure: items from a calendarView page. Exported for tests. */
export function calendarItemsFromEvents(
  events: readonly GraphEvent[],
  window: DigestWindow,
  nowMs: number,
): DigestItem[] {
  const items: DigestItem[] = [];
  const toIso = (value?: string) =>
    value
      ? new Date(value + (value.endsWith('Z') ? '' : 'Z')).toISOString()
      : '';
  const seenSeries = new Set<string>();
  const ordered = [...events].sort((a, b) =>
    toIso(a.start?.dateTime).localeCompare(toIso(b.start?.dateTime)),
  );
  for (const event of ordered) {
    if (!event.id || event.isCancelled) continue;
    // calendarView expands recurring series into occurrences: one line per
    // series (its next occurrence), not one per week.
    if (event.seriesMasterId) {
      if (seenSeries.has(event.seriesMasterId)) continue;
      seenSeries.add(event.seriesMasterId);
    }
    const startIso = toIso(event.start?.dateTime);
    const endIso = toIso(event.end?.dateTime) || startIso;
    const organizer =
      event.organizer?.emailAddress?.name ||
      event.organizer?.emailAddress?.address ||
      'Unknown';
    const title = event.subject?.trim() || '(no subject)';
    if (
      !event.isOrganizer &&
      event.responseStatus?.response === 'notResponded'
    ) {
      // A meeting that already ended is not awaiting a response any more.
      if (endIso && Date.parse(endIso) < nowMs) continue;
      const whenIso = event.createdDateTime ?? startIso;
      if (!whenIso) continue;
      items.push({
        id: `calendar:${event.id}`,
        source: 'calendar',
        category: 'scheduling',
        title,
        from: organizer,
        fromAddress: event.organizer?.emailAddress?.address,
        whenIso,
        preview: startIso
          ? `Meeting at ${startIso.slice(0, 16).replace('T', ' ')} UTC`
          : '',
        reason: 'invitation without a response',
        signals: {
          ...baseSignals(whenIso, nowMs),
          invitation: true,
          unanswered: true,
          mentionsMe: true,
        },
        ...(event.webLink && { webLink: event.webLink }),
        ref: { messageId: event.id, eventId: event.id },
      });
      continue;
    }
    if (event.isOrganizer && startIso && startIso >= window.endIso) {
      const silent = (event.attendees ?? []).filter(
        (attendee) =>
          attendee.type !== 'resource' &&
          (attendee.status?.response ?? 'none') === 'none',
      );
      if (silent.length === 0) continue;
      const whenIso = event.createdDateTime ?? startIso;
      items.push({
        id: `calendar:${event.id}`,
        source: 'calendar',
        category: 'scheduling',
        title,
        from: 'You (organizer)',
        whenIso,
        preview: `${silent.length} invitee${silent.length === 1 ? '' : 's'} have not responded; starts ${startIso.slice(0, 16).replace('T', ' ')} UTC`,
        reason: 'your meeting, attendees have not responded',
        signals: {
          ...baseSignals(whenIso, nowMs),
          waitingOnOthers: true,
        },
        ...(event.webLink && { webLink: event.webLink }),
        ref: { messageId: event.id, eventId: event.id },
      });
    }
  }
  return items.sort((a, b) => b.whenIso.localeCompare(a.whenIso));
}

export async function collectCalendar(
  run: DigestRun,
  window: DigestWindow,
  nowMs: number = Date.now(),
): Promise<CollectResult> {
  const scoped = withScopes(run, SOURCE_SCOPES.calendar);
  let scanned = 0;
  try {
    const end = new Date(
      Date.parse(window.endIso) + LOOKAHEAD_DAYS * 86_400_000,
    ).toISOString();
    const data = await graphGetJson<{ value?: GraphEvent[] }>(
      scoped,
      `/me/calendarView?startDateTime=${encodeURIComponent(window.startIso)}` +
        `&endDateTime=${encodeURIComponent(end)}` +
        '&$select=id,subject,isOrganizer,isCancelled,webLink,createdDateTime,start,end,organizer,responseStatus,attendees,seriesMasterId,type' +
        `&$top=${DIGEST_CAPS.calendarEvents}`,
      { init: { headers: { Prefer: 'outlook.timezone="UTC"' } } },
    );
    const events = data.value ?? [];
    scanned = events.length;
    return {
      items: calendarItemsFromEvents(events, window, nowMs),
      withheld: 0,
      report: { kind: 'calendar', status: 'ok', scanned },
    };
  } catch (error) {
    return {
      items: [],
      withheld: 0,
      report: failedReport('calendar', error, scanned),
    };
  }
}
