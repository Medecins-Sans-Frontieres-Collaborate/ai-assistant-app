/**
 * Write-side rules for announcements: the strict body schema, the authority
 * check, and every validation that decides whether a record may be stored or
 * published (docs/ADMIN_ANNOUNCEMENTS_DESIGN.md §4, §8, §9).
 *
 * Two kinds of author:
 *  - GLOBAL admins: any audience, any severity, any https link;
 *  - DELEGATED senders (grant `announcements` in an enabled delegation that
 *    offers it): only records of their own delegations, severity ≤ warning, a
 *    shorter window, and links only to allow-listed hosts.
 *
 * Containment is NOT enforced here by rewriting the audience — it is enforced
 * at read time (delivery.ts), where narrowing a delegation takes effect
 * immediately. Here a delegated record simply carries its `delegationId`.
 */
import {
  ACTION_LABEL_CHARS,
  Announcement,
  AnnouncementAudienceSchema,
  AnnouncementVariableSchema,
  AnnouncementsDocument,
  BODY_CHARS,
  MAX_ANNOUNCEMENTS,
  MAX_DELEGATED_WINDOW_DAYS,
  MAX_NON_DISMISSIBLE_HOURS,
  MAX_PUBLISHED_GLOBAL,
  MAX_PUBLISHED_PER_DELEGATION,
  MAX_VARIABLES,
  MAX_WINDOW_DAYS,
  SOURCE_ACTION_LABEL_CHARS,
  SOURCE_BODY_CHARS,
  SOURCE_TITLE_CHARS,
  TITLE_CHARS,
  httpsHostOf,
  sourceHashOf,
  validateLocalizedText,
} from '@/lib/services/announcements/types';
import { DelegatedAdminStatus } from '@/lib/services/delegations/delegationsAdminAuth';
import { DELEGATION_ID_RE } from '@/lib/services/limits/types';

import { getSupportedLocales } from '@/lib/utils/app/locales';

import { z } from 'zod';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const localizedWriteSchema = z
  .object({
    title: z.string().max(TITLE_CHARS),
    body: z.string().max(BODY_CHARS),
    actionLabel: z.string().max(ACTION_LABEL_CHARS).optional(),
    origin: z.enum(['source', 'ai', 'human']),
  })
  .strict();

export const announcementWriteSchema = z
  .object({
    status: z.enum(['draft', 'published', 'withdrawn']),
    severity: z.enum(['info', 'warning', 'critical']).default('info'),
    dismissible: z.boolean().default(true),
    audience: AnnouncementAudienceSchema,
    delegationId: z.string().regex(DELEGATION_ID_RE).optional(),
    visibleFrom: z.string().max(40),
    expiresAt: z.string().max(40),
    hideAfterVariable: z.string().max(24).optional(),
    sourceLocale: z.string().max(10),
    content: z.record(z.string().max(10), localizedWriteSchema),
    variables: z
      .array(AnnouncementVariableSchema)
      .max(MAX_VARIABLES)
      .default([]),
    action: z
      .object({ url: z.string().max(2000) })
      .strict()
      .optional(),
    /** Re-show to readers who already dismissed it (bumps `revision`). */
    notifyAgain: z.boolean().default(false),
    /**
     * Explicit acknowledgements. The editor collects them through its
     * confirmation dialogs; requiring them HERE means no API client can
     * publish to everyone, or publish something readers cannot close, by
     * accident.
     */
    confirmEveryone: z.boolean().default(false),
    confirmNonDismissible: z.boolean().default(false),
  })
  .strict();
export type AnnouncementWrite = z.infer<typeof announcementWriteSchema>;

export interface WriteProblem {
  message: string;
  code: string;
  details?: string;
  status?: number;
}

function problem(
  code: string,
  message: string,
  details?: string,
  status = 400,
): WriteProblem {
  return { code, message, details, status };
}

/**
 * May `status` author under `delegationId` (undefined = org-wide)? One
 * uniform answer for "no such delegation", "not yours" and "disabled", so a
 * delegated sender cannot probe which delegations exist (CWE-203).
 */
export function mayAuthorUnder(
  status: DelegatedAdminStatus,
  delegationId: string | undefined,
): boolean {
  if (status.isGlobalAdmin) return true;
  if (!status.isDelegatedAdmin || !delegationId) return false;
  return status.delegationIds.includes(delegationId);
}

/** Whether `status` may see or touch an existing record. */
export function mayManage(
  status: DelegatedAdminStatus,
  announcement: Pick<Announcement, 'delegationId'>,
): boolean {
  return mayAuthorUnder(status, announcement.delegationId);
}

