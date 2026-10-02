'use client';

import { IconArrowsExchange, IconClockHour4 } from '@tabler/icons-react';
import React, { useMemo } from 'react';

import { useLocale, useTranslations } from 'next-intl';

import { isServedListRefined } from '@/client/hooks/conversation/useNewConversation';
import { useRetirementClock } from '@/client/hooks/settings/useModelRetirementMigration';

import {
  getRetirementNotice,
  successorUpdates,
} from '@/lib/utils/shared/modelRetirement';

import { Conversation } from '@/types/chat';
import { OpenAIModelID } from '@/types/openai';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';

interface ModelRetirementNoticeProps {
  conversation: Conversation | null | undefined;
}

/**
 * Compact inline notice above the composer while the selected
 * conversation's model is inside its retirement notice window: says when
 * the model goes away, when the conversation will be moved and where to,
 * and offers the move now.
 *
 * This notice IS the announcement — the move itself
 * (useModelRetirementMigration) is silent. It stays up after the move date
 * for a conversation that is still (or again) on the model, without the
 * promise of a move: the automatic one has been made and will not repeat.
 * Sibling of ModelUnavailableNotice, which covers models already gone.
 */
export function ModelRetirementNotice({
  conversation,
}: ModelRetirementNoticeProps) {
  const t = useTranslations('modelRetirement');
  const locale = useLocale();
  const models = useSettingsStore((s) => s.models);
  const region = useSettingsStore((s) => s.userRegion);
  const modelListSource = useSettingsStore((s) => s.modelListSource);
  const updateConversation = useConversationStore((s) => s.updateConversation);
  const now = useRetirementClock();

  const modelId = conversation?.model?.id;
  const retirement = useMemo(
    () =>
      // Only once /api/models has answered: the static seed carries no
      // retirement dates and is blind to what this user is served.
      isServedListRefined(modelListSource)
        ? getRetirementNotice(modelId, { models, region, now })
        : null,
    [modelListSource, modelId, models, region, now],
  );

  if (!conversation || !retirement) return null;
  const { model, signal, successor } = retirement;
  if (!signal.retiresAt || !signal.movesAt) return null;
  const moveStillAhead = signal.phase === 'notice';

  // Azure's dates are UTC midnights; rendering them in UTC keeps the day
  // the same for every viewer.
  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString(locale, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    });

  const switchNow = () => {
    updateConversation(
      conversation.id,
      successorUpdates(conversation, successor),
    );
    // Someone who takes the switch has accepted the successor: move a
    // saved default on the retiring model along with it.
    const settings = useSettingsStore.getState();
    if (settings.defaultModelId === model.id) {
      settings.setDefaultModelId(successor.id as OpenAIModelID);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-2">
      <div
        role="status"
        className="flex items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
      >
        <IconClockHour4 size={18} className="flex-shrink-0" />
        <span className="flex-1">
          {moveStillAhead
            ? t('notice', {
                model: conversation.model.name || model.name,
                retiresOn: formatDate(signal.retiresAt),
                successor: successor.name,
                movesOn: formatDate(signal.movesAt),
              })
            : t('noticeRetiring', {
                model: conversation.model.name || model.name,
                retiresOn: formatDate(signal.retiresAt),
                successor: successor.name,
              })}
        </span>
        <button
          type="button"
          onClick={switchNow}
          className="flex flex-shrink-0 items-center gap-1.5 rounded bg-amber-200 px-3 py-1 text-sm font-medium transition-colors hover:bg-amber-300 dark:bg-amber-800 dark:hover:bg-amber-700"
        >
          <IconArrowsExchange size={16} />
          <span>{t('switchNow')}</span>
        </button>
      </div>
    </div>
  );
}
