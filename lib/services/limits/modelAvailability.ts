/**
 * Per-model availability as the PICKER needs it — one answer per model,
 * computed with exactly the cells enforcement checks, so the picker and the
 * send can never disagree (docs/LIMITS_USER_FACING_UX.md §3a / §7.1).
 *
 * Pure: no storage, no logging, no `applyMode`. The observe/enforce switch is
 * deliberately NOT applied here — `/api/models` and the client decide what a
 * would-block means for THEIR surface (hide only in enforce; observe changes
 * nothing for users), and an audit line for a mere listing would flood the
 * log with would-blocks nobody attempted.
 *
 * Both entry points mirror `enforcement.ts` cell for cell:
 *  - `isModelBlocked`   ⇔ `checkGate('model.allowed', modelId, series)`:
 *    the model cell AND the family cell, either one `false` blocks; a model
 *    with no valid cells falls back to the unqualified resolution.
 *  - `resolveModelAvailability` ⇔ the counter set `createLimitsMiddleware`
 *    reserves: `meteredCells('chat.messagesPerDay')` plus
 *    `meteredCells('model.requests', modelId, series)`, read back from the
 *    usage document under the same `counterCellName` keys the debit wrote.
 * The byom exemption is mirrored too: a `byom-` model skips the gate and its
 * per-model counters unless `policy.countByomUsage`, but still counts against
 * the unqualified message cap, exactly as the middleware charges it.
 */
import { periodKindForWindow, resetAt } from '@/lib/services/limits/periods';
import {
  ResolvedLimit,
  counterCellName,
  isBlocked,
  resolveLimit,
  resolveModelCells,
} from '@/lib/services/limits/resolver';
import { LimitsPolicy, PeriodKind } from '@/lib/services/limits/types';
import { Principal } from '@/lib/services/shared/principalMatching';

import { LimitDefinition, getLimitDefinition } from '@/config/limits';

export type ModelAvailabilityReason =
  | 'blocked'
  | 'exhausted'
  | 'familyExhausted';

export interface ModelAvailability {
  /** False ⇢ `model.allowed` resolved false on the model OR the family cell. */
  allowed: boolean;
  reason?: ModelAvailabilityReason;
  /** The BINDING counter cell (least remaining), when any resolved cell is numeric. */
  limit?: number;
  used?: number;
  remaining?: number;
  /** ISO instant the binding cell's window rolls over. */
  resetAt?: string;
}

/**
 * The caller's counters per ledger, as `readUsage` returns them — cell name
 * → consumption. `null` when usage was not requested or could not be read;
 * cells then report their cap but no consumption.
 */
export interface UsageWindows {
  day: Record<string, number>;
  month: Record<string, number>;
}

/**
 * The gate cells `checkGate` evaluates for a per-model key: the conjunctive
 * model + family cells, or the bare resolution when the model yields no
 * valid cell (no id passes the dimension check and no series) — a per-model
 * key with no model context still has a global answer.
 */
function gateCells(
  def: LimitDefinition,
  policy: LimitsPolicy | null,
  principal: Principal,
  modelId: string | undefined,
  series: string | undefined,
): ResolvedLimit[] {
  const cells = def.perModel
    ? resolveModelCells(def, policy, principal, modelId, series)
    : [resolveLimit(def, policy, principal)];
  if (cells.length === 0) cells.push(resolveLimit(def, policy, principal));
  return cells;
}