/**
 * Everything that must hold for `input` to be stored. Publishing rules apply
 * only when `input.status === 'published'`, so a draft can be saved while its
 * link host is still waiting for approval or its translations are incomplete.
 */
export function validateAnnouncementWrite(
  input: AnnouncementWrite,
  context: {
    status: DelegatedAdminStatus;
    document: AnnouncementsDocument;
    /** The record being replaced; undefined for a create. */
    existingId?: string;
  },
): WriteProblem | null {
  const delegated = !context.status.isGlobalAdmin;
  const publishing = input.status === 'published';
  const supported = new Set(getSupportedLocales());

  // Content ---------------------------------------------------------------
  if (!supported.has(input.sourceLocale)) {
    return problem('ANNOUNCEMENT_INVALID', 'Unsupported source language');
  }
  const source = input.content[input.sourceLocale];
  if (!source) {
    return problem(
      'ANNOUNCEMENT_INVALID',
      'Content is missing the source language',
    );
  }
  if (!source.title.trim()) {
    return problem('ANNOUNCEMENT_INVALID', 'A title is required');
  }
  if (
    source.title.length > SOURCE_TITLE_CHARS ||
    source.body.length > SOURCE_BODY_CHARS ||
    (source.actionLabel ?? '').length > SOURCE_ACTION_LABEL_CHARS
  ) {
    return problem(
      'ANNOUNCEMENT_TOO_LONG',
      'Source text exceeds the length limits',
      `title ≤ ${SOURCE_TITLE_CHARS}, body ≤ ${SOURCE_BODY_CHARS}, link label ≤ ${SOURCE_ACTION_LABEL_CHARS}`,
    );
  }

  // Variables -------------------------------------------------------------
  const names = input.variables.map((v) => v.name);
  const duplicate = names.find((name, i) => names.indexOf(name) !== i);
  if (duplicate) {
    return problem(
      'ANNOUNCEMENT_INVALID',
      'Duplicate variable name',
      duplicate,
    );
  }
  for (const variable of input.variables) {
    if (
      variable.type === 'timeRange' &&
      Date.parse(variable.from) >= Date.parse(variable.to)
    ) {
      return problem(
        'ANNOUNCEMENT_INVALID',
        'A time range must end after it starts',
        variable.name,
      );
    }
  }
  if (input.hideAfterVariable) {
    const target = input.variables.find(
      (v) => v.name === input.hideAfterVariable,
    );
    if (!target || target.type === 'date') {
      return problem(
        'ANNOUNCEMENT_INVALID',
        'hideAfterVariable must name a time or time-range variable',
      );
    }
  }

  for (const [locale, content] of Object.entries(input.content)) {
    if (!supported.has(locale)) {
      return problem('ANNOUNCEMENT_INVALID', 'Unsupported language', locale);
    }
    const isSource = locale === input.sourceLocale;
    const fields: Array<['title' | 'body' | 'actionLabel', string]> = [
      ['title', content.title],
      ['body', content.body],
      ['actionLabel', content.actionLabel ?? ''],
    ];
    for (const [field, text] of fields) {
      const complaint = validateLocalizedText(
        text,
        names,
        isSource ? undefined : (source[field] ?? ''),
      );
      if (complaint) {
        return problem(
          'ANNOUNCEMENT_PLACEHOLDERS',
          'A text has invalid variables',
          `${locale}.${field}: ${complaint}`,
        );
      }
    }
  }

  // Window ----------------------------------------------------------------
  const from = Date.parse(input.visibleFrom);
  const until = Date.parse(input.expiresAt);
  if (Number.isNaN(from) || Number.isNaN(until) || until <= from) {
    return problem(
      'ANNOUNCEMENT_WINDOW',
      'The expiry must be after the start of visibility',
    );
  }
  const maxDays = delegated ? MAX_DELEGATED_WINDOW_DAYS : MAX_WINDOW_DAYS;
  if (until - from > maxDays * DAY_MS) {
    return problem(
      'ANNOUNCEMENT_WINDOW',
      `An announcement may be visible for at most ${maxDays} days`,
    );
  }
  if (
    !input.dismissible &&
    until - from > MAX_NON_DISMISSIBLE_HOURS * HOUR_MS
  ) {
    return problem(
      'ANNOUNCEMENT_WINDOW',
      `A non-dismissible announcement may be visible for at most ${MAX_NON_DISMISSIBLE_HOURS} hours`,
    );
  }

  // Link ------------------------------------------------------------------
  if (input.action) {
    const host = httpsHostOf(input.action.url);
    if (!host) {
      return problem(
        'ANNOUNCEMENT_LINK',
        'The link must be an https URL without credentials',
      );
    }
    if (!source.actionLabel?.trim()) {
      return problem('ANNOUNCEMENT_LINK', 'A link needs a label');
    }
    if (
      delegated &&
      publishing &&
      !context.document.allowedLinkHosts.includes(host)
    ) {
      return problem(
        'ANNOUNCEMENT_HOST_NOT_ALLOWED',
        'This link host has not been approved yet. Save as a draft and ask a global admin to allow it.',
        host,
      );
    }
  }

  // Authority-dependent rules -----------------------------------------------
  if (delegated && input.severity === 'critical') {
    return problem(
      'ANNOUNCEMENT_FORBIDDEN_SEVERITY',
      'Only global admins can publish critical announcements',
      undefined,
      403,
    );
  }
  if (publishing && !input.dismissible && !input.confirmNonDismissible) {
    return problem(
      'ANNOUNCEMENT_CONFIRM_NON_DISMISSIBLE',
      'Publishing a non-dismissible announcement needs explicit confirmation',
    );
  }
  if (
    publishing &&
    !input.delegationId &&
    input.audience.kind === 'everyone' &&
    !input.confirmEveryone
  ) {
    return problem(
      'ANNOUNCEMENT_CONFIRM_EVERYONE',
      'Publishing to everyone needs explicit confirmation',
    );
  }

  // Caps --------------------------------------------------------------------
  const others = context.document.announcements.filter(
    (a) => a.id !== context.existingId,
  );
  if (!context.existingId && others.length >= MAX_ANNOUNCEMENTS) {
    return problem(
      'ANNOUNCEMENT_CAP',
      'Too many announcements are stored; delete old ones first',
    );
  }
  if (publishing) {
    const now = Date.now();
    const livePeers = others.filter(
      (a) =>
        a.status === 'published' &&
        Date.parse(a.expiresAt) > now &&
        a.delegationId === input.delegationId,
    ).length;
    const cap = input.delegationId
      ? MAX_PUBLISHED_PER_DELEGATION
      : MAX_PUBLISHED_GLOBAL;
    if (livePeers >= cap) {
      return problem(
        'ANNOUNCEMENT_CAP',
        `At most ${cap} announcements can be published at once here`,
      );
    }
  }
  return null;
}

