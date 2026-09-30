/**
 * Editor-side draft of one announcement and its conversions to/from the
 * stored record. Pure, so the round-trip is testable without rendering.
 */
import {
  Announcement,
  AnnouncementVariable,
  sourceHashOf,
} from '@/lib/services/announcements/types';
import { AnnouncementWrite } from '@/lib/services/announcements/writePath';

import {
  PredicateDraft,
  targetsToText,
  textToTargets,
} from '@/components/Admin/Delegations/PredicateListEditor';

export interface LocalizedDraft {
  title: string;
  body: string;
  actionLabel: string;
  origin: 'source' | 'ai' | 'human';
  /** Hash of the source this text was made from; '' for a fresh one. */
  sourceHash: string;
}

export interface AnnouncementDraft {
  id?: string;
  status: Announcement['status'];
  severity: Announcement['severity'];
  dismissible: boolean;
  everyone: boolean;
  predicates: PredicateDraft[];
  delegationId: string;
  visibleFrom: string;
  expiresAt: string;
  hideAfterVariable: string;
  sourceLocale: string;
  content: Record<string, LocalizedDraft>;
  variables: AnnouncementVariable[];
  actionUrl: string;
  notifyAgain: boolean;
}

const HOUR_MS = 3_600_000;

export function emptyDraft(
  sourceLocale: string,
  delegationId: string,
  now: number = Date.now(),
): AnnouncementDraft {
  return {
    status: 'draft',
    severity: 'info',
    dismissible: true,
    everyone: true,
    predicates: [],
    delegationId,
    visibleFrom: new Date(now).toISOString(),
    expiresAt: new Date(now + 7 * 24 * HOUR_MS).toISOString(),
    hideAfterVariable: '',
    sourceLocale,
    content: {
      [sourceLocale]: {
        title: '',
        body: '',
        actionLabel: '',
        origin: 'source',
        sourceHash: '',
      },
    },
    variables: [],
    actionUrl: '',
    notifyAgain: false,
  };
}

export function draftFromAnnouncement(
  announcement: Announcement,
): AnnouncementDraft {
  const content: Record<string, LocalizedDraft> = {};
  for (const [locale, value] of Object.entries(announcement.content)) {
    content[locale] = {
      title: value.title,
      body: value.body,
      actionLabel: value.actionLabel ?? '',
      origin: value.origin,
      sourceHash: value.sourceHash,
    };
  }
  return {
    id: announcement.id,
    status: announcement.status,
    severity: announcement.severity,
    dismissible: announcement.dismissible,
    everyone: announcement.audience.kind === 'everyone',
    predicates:
      announcement.audience.kind === 'targeted'
        ? announcement.audience.predicates.map((predicate) => ({
            scope: predicate.scope,
            text: targetsToText(predicate.targets),
          }))
        : [],
    delegationId: announcement.delegationId ?? '',
    visibleFrom: announcement.visibleFrom,
    expiresAt: announcement.expiresAt,
    hideAfterVariable: announcement.hideAfterVariable ?? '',
    sourceLocale: announcement.sourceLocale,
    content,
    variables: announcement.variables,
    actionUrl: announcement.action?.url ?? '',
    notifyAgain: false,
  };
}

export function sourceOf(draft: AnnouncementDraft): LocalizedDraft {
  return (
    draft.content[draft.sourceLocale] ?? {
      title: '',
      body: '',
      actionLabel: '',
      origin: 'source',
      sourceHash: '',
    }
  );
}

export function currentSourceHash(draft: AnnouncementDraft): string {
  const source = sourceOf(draft);
  return sourceHashOf({
    title: source.title.trim(),
    body: source.body.trim(),
    ...(source.actionLabel.trim()
      ? { actionLabel: source.actionLabel.trim() }
      : {}),
  });
}

export type LocaleState = 'source' | 'missing' | 'stale' | 'ai' | 'human';

/** How a locale stands relative to the CURRENT source text. */
export function localeState(
  draft: AnnouncementDraft,
  locale: string,
): LocaleState {
  if (locale === draft.sourceLocale) return 'source';
  const content = draft.content[locale];
  if (!content || !content.title.trim()) return 'missing';
  if (content.sourceHash && content.sourceHash !== currentSourceHash(draft)) {
    return 'stale';
  }
  return content.origin === 'human' ? 'human' : 'ai';
}

export function toWriteBody(
  draft: AnnouncementDraft,
  status: Announcement['status'],
  confirmations: { everyone: boolean; nonDismissible: boolean },
): AnnouncementWrite {
  const content: AnnouncementWrite['content'] = {};
  for (const [locale, value] of Object.entries(draft.content)) {
    if (locale !== draft.sourceLocale && !value.title.trim()) continue;
    content[locale] = {
      title: value.title.trim(),
      body: value.body.trim(),
      ...(value.actionLabel.trim()
        ? { actionLabel: value.actionLabel.trim() }
        : {}),
      origin: locale === draft.sourceLocale ? 'source' : value.origin,
    };
  }
  const predicates = draft.predicates
    .map((predicate) => ({
      scope: predicate.scope,
      targets: textToTargets(predicate.text).map((t) => t.toLowerCase()),
    }))
    .filter((predicate) => predicate.targets.length > 0);
  return {
    status,
    severity: draft.severity,
    dismissible: draft.dismissible,
    audience:
      draft.everyone || predicates.length === 0
        ? { kind: 'everyone' }
        : { kind: 'targeted', predicates },
    ...(draft.delegationId ? { delegationId: draft.delegationId } : {}),
    visibleFrom: draft.visibleFrom,
    expiresAt: draft.expiresAt,
    ...(draft.hideAfterVariable
      ? { hideAfterVariable: draft.hideAfterVariable }
      : {}),
    sourceLocale: draft.sourceLocale,
    content,
    variables: draft.variables,
    ...(draft.actionUrl.trim()
      ? { action: { url: draft.actionUrl.trim() } }
      : {}),
    notifyAgain: draft.notifyAgain,
    confirmEveryone: confirmations.everyone,
    confirmNonDismissible: confirmations.nonDismissible,
  };
}

/**
 * A new variable with a sensible default (tomorrow, on the hour) and a name
 * no other variable uses.
 */
export function newVariable(
  type: AnnouncementVariable['type'],
  existingNames: readonly string[],
  now: number = Date.now(),
): AnnouncementVariable {
  const base =
    type === 'timeRange' ? 'window' : type === 'date' ? 'day' : 'time';
  let name = base;
  for (let i = 2; existingNames.includes(name); i++) name = `${base}${i}`;
  const start = new Date(now + 24 * HOUR_MS);
  start.setMinutes(0, 0, 0);
  const end = new Date(start.getTime() + 2 * HOUR_MS);
  if (type === 'timeRange') {
    return { name, type, from: start.toISOString(), to: end.toISOString() };
  }
  if (type === 'date') {
    return {
      name,
      type,
      on: `${start.toISOString().slice(0, 10)}T00:00:00.000Z`,
    };
  }
  return { name, type, at: start.toISOString() };
}

/** `datetime-local` value (admin's own timezone) for an ISO instant. */
export function toLocalInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** ISO instant for a `datetime-local` value; '' when it cannot be parsed. */
export function fromLocalInput(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}
