/**
 * The one place that turns "policy + principal" into an allow/deny decision.
 *
 * Every enforcement point in the app goes through `checkLimits` (ceilings and
 * boolean gates, no storage) or `reserveLimits` (counters, one CAS), so the
 * observe/enforce switch, the audit line, and the fail-open behaviour cannot
 * drift between call sites.
 *
 * See docs/LIMITS.md.
 */
import { LimitsService } from '@/lib/services/limits/LimitsService';
import { periodKindForWindow, resetAt } from '@/lib/services/limits/periods';
import { Principal } from '@/lib/services/limits/principal';
import {
  ResolvedLimit,
  isBlocked,
  isUnlimited,
  resolveLimit,
  resolveModelCells,
} from '@/lib/services/limits/resolver';
import { LimitsPolicy } from '@/lib/services/limits/types';

import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import {
  LIMIT_DEFINITIONS,
  LimitDefinition,
  getLimitDefinition,
} from '@/config/limits';

export interface LimitDenial {
  limitKey: string;
  /** The configured cap that was hit (a number, or false for a hard gate). */
  limit: number | false;
  /** Consumption before this request; omitted for ceilings and gates. */
  used?: number;
  /** ISO instant the window rolls over; omitted for non-windowed limits. */
  resetAt?: string;
  /** Which layer produced the winning value — shown to admins, not users. */
  source: ResolvedLimit['source'];
  modelId?: string;
  series?: string;
}

export interface LimitCheckResult {
  /** False only in `enforce` mode; `observe` always allows. */
  allowed: boolean;
  /** Present whenever a limit was hit, even in observe mode. */
  denial?: LimitDenial;
  /** True when the decision would have blocked but observe mode let it pass. */
  observedOnly?: boolean;
}

export const ALLOWED: LimitCheckResult = { allowed: true };

/**
 * Structured audit line for every decision that hit a limit. Sanitized
 * against log injection. In observe mode this is the ENTIRE product: an admin
 * authors a policy, watches these lines against real org data, then flips to
 * enforce.
 */
export function emitLimitAudit(
  decision: 'block' | 'would-block',
  principal: Principal,
  denial: LimitDenial,
): void {
  console.log(
    `[limits-audit] decision=${decision} key=${sanitizeForLog(denial.limitKey)} ` +
      `limit=${denial.limit} used=${denial.used ?? '<n/a>'} ` +
      `source=${sanitizeForLog(denial.source)} ` +
      `user=${sanitizeForLog(principal.mail ?? principal.userId ?? '<none>')}` +
      (denial.modelId ? ` model=${sanitizeForLog(denial.modelId)}` : '') +
      (denial.series ? ` family=${sanitizeForLog(denial.series)}` : ''),
  );
}

/**
 * Applies the observe/enforce switch to a raw denial. Kept separate from
 * detection so every call site reports identically and only the decision
 * differs.
 */
export function applyMode(
  policy: LimitsPolicy | null,
  principal: Principal,
  denial: LimitDenial | undefined,
): LimitCheckResult {
  if (!denial) return ALLOWED;
  const mode = policy?.mode ?? 'observe';
  if (mode === 'observe') {
    emitLimitAudit('would-block', principal, denial);
    return { allowed: true, denial, observedOnly: true };
  }
  emitLimitAudit('block', principal, denial);
  return { allowed: false, denial };
}

/**
 * The sentence a USER sees when a limit stops them.
 *
 * Built from the catalog's `unit`/`window` rather than the limit key, because
 * the key is an internal identifier — `Usage limit reached:
 * chat.messagesPerDay` is not a message anyone should be shown. Deliberately
 * never names the override or layer that produced the cap either: that is
 * admin-facing provenance and belongs in the audit log, not in front of the
 * person who hit it.
 *
 * Server-side English, matching every other PipelineError message in the app
 * (e.g. 'Request body too large (max 10MB)').
 */