/** Assembles the stored record from a validated body. */
export function toStoredAnnouncement(
  input: AnnouncementWrite,
  id: string,
  existing: Announcement | undefined,
  userMail: string,
  now: string,
): Announcement {
  const source = input.content[input.sourceLocale];
  const hash = sourceHashOf(source);
  const content: Announcement['content'] = {};
  for (const [locale, value] of Object.entries(input.content)) {
    const isSource = locale === input.sourceLocale;
    const previous = existing?.content[locale];
    const unchanged =
      previous !== undefined &&
      previous.title === value.title &&
      previous.body === value.body &&
      (previous.actionLabel ?? '') === (value.actionLabel ?? '');
    content[locale] = {
      title: value.title.trim(),
      body: value.body.trim(),
      ...(value.actionLabel?.trim()
        ? { actionLabel: value.actionLabel.trim() }
        : {}),
      origin: isSource ? 'source' : value.origin,
      // A translation left untouched keeps the hash it was MADE from, so a
      // later source edit shows it as stale; a new or edited one is current.
      sourceHash: isSource || !unchanged ? hash : previous.sourceHash,
    };
  }
  return {
    id,
    revision:
      (existing?.revision ?? 1) + (input.notifyAgain && existing ? 1 : 0),
    status: input.status,
    severity: input.severity,
    dismissible: input.dismissible,
    audience: input.audience,
    // Authority never moves: a record stays under the delegation (or the
    // global tier) it was created in.
    ...(existing
      ? existing.delegationId
        ? { delegationId: existing.delegationId }
        : {}
      : input.delegationId
        ? { delegationId: input.delegationId }
        : {}),
    visibleFrom: new Date(input.visibleFrom).toISOString(),
    expiresAt: new Date(input.expiresAt).toISOString(),
    ...(input.hideAfterVariable
      ? { hideAfterVariable: input.hideAfterVariable }
      : {}),
    sourceLocale: input.sourceLocale,
    content,
    variables: input.variables,
    ...(input.action ? { action: { url: input.action.url } } : {}),
    createdBy: existing?.createdBy ?? userMail,
    createdAt: existing?.createdAt ?? now,
    updatedBy: userMail,
    updatedAt: now,
  };
}
