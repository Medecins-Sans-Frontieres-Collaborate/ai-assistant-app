import {
  IconArrowsExchange,
  IconDownload,
  IconMessagePlus,
  IconRefresh,
  IconX,
} from '@tabler/icons-react';
import React, { useState } from 'react';

import { useTranslations } from 'next-intl';

import { useResetCountdown } from '@/client/hooks/settings/useMyLimits';

import { LimitDenialMetadata } from '@/client/services/api/errors';

import { ErrorCode } from '@/types/errors';

import { REPEATED_FAILURE_THRESHOLD } from '@/client/stores/chatStore';

/** Features the card can switch off and resend without. */
export type ResendableFeature = 'webSearch' | 'codeInterpreter' | 'mcp';

/**
 * What a usage-limit denial is about, derived from its (never rendered)
 * limit key. Drives copy and the one action that can actually help:
 * another model for a model denial, dropping the tool for a feature gate,
 * waiting for the reset for an overall cap, shrinking the request for a
 * per-request ceiling.
 */
type DenialShape =
  | { kind: 'modelBlocked' }
  | { kind: 'modelExhausted' }
  | { kind: 'familyExhausted' }
  | { kind: 'feature'; feature: ResendableFeature }
  | { kind: 'cap'; cap: 'messages' | 'tokensDay' | 'tokensMonth' }
  | { kind: 'ceiling' }
  | { kind: 'unknown' };

function classifyDenial(denial: LimitDenialMetadata | null): DenialShape {
  if (!denial) return { kind: 'unknown' };
  switch (denial.limitKey) {
    case 'model.allowed':
      return { kind: 'modelBlocked' };
    case 'model.requests':
      // A family cell carries `series` without `modelId`: the shared
      // envelope ran out, not this model's own budget.
      return denial.modelId
        ? { kind: 'modelExhausted' }
        : { kind: 'familyExhausted' };
    case 'feature.webSearch.enabled':
      return { kind: 'feature', feature: 'webSearch' };
    case 'feature.codeInterpreter.enabled':
      return { kind: 'feature', feature: 'codeInterpreter' };
    case 'feature.mcp.enabled':
      return { kind: 'feature', feature: 'mcp' };
    case 'chat.messagesPerDay':
      return { kind: 'cap', cap: 'messages' };
    case 'chat.tokensPerDay':
      return { kind: 'cap', cap: 'tokensDay' };
    case 'chat.tokensPerMonth':
      return { kind: 'cap', cap: 'tokensMonth' };
  }
  // Ceilings are about THIS request being too big; waiting changes nothing.
  if (/PerRequest$|PerFile$/.test(denial.limitKey)) return { kind: 'ceiling' };
  return { kind: 'unknown' };
}

