'use client';

import { IconClock, IconLock } from '@tabler/icons-react';
import { FC, useMemo } from 'react';

import { useTranslations } from 'next-intl';

import {
  MeLimit,
  ModelAvailability,
  useMyLimits,
  useResetCountdown,
} from '@/client/hooks/settings/useMyLimits';

import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { LimitUnit, getLimitDefinition } from '@/config/limits';

/**
 * One line of the "Your limits" block, already reduced to what the user
 * needs to read: a label source (catalog copy or a model name), the numbers,
 * and whether the row is a hard "no". Never carries the limit key, source or
 * override id — the own-limits payload keeps the no-provenance promise and
 * so does this table.
 */
export interface YourLimitRow {
  id: string;
  /** i18n suffix under `limits.label` — the admin's catalog copy, reused. */
  labelKey?: string;
  /** Display name for a per-model row, or the family label for a collapsed one. */
  modelName?: string;
  /**
   * True when several models sharing one family envelope were collapsed
   * into this single row — `modelName` here is the family label, not a
   * model name, and the renderer must wrap it accordingly.
   */
  isFamilyRow?: boolean;
  unit: LimitUnit;
  /** A boolean gate resolved to `false` (or a model the caller may not use). */
  blocked: boolean;
  limit?: number;
  used?: number;
  remaining?: number;
  resetAt?: string;
  /**
   * Of `used`, the part spent by conversation workflows. Shown as a sub-line
   * so the shared budget stays one number with one cap, while still saying
   * where it went (docs/WORKFLOW_EMISSIONS_DESIGN.md §7b).
   */
  usedByWorkflows?: number;
  /** The family envelope, not this model's own cap, is what ran out. */
  familyExhausted: boolean;
}

/**
 * Same (limit, used) ⇒ same counter cell behind both rows. `resetAt` is
 * deliberately NOT compared: `periods.resetAt` builds a fresh `Date` on
 * every call, so the chat row's and a same-cell model row's ISO instants
 * differ by the millisecond each call happened to land on (and the chat row
 * carries no `resetAt` at all when `usageUnavailable` skipped it), so
 * comparing it would make this dedup a no-op against the real payload.
 */
function sameCell(
  a: { limit?: number; used?: number },
  b: { limit?: number; used?: number },
): boolean {
  return a.limit === b.limit && a.used === b.used;
}

/**
 * Reduces the own-limits payload to the rows worth showing.
 *
 * Catalog defaults are deliberately dropped unless the user has actually
 * consumed some of that budget: the compiled M365 tool budgets and the MCP
 * round ceiling are numeric for EVERY account, so taking `limits[]` at face
 * value would show "Mail drafts per day 0 / 25" to people who have never
 * opened a mailbox here and would make the block impossible to hide for the
 * unlimited majority. A policy-set value is always shown — that is the
 * thing an admin chose for this account.
 *
 * Per-model entries whose numbers match the unqualified message cap are
 * skipped too: the server reports the binding cell per model, and when the
 * only numeric cell is `chat.messagesPerDay` every model would repeat the
 * chat row verbatim.
 *
 * `modelFamily`, when given, names the family/series a served model belongs
 * to (e.g. its `seriesLabel`); model rows that share a family AND an
 * identical counter cell are collapsed into one row, since every member of
 * a family-capped series reports the same numbers and listing each one
 * separately reads as N independent budgets instead of one shared envelope.
 */
