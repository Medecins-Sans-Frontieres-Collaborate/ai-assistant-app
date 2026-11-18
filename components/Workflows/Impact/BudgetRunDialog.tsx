'use client';

import { FC, useState } from 'react';

import { useLocale, useTranslations } from 'next-intl';

import { useBudgetGate } from '@/client/hooks/settings/useUsageBudgets';

import { SettingsSection } from '@/components/Settings/types';
import { ConfirmDialog } from '@/components/UI/ConfirmDialog';

import { useBudgetGateStore } from '@/client/stores/budgetGateStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import { useUIStore } from '@/client/stores/uiStore';

/**
 * The workflow counterpart of the composer's budget notice: the dialog a run
 * button raises when a personal budget intervenes
 * (lib/utils/shared/usageBudgets.ts).
 *
 * - ask  — "Run anyway" or cancel, with "Don't ask again today".
 * - stop — the run is refused; the only action is opening the budget.
 *
 * Mounted once in WorkflowShell. It reads the held action from the gate
 * store, so every workspace's run button gets it by calling `guard(…, 'run')`
 * and nothing else.
 */
export const BudgetRunDialog: FC = () => {
  const t = useTranslations();
  const locale = useLocale();
  const { status, isStopped } = useBudgetGate();
  const pending = useBudgetGateStore((s) => s.pending);
  const confirm = useBudgetGateStore((s) => s.confirm);
  const cancel = useBudgetGateStore((s) => s.cancel);
  const snoozeAsk = useSettingsStore((s) => s.snoozeUsageBudgetAsk);
  const openSettingsAt = useUIStore((s) => s.openSettingsAt);
  const [dontAskToday, setDontAskToday] = useState(false);

  const { leading } = status;
  if (pending?.kind !== 'run' || !leading) return null;

  const close = () => {
    setDontAskToday(false);
    cancel();
  };

  if (isStopped) {
    return (
      <ConfirmDialog
        isOpen
        title={t(`usageBudgets.metric.${leading.metric}`)}
        message={t(`usageBudgets.notice.stop.${leading.metric}`, {
          date: leading.resetsAt.toLocaleDateString(locale, {
            day: 'numeric',
            month: 'long',
          }),
        })}
        confirmLabel={t('usageBudgets.actions.openSettings')}
        onConfirm={() => {
          close();
          openSettingsAt(SettingsSection.USAGE_IMPACT);
        }}
        onCancel={close}
      />
    );
  }

  return (
    <ConfirmDialog
      isOpen
      title={t(`usageBudgets.metric.${leading.metric}`)}
      message={t(`usageBudgets.notice.askRun.${leading.metric}`, {
        percent: Math.round(leading.percent),
      })}
      confirmLabel={t('usageBudgets.actions.runAnyway')}
      extraContent={
        <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            className="h-4 w-4 accent-gray-600 dark:accent-gray-400"
            checked={dontAskToday}
            onChange={(event) => setDontAskToday(event.target.checked)}
          />
          {t('usageBudgets.actions.dontAskToday')}
        </label>
      }
      onConfirm={() => {
        if (dontAskToday) snoozeAsk(status.todayKey);
        setDontAskToday(false);
        confirm();
      }}
      onCancel={close}
    />
  );
};