/** `meteredCells` without the storage-bearing module: numeric counter cells only. */
function numericCounterCells(
  limitKey: string,
  policy: LimitsPolicy | null,
  principal: Principal,
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

function isByomExempt(policy: LimitsPolicy | null, modelId: string): boolean {
  return !policy?.countByomUsage && modelId.startsWith('byom-');
}

/**
 * Would a chat request on this model be refused by `model.allowed`?
 * Conjunctive (model AND family), pure, mode-agnostic. `isBlocked` returns
 * false on a `null`/`true` cell, so an unauthored policy answers false.
 */
export function isModelBlocked(
  policy: LimitsPolicy | null,
  principal: Principal,
  modelId?: string,
  series?: string,
): boolean {
  const def = getLimitDefinition('model.allowed');
  if (!def) return false;
  if (modelId && isByomExempt(policy, modelId)) return false;
  return gateCells(def, policy, principal, modelId, series).some(isBlocked);
}

interface CellReading {
  cell: ResolvedLimit;
  limit: number;
  /** Absent when usage was not readable — the cap is known, consumption is not. */
  used?: number;
  remaining?: number;
  resetAt?: string;
}

/** A `family:` cell — the envelope, as opposed to the model sub-cap or the bare message cap. */
function isFamilyCell(cell: ResolvedLimit): boolean {
  return !cell.modelId && !!cell.series;
}

function readCell(
  cell: ResolvedLimit,
  usage: UsageWindows | null,
  timezone: string,
): CellReading {
  const limit = cell.value as number;
  const kind: PeriodKind | null = periodKindForWindow(cell.window);
  const reading: CellReading = { cell, limit };
  if (kind) {
    const at = resetAt(kind, timezone);
    if (at) reading.resetAt = at;
    if (usage && kind !== 'total') {
      // 0 when no document: a user who has not sent anything today has a
      // whole budget, not an unknown one.
      const used = usage[kind][counterCellName(cell)] ?? 0;
      reading.used = used;
      reading.remaining = Math.max(0, limit - used);
    }
  }
  return reading;
}

/**
 * Which of two readings binds first. Least remaining wins (least cap when
 * consumption is unknown); on a tie the model sub-cap or bare message cap
 * beats the family envelope, so "both used up" reads as the model being
 * exhausted, and `familyExhausted` is reserved for the case where ONLY the
 * envelope is — which is the one that needs different copy ("your GPT
 * budget"), since switching to a sibling model will not help.
 */
function tighter(a: CellReading, b: CellReading): CellReading {
  const ra = a.remaining ?? a.limit;
  const rb = b.remaining ?? b.limit;
  if (ra !== rb) return ra < rb ? a : b;
  if (isFamilyCell(a.cell) !== isFamilyCell(b.cell)) {
    return isFamilyCell(a.cell) ? b : a;
  }
  return a;
}

/**
 * One model's answer for the picker. `usage` is the caller's own counters
 * (both ledgers) or `null`; `timezone` is the policy's org-wide zone, which
 * must match the one enforcement wrote the period keys with.
 *
 * A blocked model reports only `{ allowed: false, reason: 'blocked' }` —
 * its counters are moot and hidden models render nothing. Otherwise the
 * numeric counter cells are read and the binding one is reported; `reason`
 * is set only when that cell is at zero remaining.
 */
export function resolveModelAvailability(
  policy: LimitsPolicy | null,
  principal: Principal,
  model: { id: string; series?: string },
  usage: UsageWindows | null,
  timezone: string,
): ModelAvailability {
  if (isModelBlocked(policy, principal, model.id, model.series)) {
    return { allowed: false, reason: 'blocked' };
  }

  const cells = [
    ...numericCounterCells('chat.messagesPerDay', policy, principal),
    ...(isByomExempt(policy, model.id)
      ? []
      : numericCounterCells(
          'model.requests',
          policy,
          principal,
          model.id,
          model.series,
        )),
  ];
  if (cells.length === 0) return { allowed: true };

  const binding = cells
    .map((cell) => readCell(cell, usage, timezone))
    .reduce(tighter);

  const out: ModelAvailability = { allowed: true, limit: binding.limit };
  if (binding.used !== undefined) out.used = binding.used;
  if (binding.remaining !== undefined) out.remaining = binding.remaining;
  if (binding.resetAt) out.resetAt = binding.resetAt;
  if (binding.remaining === 0) {
    out.reason = isFamilyCell(binding.cell) ? 'familyExhausted' : 'exhausted';
  }
  return out;
}
