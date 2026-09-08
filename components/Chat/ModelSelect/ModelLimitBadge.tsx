'use client';

import { IconClock } from '@tabler/icons-react';
import { FC } from 'react';

import { useTranslations } from 'next-intl';

import {
  ModelAvailabilityView,
  useResetCountdown,
} from '@/client/hooks/settings/useMyLimits';

import { isLowRemaining } from './modelLimits';

export interface ModelLimitCopyOptions {
  /**
   * Fired once when the reset boundary passes while mounted — the caller
   * refetches so the row comes back on its own instead of after a reload.
   */
  onExpired?: () => void;
  /**
   * Agent framing: the limited thing is the model the agent pins, not the
   * row the user is looking at ("uses o3, which isn't available to you").
   */
  agentModelName?: string;
}

/**
 * The sentence behind the clock badge, the inline touch note and the
 * header tooltip — one source so every surface says the same thing. `null`
 * when the model is available (nothing to explain). Counts fall back to the
 * cap when the server sent a reason without them (usage unreadable), so the
 * copy never renders "undefined/20". Never names a limit key or layer
 * (docs/LIMITS.md no-provenance rule).
 */
export function useModelLimitCopy(
  view: ModelAvailabilityView,
  { onExpired, agentModelName }: ModelLimitCopyOptions = {},
): string | null {
  const t = useTranslations('limitsUx.picker');
  // Countdown only matters while exhausted; an available model's resetAt
  // (attached to low-remaining rows) would otherwise tick for nothing.
  const resets = useResetCountdown(
    view.state === 'exhausted' ? view.resetAt : undefined,
    { onExpired },
  );

  if (view.state === 'available') return null;

  if (agentModelName !== undefined) {
    if (view.state === 'blocked') {
      return t('agentModelUnavailable', { model: agentModelName });
    }
    return resets
      ? t('agentModelExhausted', { model: agentModelName, resets })
      : t('agentModelExhaustedNoReset', { model: agentModelName });
  }

  if (view.state === 'blocked') return t('unavailable');

  const limit = view.limit ?? 0;
  const used = view.used ?? limit;
  const family = view.reason === 'familyExhausted';
  if (resets) {
    return t(family ? 'familyExhausted' : 'exhausted', {
      used,
      limit,
      resets,
    });
  }
  return t(family ? 'familyExhaustedNoReset' : 'exhaustedNoReset', {
    used,
    limit,
  });
}

interface ModelLimitBadgeProps {
  view: ModelAvailabilityView;
  onExpired?: () => void;
  agentModelName?: string;
  size?: number;
  className?: string;
}

/**
 * Clock badge for an exhausted (or, on stale surfaces, blocked) model. The
 * full sentence rides `title` for hover and `aria-label` for readers; the
 * hosting row decides whether to also print it inline (touch has no hover).
 * Renders nothing while the model is available so callers can drop it in
 * unconditionally.
 */
export const ModelLimitBadge: FC<ModelLimitBadgeProps> = ({
  view,
  onExpired,
  agentModelName,
  size = 14,
  className = '',
}) => {
  const copy = useModelLimitCopy(view, { onExpired, agentModelName });
  if (!copy) return null;
  return (
    <span
      data-testid="model-limit-badge"
      title={copy}
      aria-label={copy}
      role="img"
      className={`shrink-0 inline-flex text-amber-600 dark:text-amber-400 cursor-help ${className}`}
    >
      <IconClock size={size} aria-hidden="true" />
    </span>
  );
};

interface LowRemainingPillProps {
  view: ModelAvailabilityView;
  className?: string;
}

/**
 * "3 left" annotation for a model at or under 10 % of its cap (see
 * isLowRemaining). Amber, not red: the model still works, this is a heads-up
 * so the user can pace themselves or switch before the clock badge appears.
 */
export const LowRemainingPill: FC<LowRemainingPillProps> = ({
  view,
  className = '',
}) => {
  const t = useTranslations('limitsUx.picker');
  if (!isLowRemaining(view)) return null;
  const remaining = view.remaining ?? 0;
  const limit = view.limit ?? 0;
  return (
    <span
      data-testid="model-limit-remaining"
      title={t('remainingTooltip', { remaining, limit })}
      className={`shrink-0 rounded-sm bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium leading-tight text-amber-800 dark:bg-amber-500/15 dark:text-amber-300 ${className}`}
    >
      {t('remaining', { remaining })}
    </span>
  );
};
