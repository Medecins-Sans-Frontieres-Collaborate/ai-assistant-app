/**
 * Admin announcements (docs/ADMIN_ANNOUNCEMENTS_DESIGN.md).
 *
 * Banner messages admins publish from the admin area: an audience, a
 * visibility window, typed variables (times stored as DATA and rendered in
 * the reader's locale and timezone), one localized text per language, and an
 * optional labelled link.
 *
 * ONE document, not a blob per announcement: the read path is hot (every
 * open client polls it through /api/version), the set is small and capped,
 * and one CAS'd document is what the other admin areas already do.
 *
 * Client-importable: no server-only imports — the admin editor and the banner
 * value-import these schemas and helpers.
 */
import {
  DELEGATION_ID_RE,
  JurisdictionPredicateSchema,
  limitsBlobVariant,
} from '@/lib/services/limits/types';

import { z } from 'zod';

export const ANNOUNCEMENT_ID_RE = /^ann-[0-9a-f]{12}$/;

// Source-text caps are LOWER than the stored caps: translations run 30-40 %
// longer than English, and every locale must still fit the stored caps.
export const SOURCE_TITLE_CHARS = 70;
export const SOURCE_BODY_CHARS = 240;
export const SOURCE_ACTION_LABEL_CHARS = 28;
export const TITLE_CHARS = 90;
export const BODY_CHARS = 320;
export const ACTION_LABEL_CHARS = 40;

export const MAX_ANNOUNCEMENTS = 50;
export const MAX_PUBLISHED_GLOBAL = 10;
export const MAX_PUBLISHED_PER_DELEGATION = 3;
export const MAX_VARIABLES = 6;
export const MAX_ALLOWED_HOSTS = 100;
export const MAX_WINDOW_DAYS = 30;
export const MAX_DELEGATED_WINDOW_DAYS = 14;
export const MAX_NON_DISMISSIBLE_HOURS = 72;

const PREFIX = 'system/announcements/';

/** Beta shares the admin container with prod — same suffix rule as limits. */
export function announcementsBlobPaths(variant: 'beta' | null): {
  documentPath: string;
  historyPrefix: string;
} {
  const suffix = variant ? `.${variant}` : '';
  return {
    documentPath: `${PREFIX}announcements${suffix}.json`,
    historyPrefix: `${PREFIX}history${suffix}/`,
  };
}

const ACTIVE_PATHS = announcementsBlobPaths(limitsBlobVariant());
export const ANNOUNCEMENTS_DOCUMENT_PATH = ACTIVE_PATHS.documentPath;
export const ANNOUNCEMENTS_HISTORY_PREFIX = ACTIVE_PATHS.historyPrefix;

export function announcementsHistoryBlobPath(
  updatedAt: string,
  updatedBy: string,
  announcementId: string,
): string {
  const stamp = updatedAt.replace(/[:.]/g, '-');
  const who = updatedBy.replace(/[^a-z0-9@._-]/gi, '_');
  return `${ANNOUNCEMENTS_HISTORY_PREFIX}${stamp}_${who}_${announcementId}.json`;
}

export const VARIABLE_NAME_RE = /^[a-z][a-zA-Z0-9]{0,23}$/;

const isoInstant = z
  .string()
  .max(40)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Invalid instant');

/**
 * Times are DATA, never free text: "between 1400 UTC and 1800 UTC on October
 * 12" is unreadable in Dhaka and cannot be translated reliably. The body holds
 * `{window}`; the reader's browser renders it in their locale and timezone.
 */
export const AnnouncementVariableSchema = z.discriminatedUnion('type', [
  z.object({
    name: z.string().regex(VARIABLE_NAME_RE),
    type: z.literal('instant'),
    at: isoInstant,
  }),
  z.object({
    name: z.string().regex(VARIABLE_NAME_RE),
    type: z.literal('timeRange'),
    from: isoInstant,
    to: isoInstant,
  }),
  z.object({
    name: z.string().regex(VARIABLE_NAME_RE),
    type: z.literal('date'),
    on: isoInstant,
  }),
]);
export type AnnouncementVariable = z.infer<typeof AnnouncementVariableSchema>;

export const LocalizedContentSchema = z
  .object({
    title: z.string().max(TITLE_CHARS),
    body: z.string().max(BODY_CHARS),
    actionLabel: z.string().max(ACTION_LABEL_CHARS).optional(),
    /** 'source' = written by the admin in `sourceLocale`. */
    origin: z.enum(['source', 'ai', 'human']),
    /** Hash of the source content this was produced from → staleness. */
    sourceHash: z.string().max(64),
  })
  .passthrough();
export type LocalizedContent = z.infer<typeof LocalizedContentSchema>;

export const AnnouncementAudienceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('everyone') }),
  z.object({
    kind: z.literal('targeted'),
    /** OR'd, the limits targeting vocabulary (`matchesPrincipal`). */
    predicates: z.array(JurisdictionPredicateSchema).min(1).max(50),
  }),
]);
export type AnnouncementAudience = z.infer<typeof AnnouncementAudienceSchema>;