export function selectYourLimitRows(
  limits: readonly MeLimit[],
  models: Readonly<Record<string, ModelAvailability>>,
  modelName: (id: string) => string,
  modelFamily: (id: string) => string | undefined = () => undefined,
): YourLimitRow[] {
  const rows: YourLimitRow[] = [];
  let messageCap: MeLimit | undefined;

  for (const row of limits) {
    // Qualified rows never appear on the own-limits branch; `models` is the
    // per-model answer, so a stray one is not double-counted here.
    if (row.modelId || row.series) continue;
    const def = getLimitDefinition(row.limitKey);
    // A key this build does not know cannot be labelled without leaking the
    // raw key; the server's send-time denial still explains it.
    if (!def) continue;
    // `model.allowed` / `model.requests` unqualified rows are only the
    // compiled DEFAULT: enforcement never writes a counter under the bare
    // key (it debits `model:<id>.requests` / `family:<series>.requests`),
    // so this row would freeze at "0 / N" forever while `models` already
    // carries the real, conjunctively-resolved per-model answer.
    if (def.perModel) continue;

    if (row.value === false) {
      rows.push({
        id: row.limitKey,
        labelKey: def.labelKey,
        unit: def.unit,
        blocked: true,
        familyExhausted: false,
      });
      continue;
    }
    if (typeof row.value !== 'number') continue;
    const touched = typeof row.used === 'number' && row.used > 0;
    if (row.source === 'catalog' && !touched) continue;
    if (row.limitKey === 'chat.messagesPerDay') messageCap = row;
    rows.push({
      id: row.limitKey,
      labelKey: def.labelKey,
      unit: def.unit,
      blocked: false,
      limit: row.value,
      used: row.used,
      remaining: row.remaining,
      resetAt: row.resetAt,
      usedByWorkflows: row.usedByWorkflows,
      familyExhausted: false,
    });
  }

  // Each entry pairs the row with the family it belongs to (if any) so the
  // collapsing pass below can group without leaking that bookkeeping field
  // into the rows the caller actually renders.
  const modelEntries: { row: YourLimitRow; family?: string }[] = [];
  for (const [modelId, entry] of Object.entries(models)) {
    if (entry.allowed === false) {
      modelEntries.push({
        row: {
          id: `model:${modelId}`,
          modelName: modelName(modelId),
          unit: 'requests',
          blocked: true,
          familyExhausted: false,
        },
      });
      continue;
    }
    if (typeof entry.limit !== 'number') continue;
    if (
      messageCap &&
      sameCell(
        { limit: entry.limit, used: entry.used },
        { limit: messageCap.value as number, used: messageCap.used },
      )
    ) {
      continue;
    }
    modelEntries.push({
      row: {
        id: `model:${modelId}`,
        modelName: modelName(modelId),
        unit: 'requests',
        blocked: false,
        limit: entry.limit,
        used: entry.used,
        resetAt: entry.resetAt,
        remaining: entry.remaining,
        familyExhausted: entry.reason === 'familyExhausted',
      },
      family: modelFamily(modelId),
    });
  }

  const collapsed: YourLimitRow[] = [];
  const groups = new Map<string, { row: YourLimitRow; family?: string }[]>();
  for (const entry of modelEntries) {
    if (entry.row.blocked || !entry.family) {
      collapsed.push(entry.row);
      continue;
    }
    const key = [
      entry.family,
      entry.row.limit,
      entry.row.used,
      entry.row.resetAt,
      entry.row.familyExhausted,
    ].join('|');
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  for (const group of groups.values()) {
    if (group.length === 1) {
      collapsed.push(group[0].row);
      continue;
    }
    const { row, family } = group[0];
    collapsed.push({
      ...row,
      id: `family:${family}:${row.limit}:${row.resetAt ?? ''}`,
      modelName: family,
      isFamilyRow: true,
    });
  }
  collapsed.sort((a, b) =>
    (a.modelName ?? '').localeCompare(b.modelName ?? ''),
  );

  return [...rows, ...collapsed];
}

const numberFmt = new Intl.NumberFormat();

const ResetsIn: FC<{ resetAt?: string; onExpired?: () => void }> = ({
  resetAt,
  onExpired,
}) => {
  const t = useTranslations();
  const countdown = useResetCountdown(resetAt, { onExpired });
  if (!countdown) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
      <IconClock size={12} />
      {t('limitsUx.mine.resetsIn', { resets: countdown })}
    </span>
  );
};

