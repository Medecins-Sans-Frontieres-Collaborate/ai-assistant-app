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
  /** Display name for a per-model row. */
  modelName?: string;
  unit: LimitUnit;
  /** A boolean gate resolved to `false` (or a model the caller may not use). */
  blocked: boolean;
  limit?: number;
  used?: number;
  remaining?: number;
  resetAt?: string;
  /** The family envelope, not this model's own cap, is what ran out. */
  familyExhausted: boolean;
}

/** Same shape (limit, used, resetAt) ⇒ same counter cell behind both rows. */
function sameCell(
  a: { limit?: number; used?: number; resetAt?: string },
  b: { limit?: number; used?: number; resetAt?: string },
): boolean {
  return a.limit === b.limit && a.used === b.used && a.resetAt === b.resetAt;
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
 */
export function selectYourLimitRows(
  limits: readonly MeLimit[],
  models: Readonly<Record<string, ModelAvailability>>,
  modelName: (id: string) => string,
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
      familyExhausted: false,
    });
  }

  const modelRows: YourLimitRow[] = [];
  for (const [modelId, entry] of Object.entries(models)) {
    if (entry.allowed === false) {
      modelRows.push({
        id: `model:${modelId}`,
        modelName: modelName(modelId),
        unit: 'requests',
        blocked: true,
        familyExhausted: false,
      });
      continue;
    }
    if (typeof entry.limit !== 'number') continue;
    const cell = {
      limit: entry.limit,
      used: entry.used,
      resetAt: entry.resetAt,
    };
    if (
      messageCap &&
      sameCell(cell, {
        limit: messageCap.value as number,
        used: messageCap.used,
        resetAt: messageCap.resetAt,
      })
    ) {
      continue;
    }
    modelRows.push({
      id: `model:${modelId}`,
      modelName: modelName(modelId),
      unit: 'requests',
      blocked: false,
      ...cell,
      remaining: entry.remaining,
      familyExhausted: entry.reason === 'familyExhausted',
    });
  }
  modelRows.sort((a, b) =>
    (a.modelName ?? '').localeCompare(b.modelName ?? ''),
  );

  return [...rows, ...modelRows];
}

const numberFmt = new Intl.NumberFormat();

const ResetsIn: FC<{ resetAt?: string }> = ({ resetAt }) => {
  const t = useTranslations();
  const countdown = useResetCountdown(resetAt);
  if (!countdown) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
      <IconClock size={12} />
      {t('limitsUx.mine.resetsIn', { resets: countdown })}
    </span>
  );
};

const LimitRow: FC<{ row: YourLimitRow }> = ({ row }) => {
  const t = useTranslations();
  const label =
    row.modelName ?? (row.labelKey ? t(`limits.label.${row.labelKey}`) : '');
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
        {exhausted && (
          <span className="text-xs text-amber-700 dark:text-amber-400">
            {t(
              row.familyExhausted
                ? 'limitsUx.mine.familyLimitReached'
                : 'limitsUx.mine.limitReached',
            )}
          </span>
        )}
        {!row.blocked && <ResetsIn resetAt={row.resetAt} />}
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
  const { enforce, limits, models, usageUnavailable } = useMyLimits();
  const servedModels = useSettingsStore((s) => s.models);

  const rows = useMemo(() => {
    if (!enforce) return [];
    const modelName = (id: string): string =>
      servedModels.find((m) => m.id === id)?.name ??
      OpenAIModels[id as OpenAIModelID]?.name ??
      id;
    return selectYourLimitRows(limits, models, modelName);
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
          <LimitRow key={row.id} row={row} />
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
