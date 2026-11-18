/**
 * Turn-level routing for helper-model calls made during a chat turn
 * (query rewrites, routing decisions, schema proposals): the residency
 * region for the auxiliary chain, the user's chat model as the fallback
 * (plain-text or structured), token accounting, and cancellation.
 *
 * Every chat stage that makes a helper call builds its routing here, so the
 * region and fallback rules live in one place (see also
 * lib/services/auxiliary/auxiliaryCompletion.ts for where calls run).
 */
import type { AuxiliaryRegion } from '@/lib/services/auxiliary/types';
import { recordTokenUsage } from '@/lib/services/observability/tokenUsageRecorder';
import { auxiliaryRegion } from '@/lib/services/skills/skillRegion';

import type { UserRegion } from '@/lib/utils/shared/region';

import type { AuxiliaryUsageSink } from '@/types/chat';

import type { ChatContext } from './pipeline/ChatContext';
import type {
  StructuredDecisionFallback,
  StructuredDecisionProvider,
} from './routing/structuredDecisionFallback';
import {
  type TextCompleter,
  type TextCompletionProvider,
  bindTextCompleterToTurn,
} from './textCompletion';

/** What a chat stage needs to make a helper call for this turn. */
export interface AuxiliaryTurnRouting {
  /** Residency region (EU users, and users of unknown region, resolve EU). */
  region: AuxiliaryRegion;
  /** Cancels the call when the stage times out. */
  signal?: AbortSignal;
  /** Records helper-call usage against the user. */
  onUsage: AuxiliaryUsageSink;
  /** The chat model for plain-text calls; absent when unavailable. */
  textFallback?: TextCompleter;
  /** The chat model for structured calls; absent when unavailable. */
  structuredFallback?: StructuredDecisionFallback;
}

/** The chat service, which can serve both kinds of fallback. */
export type AuxiliaryFallbackProvider = Partial<
  TextCompletionProvider & StructuredDecisionProvider
>;

/** The residency region for a turn's helper calls. */
export function auxiliaryRegionForTurn(
  context: Pick<ChatContext, 'user' | 'hostedRegion'>,
): AuxiliaryRegion {
  return auxiliaryRegion(
    context.user?.region as UserRegion | null | undefined,
    context.hostedRegion,
  );
}

/**
 * The structured chat-model fallback for a turn: the user's chat model
 * under the turn's residency. None for custom-source (bring-your-own)
 * models: completeStructuredDecision serves only app-hosted models.
 */
export function structuredFallbackForTurn(
  context: Pick<ChatContext, 'user' | 'hostedRegion'> & {
    model?: ChatContext['model'];
  },
  provider?: Pick<StructuredDecisionProvider, 'completeStructuredDecision'>,
): StructuredDecisionFallback | undefined {
  const model = context.model;
  if (!provider || !model || model.isCustomSourceModel) return undefined;
  const target = {
    model,
    userRegion: context.user?.region as 'US' | 'EU' | null | undefined,
    hostedRegion: context.hostedRegion,
  };
  return (params, signal) =>
    provider.completeStructuredDecision(target, params, signal);
}

/**
 * Builds the helper-call routing for one turn.
 *
 * A fallback that cannot be bound (no provider, or a custom-source model
 * missing its endpoint) is simply absent: the helper call still runs on
 * the auxiliary chain.
 *
 * @param context - The turn's pipeline context.
 * @param provider - The chat service, for the chat-model fallbacks.
 */
export function auxiliaryTurnRouting(
  context: ChatContext,
  provider?: AuxiliaryFallbackProvider,
): AuxiliaryTurnRouting {
  let textFallback: TextCompleter | undefined;
  if (provider?.completeText) {
    try {
      textFallback = bindTextCompleterToTurn(
        provider as TextCompletionProvider,
        context,
      );
    } catch (error) {
      console.warn(
        '[auxiliaryTurnRouting] No chat-model fallback for this turn:',
        error instanceof Error ? error.message : error,
      );
    }
  }
  return {
    region: auxiliaryRegionForTurn(context),
    signal: context.stageSignal,
    onUsage: (usage, model) =>
      recordTokenUsage(usage, model, context.user, false, context.telemetry),
    textFallback,
    structuredFallback: provider?.completeStructuredDecision
      ? structuredFallbackForTurn(
          context,
          provider as StructuredDecisionProvider,
        )
      : undefined,
  };
}