const LimitRow: FC<{ row: YourLimitRow; onExpired?: () => void }> = ({
  row,
  onExpired,
}) => {
  const t = useTranslations();
  const rawLabel =
    row.modelName ?? (row.labelKey ? t(`limits.label.${row.labelKey}`) : '');
  // A collapsed family row's `modelName` is the family label (e.g. "GPT"),
  // not a model name — wrap it so it reads as a shared budget, not one model.
  const label = row.isFamilyRow
    ? t('limitsUx.mine.familyRow', { family: rawLabel })
    : rawLabel;
  const unit = t(`limits.unit.${row.unit}`);
  const exhausted = !row.blocked && row.remaining === 0;

  let value: string;
  if (row.blocked) {
    value = t('limitsUx.mine.notAvailable');
  } else if (typeof row.used === 'number') {
    value = t('limitsUx.mine.usedOfLimit', {
      used: numberFmt.format(row.used),
      limit: numberFmt.format(row.limit ?? 0),
      unit,
    });
  } else {
    // No `used`: usage was unreadable or this is a per-request ceiling.
    value = t('limitsUx.mine.limitOnly', {
      limit: numberFmt.format(row.limit ?? 0),
      unit,
    });
  }

  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
      <span className="truncate text-gray-800 dark:text-gray-200">{label}</span>
      <span className="flex shrink-0 flex-col items-end gap-0.5 text-end">
        <span
          className={
            row.blocked || exhausted
              ? 'inline-flex items-center gap-1 text-amber-700 dark:text-amber-400'
              : 'text-gray-500 dark:text-gray-400'
          }
        >
          {row.blocked && <IconLock size={14} />}
          {value.trim()}
        </span>
        {/* Where the budget went. Stated only when workflows actually spent
            some of it — one cap, one number, but the split is visible. */}
        {typeof row.usedByWorkflows === 'number' && row.usedByWorkflows > 0 && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {t('limitsUx.mine.usedByWorkflows', {
              used: numberFmt.format(row.usedByWorkflows),
            })}
          </span>
        )}
        {exhausted && (
          <span className="text-xs text-amber-700 dark:text-amber-400">
            {t(
              row.familyExhausted
                ? 'limitsUx.mine.familyLimitReached'
                : 'limitsUx.mine.limitReached',
            )}
          </span>
        )}
        {!row.blocked && (
          <ResetsIn resetAt={row.resetAt} onExpired={onExpired} />
        )}
      </span>
    </li>
  );
};

/**
 * Read-only "Your limits" block for Settings › Usage & Impact
 * (docs/LIMITS_USER_FACING_UX.md §3f / §7.4): the one place a user can
 * answer "why can't I…?" without asking an admin. Driven entirely by
 * `useMyLimits()`; renders nothing unless the policy is ENFORCED and at
 * least one row survives {@link selectYourLimitRows} — observe mode, the
 * flag being off, a policy outage and the unlimited majority all see
 * exactly today's page.
 */
export const YourLimitsTable: FC = () => {
  const t = useTranslations();
  const { enforce, limits, models, usageUnavailable, refetch } = useMyLimits();
  const servedModels = useSettingsStore((s) => s.models);

  const rows = useMemo(() => {
    if (!enforce) return [];
    const modelName = (id: string): string =>
      servedModels.find((m) => m.id === id)?.name ??
      OpenAIModels[id as OpenAIModelID]?.name ??
      id;
    const modelFamily = (id: string): string | undefined =>
      servedModels.find((m) => m.id === id)?.seriesLabel ??
      OpenAIModels[id as OpenAIModelID]?.seriesLabel;
    return selectYourLimitRows(limits, models, modelName, modelFamily);
  }, [enforce, limits, models, servedModels]);

  if (rows.length === 0) return null;

  return (
    <div
      className="mb-6 border-b border-gray-200 pb-6 dark:border-gray-700"
      data-testid="your-limits"
    >
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1">
        {t('limitsUx.mine.title')}
      </h3>
      <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
        {t('limitsUx.mine.description')}
      </p>
      <ul className="rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-200 dark:divide-gray-700">
        {rows.map((row) => (
          <LimitRow key={row.id} row={row} onExpired={refetch} />
        ))}
      </ul>
      {usageUnavailable && (
        <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
          {t('limitsUx.mine.usageUnavailable')}
        </p>
      )}
    </div>
  );
};
