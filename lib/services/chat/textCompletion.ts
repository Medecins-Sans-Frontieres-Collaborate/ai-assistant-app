/**
 * Plain-text, non-streaming completions on the user's selected chat model,
 * for pipeline stages that need a model call of their own (for example the
 * large-document summarizer). The provider (StandardChatService) owns the
 * per-SDK request shape and the region / custom-source client resolution, so
 * a stage never builds a client itself and never bypasses data residency.
 */
import { Session } from 'next-auth';

import type { CustomSourceRouting } from '@/lib/services/chat/StandardChatService';
import type { ChatContext } from '@/lib/services/chat/pipeline/ChatContext';

import { OpenAIModel } from '@/types/openai';

/** The model a completion runs on, and where it may run. */
export interface TextCompletionTarget {
  model: OpenAIModel;
  /** The user's residency region; EU users always resolve to EU. */
  userRegion?: 'US' | 'EU' | null;
  /** The conversation's requested hosting region (client preference). */
  hostedRegion?: 'US' | 'EU';
  /**
   * Set for custom-source (bring-your-own-model) models: the call runs on the
   * user's own account with the user's own credential, never on app clients.
   */
  customSource?: CustomSourceRouting;
}

/** One system + user exchange, answered as plain text. */
export interface TextCompletionRequest {
  systemPrompt: string;
  userPrompt: string;
  /** Output budget. Reasoning models spend part of it on reasoning. */
  maxTokens: number;
  /** Ignored for models that reject a custom temperature. */
  temperature?: number;
  /**
   * Reasoning effort for reasoning models that accept one (Azure OpenAI);
   * ignored elsewhere. Short utility calls should ask for the minimum so
   * reasoning does not consume `maxTokens` before any text is written.
   */
  reasoningEffort?: 'minimal' | 'low';
  /** Sent as the abuse-monitoring `user` field where the API accepts it. */
  user?: Session['user'];
}

/** Something that can run a plain-text completion on a chat model. */
export interface TextCompletionProvider {
  /**
   * @returns The model's reply text, trimmed (may be empty).
   * @throws When no client exists for the model in the resolved region, or
   *         the model call fails.
   */
  completeText(
    target: TextCompletionTarget,
    request: TextCompletionRequest,
    signal?: AbortSignal,
  ): Promise<string>;
}

/** A completion function already bound to one turn's model and residency. */
export type TextCompleter = (
  request: TextCompletionRequest,
  signal?: AbortSignal,
) => Promise<string>;

/**
 * Binds a provider to one turn's model and routing: the user's region (EU
 * users always resolve to EU) or, for a custom-source model, the user's own
 * account and credential. Mirrors StandardChatHandler, so a helper call
 * runs exactly where the chat answer runs. The turn's user rides along for
 * abuse monitoring, and the stage signal cancels the call on stage timeout
 * unless the caller passes a narrower one.
 *
 * @param provider - The completion provider (StandardChatService).
 * @param context - The turn's pipeline context.
 * @returns A completer bound to the turn.
 * @throws When a custom-source model is missing its resolved endpoint or
 *         credential: falling back to the app's clients would silently run
 *         the user's custom model somewhere else.
 */
export function bindTextCompleterToTurn(
  provider: TextCompletionProvider,
  context: Pick<
    ChatContext,
    | 'model'
    | 'user'
    | 'hostedRegion'
    | 'foundryEndpoint'
    | 'userCredential'
    | 'stageSignal'
  >,
): TextCompleter {
  const model = context.model;
  if (
    model.isCustomSourceModel &&
    (!context.foundryEndpoint || !context.userCredential)
  ) {
    throw new Error(
      'Custom-source model is missing its resolved endpoint or credential',
    );
  }
  const target: TextCompletionTarget = {
    model,
    userRegion: context.user?.region as 'US' | 'EU' | null | undefined,
    hostedRegion: context.hostedRegion,
    customSource:
      model.isCustomSourceModel &&
      context.foundryEndpoint &&
      context.userCredential
        ? {
            endpoint: context.foundryEndpoint,
            credential: context.userCredential,
          }
        : undefined,
  };
  return (request, signal) =>
    provider.completeText(
      target,
      { ...request, user: context.user },
      signal ?? context.stageSignal,
    );
}