interface ChatErrorProps {
  error: string | null;
  /**
   * Structured server error code for `error`, when one was reported.
   * Code-specific failures (e.g. FILE_NOT_FOUND for an expired attachment)
   * render localized copy instead of the raw server string.
   */
  errorCode?: string | null;
  onClearError: () => void;
  onRegenerate?: () => void;
  /** Re-sends the trailing user message; used when no assistant group exists. */
  onRetry?: () => void;
  canRegenerate?: boolean;
  /** True when a retry would succeed where regenerate wouldn't. */
  canRetry?: boolean;
  /** Re-sends the failed turn on the next fallback-chain model. */
  onRetryFallback?: () => void;
  canRetryFallback?: boolean;
  /** Display name of the fallback model the retry would use. */
  fallbackModelName?: string | null;
  /**
   * Consecutive identical failures for the conversation behind this banner
   * (0 when none). At REPEATED_FAILURE_THRESHOLD the card escalates:
   * corrupted-conversation notice + start-new + debug-download actions.
   */
  failureStreakCount?: number;
  /** Spawns and selects a fresh conversation (current model carried over). */
  onStartNewConversation?: () => void;
  /** Downloads the debug bundle; `includeContent` = full message text. */
  onDownloadDebugInfo?: (includeContent: boolean) => void;
  /**
   * Parsed metadata of a usage-limit denial (errorCode
   * RATE_LIMIT_QUOTA_EXCEEDED). Null when the body carried none — the
   * server sentence is shown instead, still without a retry action.
   */
  denial?: LimitDenialMetadata | null;
  /** Opens the model picker — the fix for a per-model denial. */
  onChooseModel?: () => void;
  /** Switches the gated feature off for this conversation and resends. */
  onResendWithoutFeature?: (feature: ResendableFeature) => void;
  /**
   * True when the failed turn's model is agent-pinned or agent-swapped
   * (an agent-shaped model id, `isOrganizationAgent`/`isCustomAgent`, or a
   * decoupled `bot` attachment). A per-model denial on an agent invocation
   * cannot be fixed by "Choose another model": `ModelSelectionMiddleware`
   * re-swaps to the agent's pinned model on every attempt, so picking a
   * different model in the picker while the agent stays attached just
   * reproduces the same 403. Suppresses the picker action in favour of
   * copy that points at detaching the agent instead.
   */
  isAgentModelDenial?: boolean;
}

/**
 * Renders error messages with dismiss + action buttons. Prefers `onRetry`
 * when there's no assistant message to regenerate; additionally offers a
 * "try with <fallback model>" action when the failed turn's model has a
 * fallback available — the manual counterpart of the store's automatic
 * fallback, for failures it deliberately never retries silently (e.g. a
 * stream that died mid-response).
 */
