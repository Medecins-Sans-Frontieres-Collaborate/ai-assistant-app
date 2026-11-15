'use client';

import { IconBell, IconHelpCircle, IconLock, IconX } from '@tabler/icons-react';
import { FC, useState } from 'react';

import { useLocale, useTranslations } from 'next-intl';

import { useBudgetGate } from '@/client/hooks/settings/useUsageBudgets';

import { hasReached } from '@/lib/utils/shared/usageBudgets';

import { SettingsSection } from '@/components/Settings/types';

import { useBudgetGateStore } from '@/client/stores/budgetGateStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import { useUIStore } from '@/client/stores/uiStore';

interface BudgetNoticeProps {
  /** Opens the model picker (the same way the header does). */
  onChooseModel: () => void;
}

const SHELL = 'mx-auto w-full max-w-3xl px-4 pb-2';

/**
 * The personal-budget notice above the composer. One line, in one of three
 * forms, following the stages of lib/utils/shared/usageBudgets.ts:
 *
 * - warn — a dismissible heads-up; stays dismissed for the rest of the period.
 * - ask  — shown while a send is being held: confirm, change model, or cancel.
 * - stop — sending is paused until the period resets; the only way out is the
 *          budget itself, in Settings.
 *
 * Renders nothing when no budget has reached a stage, which is the case for
 * everyone who has not set one.
 */
export const BudgetNotice: FC<BudgetNoticeProps> = ({ onChooseModel }) => {
  const t = useTranslations();
  const locale = useLocale();
  const { status, isStopped } = useBudgetGate();
  const pending = useBudgetGateStore((s) => s.pending);
  const confirm = useBudgetGateStore((s) => s.confirm);
  const cancel = useBudgetGateStore((s) => s.cancel);
  const dismissed = useSettingsStore((s) => s.usageBudgetWarnDismissed);
  const dismissWarning = useSettingsStore((s) => s.dismissUsageBudgetWarning);
  const snoozeAsk = useSettingsStore((s) => s.snoozeUsageBudgetAsk);
  const openSettingsAt = useUIStore((s) => s.openSettingsAt);
  const [dontAskToday, setDontAskToday] = useState(false);

  const { leading } = status;
  if (!leading) return null;

  const percent = Math.round(leading.percent);
  const openBudgetSettings = () => openSettingsAt(SettingsSection.USAGE_IMPACT);

  if (isStopped) {
    return (
      <div className={SHELL}>
        <div
          role="status"
          data-testid="budget-notice-stop"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-surface-dark-elevated dark:text-gray-100"
        >
          <IconLock
            size={18}
            aria-hidden="true"
            className="flex-shrink-0 text-red-700 dark:text-red-400"
          />
          <span className="min-w-0 flex-1">
            {t(`usageBudgets.notice.stop.${leading.metric}`, {
              date: leading.resetsAt.toLocaleDateString(locale, {
                day: 'numeric',
                month: 'long',
              }),
            })}
          </span>
          <button
            type="button"
            onClick={openBudgetSettings}
            className="flex-shrink-0 rounded bg-gray-900 px-3 py-1 text-sm font-medium text-white transition-colors hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white"
          >
            {t('usageBudgets.actions.openSettings')}
          </button>
        </div>
      </div>
    );
  }

  if (pending?.kind === 'message') {
    const sendAnyway = () => {
      if (dontAskToday) snoozeAsk(status.todayKey);
      setDontAskToday(false);
      confirm();
    };
    return (
      <div className={SHELL}>
        <div
          role="alertdialog"
          aria-labelledby="budget-ask-title"
          data-testid="budget-notice-ask"
          className="space-y-2.5 rounded-lg border border-orange-300 bg-orange-50 px-3 py-2.5 text-sm text-orange-950 dark:border-orange-700 dark:bg-orange-950/40 dark:text-orange-100"
        >
          <div className="flex items-center gap-3">
            <IconHelpCircle
              size={18}
              aria-hidden="true"
              className="flex-shrink-0"
            />
            <span id="budget-ask-title" className="font-medium">
              {t(`usageBudgets.notice.ask.${leading.metric}`, { percent })}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={sendAnyway}
              className="rounded bg-gray-900 px-3 py-1 font-medium text-white transition-colors hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white"
            >
              {t('usageBudgets.actions.sendAnyway')}
            </button>
            <button
              type="button"
              onClick={() => {
                cancel();
                onChooseModel();
              }}
              className="rounded bg-orange-200 px-3 py-1 font-medium transition-colors hover:bg-orange-300 dark:bg-orange-800 dark:hover:bg-orange-700"
            >
              {t('limitsUx.denial.chooseAnotherModel')}
            </button>
            <button
              type="button"
              onClick={cancel}
              className="rounded px-3 py-1 font-medium transition-colors hover:bg-orange-100 dark:hover:bg-orange-900/60"
            >
              {t('usageBudgets.actions.dontSend')}
            </button>
            <label className="ms-auto flex cursor-pointer items-center gap-2 text-xs">
              <input
                type="checkbox"
                className="h-4 w-4 accent-gray-600 dark:accent-gray-400"
                checked={dontAskToday}
                onChange={(event) => setDontAskToday(event.target.checked)}
              />
              {t('usageBudgets.actions.dontAskToday')}
            </label>
          </div>
        </div>
      </div>
    );
  }

  // Past "ask" with nothing held (between sends, or snoozed for today) is
  // still worth the heads-up, so the warn line covers both.
  if (!hasReached(leading.state, 'warn')) return null;
  if (dismissed[leading.metric] === leading.periodKey) return null;

  return (
    <div className={SHELL}>
      <div
        role="status"
        data-testid="budget-notice-warn"
        className="flex items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
      >
        <IconBell size={18} aria-hidden="true" className="flex-shrink-0" />
        <span className="min-w-0 flex-1">
          {t(`usageBudgets.notice.warn.${leading.metric}`, { percent })}
        </span>
        <button
          type="button"
          onClick={openBudgetSettings}
          className="flex-shrink-0 rounded bg-amber-200 px-3 py-1 text-sm font-medium transition-colors hover:bg-amber-300 dark:bg-amber-800 dark:hover:bg-amber-700"
        >
          {t('usageBudgets.actions.viewBudget')}
        </button>
        <button
          type="button"
          onClick={() => dismissWarning(leading.metric, leading.periodKey)}
          aria-label={t('usageBudgets.actions.dismiss')}
          className="flex-shrink-0 rounded p-1 transition-colors hover:bg-amber-200 dark:hover:bg-amber-800"
        >
          <IconX size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
};
