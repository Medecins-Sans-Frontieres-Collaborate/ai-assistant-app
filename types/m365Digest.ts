/**
 * Microsoft 365 "Daily digest" — one structured rollup of what reached the
 * user over a period (mail, Teams chats, picked Teams channels, calendar
 * invitations), categorized and reduced to action items
 * (docs/M365_DAILY_DIGEST.md).
 *
 * Shared between the server job and the chat card. Every string that came
 * from a mailbox or a chat (titles, previews, sender names) is UNTRUSTED
 * DATA: the card renders it as text, never as markdown or instructions.
 */
import type { DigestPeriodPreset } from '@/lib/services/m365/digest/digestWindow';

export type DigestSourceKind = 'mail' | 'chat' | 'channel' | 'calendar';

export const DIGEST_SOURCE_KINDS: readonly DigestSourceKind[] = [
  'mail',
  'chat',
  'channel',
  'calendar',
] as const;

/**
 * Fixed buckets, so the card is predictable run to run. Themes inside a
 * bucket are model-generated; the bucket itself is checked against
 * deterministic signals (see digestClassify.ts).
 */
export type DigestCategory =
  | 'needsReply'
  | 'askedOfMe'
  | 'waitingOnOthers'
  | 'scheduling'
  | 'companyUpdates'
  | 'fyi'
  | 'bulk';

export const DIGEST_CATEGORIES: readonly DigestCategory[] = [
  'needsReply',
  'askedOfMe',
  'waitingOnOthers',
  'scheduling',
  'companyUpdates',
  'fyi',
  'bulk',
] as const;

export interface DigestChannelRef {
  teamId: string;
  channelId: string;
  /** "Team › Channel" for display. */
  name: string;
}

export interface DigestWindow {
  startIso: string;
  endIso: string;
  preset: DigestPeriodPreset;
}

export interface DigestRequest {
  window: DigestWindow;
  sources: DigestSourceKind[];
  channels: DigestChannelRef[];
}

/** Deterministic facts about an item; the model may explain, never invent. */
export interface DigestItemSignals {
  /** Someone addressed the user and nothing from the user followed. */
  unanswered: boolean;
  /** The user was @mentioned (Teams) or in To: directly (mail). */
  mentionsMe: boolean;
  /** The user wrote last and nobody answered. */
  waitingOnOthers: boolean;
  /** Broadcast-shaped: many recipients, list sender, channel post. */
  broadcast: boolean;
  /** A calendar invitation the user has not responded to. */
  invitation: boolean;
  /** Mail importance high. */
  important: boolean;
  recipients?: number;
  /** Hours since the item (at generation time). */
  ageHours: number;
}

export interface DigestItem {
  /** `${source}:${graph id}` — stable across re-runs of the same window. */
  id: string;
  source: DigestSourceKind;
  category: DigestCategory;
  /** Subject, chat topic or event title. Untrusted text. */
  title: string;
  /** Sender display name. Untrusted text. */
  from: string;
  fromAddress?: string;
  whenIso: string;
  /** ≤ 200 chars of preview text, HTML stripped. Untrusted text. */
  preview: string;
  /** Why it landed in its category (model or heuristic). */
  reason: string;
  signals: DigestItemSignals;
  /** Deep link into Outlook / Teams; absent when Graph gave none. */
  webLink?: string;
  /** Mail only: a reply draft can be proposed for it. */
  conversationId?: string;
  /** Where the item lives, for "ask about this" follow-ups. */
  ref: {
    messageId: string;
    chatId?: string;
    teamId?: string;
    channelId?: string;
    eventId?: string;
  };
}

export interface DigestActionItem {
  id: string;
  /** Imperative task title, ≤ 140 chars. */
  title: string;
  sourceItemId: string;
  askedBy?: string;
  dueHint?: string;
}

export interface DigestTheme {
  title: string;
  summary: string;
  category: DigestCategory;
  itemIds: string[];
}

export type DigestSourceStatus =
  | 'ok'
  | 'partial'
  | 'skipped'
  | 'unavailable'
  | 'error';

export interface DigestSourceReport {
  kind: DigestSourceKind;
  status: DigestSourceStatus;
  /** Messages / events looked at. */
  scanned: number;
  note?: string;
}

export interface CommsDigest {
  version: 1;
  jobId: string;
  generatedAt: string;
  window: DigestWindow;
  channels: DigestChannelRef[];
  sources: DigestSourceReport[];
  items: DigestItem[];
  actionItems: DigestActionItem[];
  themes: DigestTheme[];
  counts: Record<DigestCategory, number>;
  /** Items the mail phishing screen or Teams filters withheld. */
  withheldCount: number;
  /** The utility model was unavailable; categories are heuristic. */
  degraded: boolean;
  /** Plain-text/markdown rendering kept in the message for follow-ups. */
  markdown: string;
}

export type DigestJobStatus = 'pending' | 'processing' | 'succeeded' | 'failed';

export interface DigestJobProgress {
  /** Human-readable current stage ("scanning mail", "classifying"). */
  stage: string;
  sources: DigestSourceReport[];
}

export interface DigestJob {
  jobId: string;
  userId: string;
  status: DigestJobStatus;
  request: DigestRequest;
  progress: DigestJobProgress;
  result?: CommsDigest;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

/** What the chat message carries: the request from the start, the result once done. */
export interface DigestMessageState {
  jobId: string;
  status: DigestJobStatus;
  request: DigestRequest;
  result?: CommsDigest;
  error?: string;
  /** Item ids the user ticked off on the card (local, never sent anywhere). */
  doneItemIds?: string[];
  /** Action items already turned into To Do tasks. */
  createdTaskIds?: string[];
}
