/**
 * Usage visibility for the effective-limits preview (design §6c).
 *
 * `/api/limits/me?as=<mail>&usage=1` wants "how much has this person already
 * consumed". Counters are keyed by Entra oid, the preview is keyed by mail,
 * and mail ≠ UPN in real tenants (aliases, renamed users) — so the oid is
 * looked up with the CALLER's delegated `User.Read.All` token via
 * `/users?$filter=mail eq '…'` (never the `/users/{mail}` path form, which
 * only accepts an oid or a UPN), falling back to the UPN path when the filter
 * finds nobody.
 *
 * Never throws. Every failure — no consent, no such user, an ambiguous mail,
 * a counter-storage outage — answers `usageUnavailable: true` with a reason,
 * because the preview is a convenience and a counter outage must never turn
 * it into a 500. One Graph token mint per call, never one per limit key.
 *
 * Server-only: `graphApi` is imported lazily, as groupMembership.ts does, so
 * next-auth stays out of the module graph until a lookup actually runs.
 */
import { NextRequest } from 'next/server';

import { readUsage } from '@/lib/services/limits/usageStore';
import {
  escapeODataLiteral,
  isValidEmail,
} from '@/lib/services/m365/tools/shared';

import { BlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

export type UsageWindow = 'day' | 'month' | 'total';

export interface UsageCell {
  used: number;
  window: UsageWindow;
}

export type UsageUnavailableReason =
  | 'invalid_mail'
  | 'not_found'
  | 'ambiguous'
  | 'not_connected'
  | 'consent_missing'
  | 'forbidden'
  | 'rate_limited'
  | 'graph_error'
  | 'storage_error';

export type UsageLookupResult =
  | {
      usageUnavailable: false;
      /** Counter cell → consumption, tagged with the window the cell lives in. */
      usage: Record<string, UsageCell>;
      subjectId: string;
    }
  | { usageUnavailable: true; reason: UsageUnavailableReason };

export type SubjectLookupResult =
  | { subjectId: string }
  | { reason: Exclude<UsageUnavailableReason, 'storage_error'> };

const DIRECTORY_SCOPES = ['User.Read.All'];

const GRAPH_ERROR_KINDS: ReadonlySet<string> = new Set([
  'not_connected',
  'consent_missing',
  'not_found',
  'forbidden',
  'rate_limited',
  'graph_error',
]);

/**
 * Classifies by `name` + `kind` rather than `instanceof`: the real class sits
 * behind the lazy import, and tests substitute a structurally identical
 * error.
 */
function graphErrorKind(error: unknown): UsageUnavailableReason | null {
  if (!(error instanceof Error) || error.name !== 'M365Error') return null;
  const kind = (error as Error & { kind?: unknown }).kind;
  return typeof kind === 'string' && GRAPH_ERROR_KINDS.has(kind)
    ? (kind as UsageUnavailableReason)
    : 'graph_error';
}

interface GraphUserId {
  id?: unknown;
}

/**
 * Resolves a mail to an Entra oid with the caller's delegated token. Exactly
 * one filter hit wins; zero hits fall back to the UPN path; two hits are
 * `ambiguous` rather than a guess.
 */
export async function resolveSubjectIdByMail(
  req: NextRequest,
  mail: string,
): Promise<SubjectLookupResult> {
  const normalized = mail.trim().toLowerCase();
  if (!isValidEmail(normalized)) return { reason: 'invalid_mail' };

  const { graphJson } = await import('@/lib/services/m365/graphApi');
  try {
    const filtered = await graphJson<{ value?: GraphUserId[] }>(
      req,
      DIRECTORY_SCOPES,
      `/users?$filter=${encodeURIComponent(
        `mail eq '${escapeODataLiteral(normalized)}'`,
      )}&$select=id&$top=2`,
    );
    const hits = (filtered.value ?? []).filter(
      (u): u is { id: string } => typeof u.id === 'string' && u.id.length > 0,
    );
    if (hits.length === 1) return { subjectId: hits[0].id };
    if (hits.length > 1) return { reason: 'ambiguous' };

    // Filter found nobody: the mail may still be the UPN.
    const byUpn = await graphJson<GraphUserId>(
      req,
      DIRECTORY_SCOPES,
      `/users/${encodeURIComponent(normalized)}?$select=id`,
    );
    return typeof byUpn.id === 'string' && byUpn.id.length > 0
      ? { subjectId: byUpn.id }
      : { reason: 'not_found' };
  } catch (error) {
    const kind = graphErrorKind(error);
    if (kind && kind !== 'storage_error') return { reason: kind };
    console.warn(
      `[limits-admin] usage lookup: directory query failed: ${sanitizeForLog(error)}`,
    );
    return { reason: 'graph_error' };
  }
}

export interface UsageLookupOptions {
  /** The policy's org-wide zone — period keys must match the ones enforcement writes. */
  timezone: string;
  storage?: BlobStorage;
  now?: Date;
}

/**
 * The previewed subject's current day + month counters, keyed by cell name
 * and tagged with their window. A cell already seen in the day ledger is not
 * overwritten by the month ledger (the two are disjoint today; the guard
 * keeps the day reading if a key is ever counted in both).
 */
export async function lookupUsage(
  req: NextRequest,
  mail: string,
  options: UsageLookupOptions,
): Promise<UsageLookupResult> {
  const subject = await resolveSubjectIdByMail(req, mail);
  if (!('subjectId' in subject)) {
    return { usageUnavailable: true, reason: subject.reason };
  }

  const readOptions = {
    timezone: options.timezone,
    ...(options.storage ? { storage: options.storage } : {}),
    ...(options.now ? { now: options.now } : {}),
  };
  try {
    const [day, month] = await Promise.all([
      readUsage(subject.subjectId, 'day', readOptions),
      readUsage(subject.subjectId, 'month', readOptions),
    ]);
    const usage: Record<string, UsageCell> = {};
    for (const [cell, used] of Object.entries(day)) {
      usage[cell] = { used, window: 'day' };
    }
    for (const [cell, used] of Object.entries(month)) {
      if (!(cell in usage)) usage[cell] = { used, window: 'month' };
    }
    return { usageUnavailable: false, usage, subjectId: subject.subjectId };
  } catch (error) {
    console.warn(
      `[limits-admin] usage lookup: counter read failed: ${sanitizeForLog(error)}`,
    );
    return { usageUnavailable: true, reason: 'storage_error' };
  }
}