export function denialMessage(denial: LimitDenial): string {
  const def = getLimitDefinition(denial.limitKey);
  const resets = denial.resetAt
    ? ` Resets ${new Date(denial.resetAt).toUTCString()}.`
    : '';

  // Boolean gates: something has been switched off, not run down.
  if (denial.limit === false) {
    if (denial.limitKey === 'model.allowed') {
      return 'This model is not available on your account. Choose a different model, or contact your administrator.';
    }
    return 'This feature has been turned off for your account by an administrator.';
  }

  const unit = def && def.unit !== 'boolean' ? ` ${def.unit}` : '';

  // Per-request ceilings are about THIS request being too big, not about a
  // budget being used up — telling someone to "try again later" would be
  // actively misleading, since waiting changes nothing.
  if (def?.kind === 'ceiling') {
    return `This request exceeds the maximum of ${denial.limit}${unit} allowed per request.`;
  }

  const window = def?.window === 'month' ? 'this month' : 'today';
  return `You've reached your limit of ${denial.limit}${unit} ${window}.${resets}`;
}

function denialFor(resolved: ResolvedLimit, timezone: string): LimitDenial {
  const periodKind = periodKindForWindow(resolved.window);
  return {
    limitKey: resolved.limitKey,
    limit: resolved.value === false ? false : (resolved.value as number),
    source: resolved.source,
    ...(periodKind ? { resetAt: resetAt(periodKind, timezone) } : {}),
    ...(resolved.modelId ? { modelId: resolved.modelId } : {}),
    ...(resolved.series ? { series: resolved.series } : {}),
  };
}

/** True when a boolean gate resolved to "blocked". */
export function checkGate(
  policy: LimitsPolicy | null,
  principal: Principal,
  limitKey: string,
  modelId?: string,
  series?: string,
): LimitCheckResult {
  const def = getLimitDefinition(limitKey);
  if (!def) return ALLOWED;

  // A per-model gate is checked on BOTH the model cell and the family cell:
  // either one saying "blocked" blocks. A family gate is an envelope.
  const cells = def.perModel
    ? resolveModelCells(def, policy, principal, modelId, series)
    : [resolveLimit(def, policy, principal)];
  // A per-model key with no model context still has a global answer.
  if (cells.length === 0) cells.push(resolveLimit(def, policy, principal));

  for (const cell of cells) {
    if (isBlocked(cell)) {
      return applyMode(
        policy,
        principal,
        denialFor(cell, policy?.timezone ?? 'UTC'),
      );
    }
  }
  return ALLOWED;
}

/**
 * A per-request maximum. `amount` is the size of THIS request in the limit's
 * unit; no counter and no storage is involved.
 */
export function checkCeiling(
  policy: LimitsPolicy | null,
  principal: Principal,
  limitKey: string,
  amount: number,
): LimitCheckResult {
  const def = getLimitDefinition(limitKey);
  if (!def) return ALLOWED;
  const resolved = resolveLimit(def, policy, principal);
  if (isUnlimited(resolved) || typeof resolved.value !== 'number') {
    return ALLOWED;
  }
  if (amount <= resolved.value) return ALLOWED;
  return applyMode(policy, principal, {
    ...denialFor(resolved, policy?.timezone ?? 'UTC'),
    used: amount,
  });
}

/**
 * The effective numeric value of a ceiling for a principal, for call sites
 * that need to CLAMP rather than reject (upload stream caps, tool-loop
 * rounds). Returns undefined when unlimited.
 */
export function effectiveCeiling(
  policy: LimitsPolicy | null,
  principal: Principal,
  limitKey: string,
): number | undefined {
  const def = getLimitDefinition(limitKey);
  if (!def) return undefined;
  const resolved = resolveLimit(def, policy, principal);
  return typeof resolved.value === 'number' ? resolved.value : undefined;
}

/**
 * Every counter cell a request should debit for `limitKey`, already resolved.
 * Cells that are unlimited are dropped here, which is what lets the caller
 * skip storage entirely for the unlimited majority.
 */
export function meteredCells(
  policy: LimitsPolicy | null,
  principal: Principal,
  limitKey: string,
  modelId?: string,
  series?: string,
): ResolvedLimit[] {
  const def = getLimitDefinition(limitKey);
  if (!def || def.kind !== 'counter') return [];
  const cells = def.perModel
    ? resolveModelCells(def, policy, principal, modelId, series)
    : [resolveLimit(def, policy, principal)];
  return cells.filter((cell) => typeof cell.value === 'number');
}

/** Resolves the policy snapshot once per request. Never throws. */
export async function currentPolicy(): Promise<LimitsPolicy | null> {
  const service = LimitsService.getInstance();
  await service.ensureFresh();
  return service.getSnapshot().policy;
}

export function allCounterDefinitions(): LimitDefinition[] {
  return LIMIT_DEFINITIONS.filter((d) => d.kind === 'counter');
}