export const ChatError: React.FC<ChatErrorProps> = ({
  error,
  errorCode,
  onClearError,
  onRegenerate,
  onRetry,
  canRegenerate = false,
  canRetry = false,
  onRetryFallback,
  canRetryFallback = false,
  fallbackModelName,
  failureStreakCount = 0,
  onStartNewConversation,
  onDownloadDebugInfo,
  denial = null,
  onChooseModel,
  onResendWithoutFeature,
  isAgentModelDenial = false,
}) => {
  const t = useTranslations();
  // Privacy default: the debug bundle is metadata-only unless the user
  // explicitly opts message text in.
  const [includeMessageText, setIncludeMessageText] = useState(false);

  const isQuotaDenial = errorCode === ErrorCode.RATE_LIMIT_QUOTA_EXCEEDED;
  const shape = isQuotaDenial ? classifyDenial(denial) : null;
  // A per-model denial on an agent invocation is a dead end for "Choose
  // another model": the server re-swaps to the agent's pinned model on the
  // next attempt regardless of what the picker sends. Only applies to the
  // per-model shapes — a feature gate or an overall cap is unrelated to the
  // agent's model.
  const isAgentDenial =
    isAgentModelDenial &&
    (shape?.kind === 'modelBlocked' ||
      shape?.kind === 'modelExhausted' ||
      shape?.kind === 'familyExhausted');
  // Localized, relative, in the viewer's timezone — the server sentence
  // only has the UTC instant. Null once the window has rolled over.
  const resetsIn = useResetCountdown(
    isQuotaDenial ? denial?.resetAt : undefined,
  );

  if (!error) return null;

  // The store keeps the raw (English) server message; localized copy for
  // known codes is owned here, where translations are available.
  const denialCopy = (() => {
    if (!shape) return null;
    const limit = typeof denial?.limit === 'number' ? denial.limit : undefined;
    let sentence: string | null;
    if (isAgentDenial) {
      // Blocked, exhausted or family-exhausted all land here for an agent
      // invocation: whichever it is, re-picking a model in the picker
      // cannot help while the agent stays attached, so the copy points at
      // the agent instead of the cap (the reset line, if any, still
      // applies below).
      sentence = t('limitsUx.denial.agentModelBlocked');
    } else {
      switch (shape.kind) {
        case 'modelBlocked':
          sentence = t('limitsUx.denial.modelBlocked');
          break;
        case 'modelExhausted':
          sentence = t('limitsUx.denial.modelExhausted', {
            limit: limit ?? '',
          });
          break;
        case 'familyExhausted':
          sentence = t('limitsUx.denial.familyExhausted', {
            limit: limit ?? '',
          });
          break;
        case 'feature':
          sentence =
            shape.feature === 'webSearch'
              ? t('limitsUx.denial.searchBlocked')
              : shape.feature === 'codeInterpreter'
                ? t('limitsUx.denial.interpreterBlocked')
                : t('limitsUx.denial.mcpBlocked');
          break;
        case 'cap':
          sentence =
            shape.cap === 'messages'
              ? t('limitsUx.denial.messagesCap', { limit: limit ?? '' })
              : shape.cap === 'tokensDay'
                ? t('limitsUx.denial.tokensDayCap')
                : t('limitsUx.denial.tokensMonthCap');
          break;
        case 'ceiling':
          sentence = t('limitsUx.denial.perRequest', { limit: limit ?? '' });
          break;
        default:
          // Unknown limit key (a newer server): keep the server sentence,
          // which already avoids provenance, rather than guessing.
          sentence = null;
      }
    }
    if (sentence === null) return null;
    return resetsIn
      ? `${sentence} ${t('limitsUx.denial.resets', { resets: resetsIn })}`
      : sentence;
  })();
  const effectiveError =
    errorCode === 'FILE_NOT_FOUND'
      ? t('chat.attachedFileExpired')
      : (denialCopy ?? error);

  // Truncate so the card stays readable; full text stays on the title attr.
  const renderedError = (() => {
    if (effectiveError.length <= 280) return effectiveError;
    const firstPeriod = effectiveError.indexOf('.');
    if (firstPeriod > 0 && firstPeriod < 280) {
      return effectiveError.slice(0, firstPeriod + 1) + ' …';
    }
    return effectiveError.slice(0, 240).trimEnd() + ' …';
  })();

  // A usage-limit denial cannot be retried into success: the same user hits
  // the same cap on every model until the period resets, so "Try again",
  // Regenerate and the fallback-model retry are all withheld in favour of
  // the shape-specific action below.
  const showRetry = !isQuotaDenial && canRetry && onRetry;
  const showRegenerate =
    !isQuotaDenial && !showRetry && canRegenerate && onRegenerate;
  const actionLabel = showRetry
    ? t('common.tryAgain')
    : showRegenerate
      ? t('chat.regenerate')
      : null;
  const onActionClick = showRetry
    ? onRetry
    : showRegenerate
      ? onRegenerate
      : null;
  const showRetryFallback =
    !isQuotaDenial &&
    canRetryFallback &&
    onRetryFallback &&
    !!fallbackModelName;
  // The escalation copy is about corrupted conversations; the store never
  // counts a quota denial towards the streak, and this guard keeps a streak
  // carried over from earlier failures from framing the denial that way.
  const showEscalation =
    !isQuotaDenial &&
    failureStreakCount >= REPEATED_FAILURE_THRESHOLD &&
    !!onStartNewConversation &&
    !!onDownloadDebugInfo;
  const showChooseModel =
    !!onChooseModel &&
    !isAgentDenial &&
    (shape?.kind === 'modelBlocked' ||
      shape?.kind === 'modelExhausted' ||
      shape?.kind === 'familyExhausted');
  const resendableFeature: ResendableFeature | null =
    shape?.kind === 'feature' ? shape.feature : null;
  const showResendWithoutFeature =
    !!onResendWithoutFeature && !!resendableFeature;

  return (
    <div className="absolute bottom-[160px] left-0 right-0 px-4 py-2">
      <div className="mx-auto max-w-3xl rounded-lg bg-red-100 p-4 text-red-800 dark:bg-red-900 dark:text-red-200">
        <div className="flex items-start justify-between">
          <span className="flex-1 whitespace-pre-wrap" title={effectiveError}>
            {renderedError}
          </span>
          <div className="flex items-center gap-2 ml-4 flex-shrink-0">
            {actionLabel && onActionClick && (
              <button
                onClick={onActionClick}
                className="flex items-center gap-1.5 px-3 py-1 text-sm font-medium bg-red-200 dark:bg-red-800 rounded hover:bg-red-300 dark:hover:bg-red-700 transition-colors"
                aria-label={actionLabel}
              >
                <IconRefresh size={16} />
                <span>{actionLabel}</span>
              </button>
            )}
            {showChooseModel && (
              <button
                onClick={onChooseModel}
                className="flex items-center gap-1.5 px-3 py-1 text-sm font-medium bg-red-200 dark:bg-red-800 rounded hover:bg-red-300 dark:hover:bg-red-700 transition-colors"
              >
                <IconArrowsExchange size={16} />
                <span>{t('limitsUx.denial.chooseAnotherModel')}</span>
              </button>
            )}
            {showResendWithoutFeature && resendableFeature && (
              <button
                onClick={() => onResendWithoutFeature?.(resendableFeature)}
                className="flex items-center gap-1.5 px-3 py-1 text-sm font-medium bg-red-200 dark:bg-red-800 rounded hover:bg-red-300 dark:hover:bg-red-700 transition-colors"
              >
                <IconRefresh size={16} />
                <span>
                  {resendableFeature === 'webSearch'
                    ? t('limitsUx.denial.turnOffSearchAndResend')
                    : resendableFeature === 'codeInterpreter'
                      ? t('limitsUx.denial.turnOffInterpreterAndResend')
                      : t('limitsUx.denial.turnOffConnectorsAndResend')}
                </span>
              </button>
            )}
            {showRetryFallback && (
              <button
                onClick={onRetryFallback}
                className="flex items-center gap-1.5 px-3 py-1 text-sm font-medium bg-red-200 dark:bg-red-800 rounded hover:bg-red-300 dark:hover:bg-red-700 transition-colors"
                aria-label={t('chat.retryWithModel', {
                  model: fallbackModelName,
                })}
              >
                <IconArrowsExchange size={16} />
                <span>
                  {t('chat.retryWithModel', { model: fallbackModelName })}
                </span>
              </button>
            )}
            <button
              onClick={onClearError}
              className="text-red-800 dark:text-red-200 hover:text-red-600 dark:hover:text-red-100 transition-colors"
              aria-label={t('errors.dismissError')}
            >
              <IconX size={20} />
            </button>
          </div>
        </div>
        {showEscalation && (
          <div className="mt-3 border-t border-red-300 dark:border-red-700 pt-3">
            <p className="text-sm">{t('chat.repeatedFailureNotice')}</p>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
              <button
                onClick={onStartNewConversation}
                className="flex items-center gap-1.5 px-3 py-1 text-sm font-medium bg-red-200 dark:bg-red-800 rounded hover:bg-red-300 dark:hover:bg-red-700 transition-colors"
              >
                <IconMessagePlus size={16} />
                <span>{t('chat.startNewConversation')}</span>
              </button>
              <button
                onClick={() => onDownloadDebugInfo?.(includeMessageText)}
                className="flex items-center gap-1.5 px-3 py-1 text-sm font-medium bg-red-200 dark:bg-red-800 rounded hover:bg-red-300 dark:hover:bg-red-700 transition-colors"
              >
                <IconDownload size={16} />
                <span>{t('chat.downloadDebugInfo')}</span>
              </button>
              <label className="flex items-center gap-1.5 text-sm cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={includeMessageText}
                  onChange={(e) => setIncludeMessageText(e.target.checked)}
                  className="accent-red-700 dark:accent-red-400"
                />
                {t('chat.includeMessageText')}
              </label>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