export const AnnouncementSchema = z
  .object({
    id: z.string().regex(ANNOUNCEMENT_ID_RE),
    /** Bumped by "notify again"; dismissals are keyed `id:revision`. */
    revision: z.number().int().min(1).default(1),
    status: z.enum(['draft', 'published', 'withdrawn']),
    severity: z.enum(['info', 'warning', 'critical']).default('info'),
    dismissible: z.boolean().default(true),
    audience: AnnouncementAudienceSchema,
    /**
     * Present on a DELEGATED announcement. Authority is derived from it,
     * never from `createdBy`: it is delivered only to readers inside that
     * delegation's jurisdiction, and only while the delegation is enabled and
     * still offers the `announcements` capability.
     */
    delegationId: z.string().regex(DELEGATION_ID_RE).optional(),
    visibleFrom: isoInstant,
    /** Hard stop: nobody sees it afterwards, seen before or not. */
    expiresAt: isoInstant,
    /**
     * Names an `instant` or `timeRange` variable: once that instant (or the
     * range's end) has passed the announcement stops being delivered — the
     * maintenance is over, the banner is gone — without the admin computing
     * `expiresAt` by hand.
     */
    hideAfterVariable: z.string().regex(VARIABLE_NAME_RE).optional(),
    /** The language the admin wrote in. Never assumed to be English. */
    sourceLocale: z.string().max(10),
    /** Keyed by locale; always contains `sourceLocale`. */
    content: z.record(z.string().max(10), LocalizedContentSchema),
    variables: z
      .array(AnnouncementVariableSchema)
      .max(MAX_VARIABLES)
      .default([]),
    /** The label is localized content (`actionLabel`). https only. */
    action: z.object({ url: z.string().url().max(2000) }).optional(),
    createdBy: z.string(),
    createdAt: z.string(),
    updatedBy: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();
export type Announcement = z.infer<typeof AnnouncementSchema>;

export const AnnouncementsDocumentSchema = z
  .object({
    version: z.literal(1),
    announcements: z
      .array(AnnouncementSchema)
      .max(MAX_ANNOUNCEMENTS)
      .default([]),
    /**
     * Hosts a DELEGATED sender may link to (exact host match, lowercased).
     * Global admins may link anywhere; they manage this list, and can add a
     * host straight from a delegated announcement that is waiting on it.
     */
    allowedLinkHosts: z
      .array(z.string().max(253))
      .max(MAX_ALLOWED_HOSTS)
      .default([]),
    updatedBy: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();
export type AnnouncementsDocument = z.infer<typeof AnnouncementsDocumentSchema>;

export const AnnouncementsHistoryEntrySchema = z.object({
  version: z.literal(1),
  action: z.enum(['upsert', 'withdraw', 'delete', 'allow-host', 'remove-host']),
  announcement: AnnouncementSchema.nullable(),
  host: z.string().optional(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type AnnouncementsHistoryEntry = z.infer<
  typeof AnnouncementsHistoryEntrySchema
>;

/** Lowercased host of an https URL; null for anything else. */
export function httpsHostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The instant after which `hideAfterVariable` retires the announcement. */
export function hideAfterInstant(
  announcement: Pick<Announcement, 'hideAfterVariable' | 'variables'>,
): number | null {
  if (!announcement.hideAfterVariable) return null;
  const variable = announcement.variables.find(
    (v) => v.name === announcement.hideAfterVariable,
  );
  if (!variable) return null;
  const at =
    variable.type === 'instant'
      ? variable.at
      : variable.type === 'timeRange'
        ? variable.to
        : null;
  if (at === null) return null;
  const time = Date.parse(at);
  return Number.isNaN(time) ? null : time;
}

/** Published, inside its window, and its event (if any) not over yet. */
export function isLive(announcement: Announcement, now: number): boolean {
  if (announcement.status !== 'published') return false;
  const from = Date.parse(announcement.visibleFrom);
  const until = Date.parse(announcement.expiresAt);
  if (Number.isNaN(from) || Number.isNaN(until)) return false;
  if (now < from || now >= until) return false;
  const hideAfter = hideAfterInstant(announcement);
  return hideAfter === null || now < hideAfter;
}

/**
 * Stable hash of the source content — what a translation was made FROM. Not
 * cryptographic: it only has to change when the text does. (FNV-1a, so the
 * same function runs in the browser editor and on the server.)
 */
export function sourceHashOf(content: {
  title: string;
  body: string;
  actionLabel?: string;
}): string {
  const text = `${content.title}\u0000${content.body}\u0000${content.actionLabel ?? ''}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** `{name}` placeholders used in a text, in order of first appearance. */
export function placeholdersOf(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(/\{([^{}]*)\}/g)) {
    const name = match[1].trim();
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Why a localized text cannot be stored, or null when it can: braces must
 * balance, every placeholder must be a declared variable, and a translation
 * must carry exactly the source's placeholders — a dropped or renamed
 * `{window}` would publish a message with a hole in it.
 */
export function validateLocalizedText(
  text: string,
  variableNames: readonly string[],
  sourceText?: string,
): string | null {
  let depth = 0;
  for (const char of text) {
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth < 0 || depth > 1) return 'Unbalanced or nested braces';
  }
  if (depth !== 0) return 'Unbalanced braces';
  const used = placeholdersOf(text);
  const unknown = used.find((name) => !variableNames.includes(name));
  if (unknown !== undefined) return `Unknown variable {${unknown}}`;
  if (sourceText !== undefined) {
    const expected = placeholdersOf(sourceText);
    const missing = expected.find((name) => !used.includes(name));
    if (missing) return `Missing variable {${missing}}`;
    const extra = used.find((name) => !expected.includes(name));
    if (extra) return `Unexpected variable {${extra}}`;
  }
  return null;
}
