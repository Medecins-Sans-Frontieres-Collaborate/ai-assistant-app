'use client';

import { IconAlertTriangle, IconArrowsExchange } from '@tabler/icons-react';
import React from 'react';

import { useTranslations } from 'next-intl';

import {
  isServedCatalogModel,
  isServedListRefined,
} from '@/client/hooks/conversation/useNewConversation';
import { notifyLimitsChanged } from '@/client/hooks/settings/limitsUxEvents';
import {
  useModelAvailability,
  useResetCountdown,
} from '@/client/hooks/settings/useMyLimits';

import { Conversation } from '@/types/chat';
import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import { useSettingsStore } from '@/client/stores/settingsStore';

interface ModelUnavailableNoticeProps {
  conversation: Conversation | null | undefined;
  /** Opens the model picker (the same way the header does). */
  onChooseModel: () => void;
}

/**
 * Compact inline notice above the composer when the selected conversation's
 * model can no longer be used: the server stopped serving it (hidden — for
 * a per-user block or any other reason) or the user's budget for it is
 * used up. Without this the header falls back to DISPLAYING another model
 * while the store still SENDS the hidden one and 403s.
 *
 * Deliberately never swaps the model itself — the conversation's model is
 * the user's choice; the notice only offers the picker.
 */
export function ModelUnavailableNotice({
  conversation,
  onChooseModel,
}: ModelUnavailableNoticeProps) {
  const t = useTranslations();
  const models = useSettingsStore((s) => s.models);
  const modelListSource = useSettingsStore((s) => s.modelListSource);

  const model = conversation?.model;
  // Agents, byom and local models are never in the served list; their
  // absence means nothing, and the limits payload has no entry for them.
  const catalogId = model && isServedCatalogModel(model) ? model.id : undefined;
  const availability = useModelAvailability(catalogId);
  // §3b: "on expiry refetch and re-enable" — without this, the sentence
  // ("has reached its limit for today") outlives the window it describes
  // in a tab that stays focused past the reset, even once sends to the
  // model succeed again (staleTime alone would leave it stale for up to
  // 30s, not the instant the countdown hits zero).
  const resetsIn = useResetCountdown(
    availability.state === 'exhausted' ? availability.resetAt : undefined,
    { onExpired: notifyLimitsChanged },
  );

  if (!model || !catalogId) return null;

  const isServed = models.some((m) => m.id === catalogId);
  // A static-catalog id missing from even the static seed is disabled for
  // good; a discovered-only id is only judged once discovery has answered.
  const isHidden =
    !isServed &&
    (catalogId in OpenAIModels ? true : isServedListRefined(modelListSource));
  const isUnavailable = isHidden || availability.state === 'blocked';

  if (!isUnavailable && availability.state !== 'exhausted') return null;

  const name =
    model.name || OpenAIModels[catalogId as OpenAIModelID]?.name || catalogId;
  const sentence = isUnavailable
    ? t('limitsUx.notice.unavailable', { model: name })
    : availability.reason === 'familyExhausted'
      ? t('limitsUx.notice.familyExhausted', { model: name })
      : t('limitsUx.notice.exhausted', { model: name });
  const resets =
    !isUnavailable && resetsIn
      ? t('limitsUx.notice.resets', { resets: resetsIn })
      : null;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-2">
      <div
        role="status"
        className="flex items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
      >
        <IconAlertTriangle size={18} className="flex-shrink-0" />
        <span className="flex-1">
          {sentence}
          {resets ? ` ${resets}` : null}
        </span>
        <button
          type="button"
          onClick={onChooseModel}
          className="flex flex-shrink-0 items-center gap-1.5 rounded bg-amber-200 px-3 py-1 text-sm font-medium transition-colors hover:bg-amber-300 dark:bg-amber-800 dark:hover:bg-amber-700"
        >
          <IconArrowsExchange size={16} />
          <span>{t('limitsUx.notice.chooseModel')}</span>
        </button>
      </div>
    </div>
  );
}
