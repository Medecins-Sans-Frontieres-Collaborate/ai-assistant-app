import React, { useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  entryToDisplayMessage,
  getVersionInfo,
} from '@/lib/utils/shared/chat/messageVersioning';

import { ConversationEntry, Message, MessageType } from '@/types/chat';
import { Citation } from '@/types/rag';

import { MemoizedChatMessage } from './MemoizedChatMessage';

import { useChatStore } from '@/client/stores/chatStore';

/**
 * Wave color tier for the loading text, keyed off how long the user has
 * been waiting. The text itself stays gray; a colored band sweeps through
 * it once per animation cycle, so the flash reads gray → tier color →
 * gray. The tier drift (gray → pale blue → yellow → orange → brown) is a
 * passive "this is taking a while" signal — long tool round-trips (Bing
 * grounding, code interpreter) are legitimate but the color acknowledges
 * the wait instead of pretending everything is instant.
 *
 * Returns arbitrary-property classes that set `--wave-color` (hex values —
 * gradient stops can't take Tailwind color utilities). Tiers: gray-400,
 * sky-400, yellow-600, orange-500, amber-800; dark variants one shade
 * brighter to hold up on the dark background.
 *
 * `activityActive` floors the tier at pale blue: a tool-specific message
 * with a gray wave would understate that work is happening. The default
 * "Thinking…" text always starts gray. Exported for tests.
 */
export function getLoadingColorClasses(
  elapsedSeconds: number,
  activityActive = false,
): string {
  if (activityActive) {
    elapsedSeconds = Math.max(elapsedSeconds, 10);
  }
  if (elapsedSeconds >= 75) {
    return '[--wave-color:#92400e] dark:[--wave-color:#d97706]';
  }
  if (elapsedSeconds >= 45) {
    return '[--wave-color:#f97316] dark:[--wave-color:#fb923c]';
  }
  if (elapsedSeconds >= 25) {
    return '[--wave-color:#ca8a04] dark:[--wave-color:#facc15]';
  }
  if (elapsedSeconds >= 10) {
    // sky-400 / sky-300 — deliberately pale; the gray→blue hop is the
    // first shift users see, so it should read as a gentle nudge.
    return '[--wave-color:#38bdf8] dark:[--wave-color:#7dd3fc]';
  }
  // gray-400 / gray-300 — a slightly lighter gray than the base, so the
  // initial state still shimmers without showing any hue.
  return '[--wave-color:#9ca3af] dark:[--wave-color:#d1d5db]';
}

/**
 * AnimatedLoadingText - Fades in/out when text changes. Tracks elapsed wait
 * time from `startedAt`: the shimmer color drifts warmer the longer the
 * wait, and once the loader has switched to a specific activity message
 * (`hasActivity`), the color floors at blue and an explicit elapsed
 * counter renders beside the text.
 */
const AnimatedLoadingText: React.FC<{
  text: string;
  /** Epoch ms when this streaming request started; null = no timing. */
  startedAt?: number | null;
  /**
   * A tool-specific activity message is showing (not the default
   * "Thinking…"): shows the elapsed counter and floors the color at blue.
   */
  hasActivity?: boolean;
}> = ({ text, startedAt, hasActivity }) => {
  const [displayText, setDisplayText] = useState(text);
  const [isTransitioning, setIsTransitioning] = useState(false);
  // Tenths of a second — the visible 0.1s cadence makes the wait feel
  // live in a way a once-per-second tick doesn't.
  const [elapsedTenths, setElapsedTenths] = useState(0);
  const elapsedSeconds = elapsedTenths / 10;

  // Tier changes are deferred to the animation-iteration boundary — the
  // one frame where the color wave is fully off the text and it reads
  // solid gray (the shimmer-wave gradient keeps its band away from the
  // window at 0%/200% background-position). Swapping there means every
  // threshold passes through gray before the new color sweeps in, instead
  // of recoloring the wave mid-flight. Worst-case lag is one 2s cycle,
  // which also covers the tool-activity blue floor.
  const targetColorClasses = getLoadingColorClasses(
    elapsedSeconds,
    hasActivity,
  );
  const [appliedColorClasses, setAppliedColorClasses] =
    useState(targetColorClasses);

  useEffect(() => {
    if (text === displayText) return;

    // Schedule fade out for next tick to avoid synchronous setState in effect
    const transitionTimer = setTimeout(() => {
      setIsTransitioning(true);

      const fadeOutTimer = setTimeout(() => {
        setDisplayText(text);
        // Small delay before fading back in
        setTimeout(() => {
          setIsTransitioning(false);
        }, 50);
      }, 200);

      return () => clearTimeout(fadeOutTimer);
    }, 0);

    return () => clearTimeout(transitionTimer);
  }, [text, displayText]);

  useEffect(() => {
    // First update goes through a 0ms timeout — synchronous setState in an
    // effect cascades a render (same pattern as the fade above).
    if (startedAt == null) {
      const resetTimer = setTimeout(() => setElapsedTenths(0), 0);
      return () => clearTimeout(resetTimer);
    }
    const tick = () =>
      setElapsedTenths(Math.max(0, Math.floor((Date.now() - startedAt) / 100)));
    const kickoff = setTimeout(tick, 0);
    const interval = setInterval(tick, 100);
    return () => {
      clearTimeout(kickoff);
      clearInterval(interval);
    };
  }, [startedAt]);

  return (
    <div className="flex items-baseline gap-2">
      <div
        className={`text-sm bg-clip-text text-transparent animate-shimmer-wave motion-reduce:animate-none transition-opacity duration-200 [--wave-base:#6b7280] dark:[--wave-base:#9ca3af] ${appliedColorClasses} ${
          isTransitioning ? 'opacity-0' : 'opacity-100'
        }`}
        style={{
          // Gray base with a color band centered at 75% of the tile. At
          // 0%/200% background-position the visible window shows the
          // 0–50% stretch — solid gray — so the animationiteration swap
          // below never recolors a visible wave.
          backgroundImage:
            'linear-gradient(to right, var(--wave-base) 0%, var(--wave-base) 60%, var(--wave-color) 75%, var(--wave-base) 90%, var(--wave-base) 100%)',
          backgroundSize: '200% 100%',
        }}
        onAnimationIteration={() => setAppliedColorClasses(targetColorClasses)}
      >
        {displayText}
      </div>
      {hasActivity && startedAt != null && elapsedTenths > 0 && (
        <span className="text-xs tabular-nums text-gray-400 dark:text-gray-500">
          {elapsedSeconds.toFixed(1)}s
        </span>
      )}
    </div>
  );
};

interface ChatMessagesProps {
  messages: ConversationEntry[];
  isStreaming: boolean;
  streamingConversationId?: string | null;
  selectedConversationId?: string;
  smoothedContent: string;
  isDraining: boolean;
  citations?: Citation[];
  loadingMessage?: string | null;
  /** Interpolation params for `loadingMessage` (e.g. {tool: 'get_invoice'}). */
  loadingMessageParams?: Record<string, string>;
  transcriptionStatus: string | null;
  lastMessageRef: React.RefObject<HTMLDivElement | null>;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  onEditMessage: (message: Message) => void;
  onSelectPrompt: (prompt: string) => void;
  onRegenerate: (messageIndex?: number) => void;
  onGenerateResponse: () => void;
  onSaveAsPrompt: (content: string) => void;
  onNavigateVersion: (messageIndex: number, direction: 'prev' | 'next') => void;
}

/**
 * ChatMessages component
 * Renders the list of messages, streaming content, and status indicators
 */
export const ChatMessages: React.FC<ChatMessagesProps> = ({
  messages,
  isStreaming,
  streamingConversationId,
  selectedConversationId,
  smoothedContent,
  isDraining,
  citations,
  loadingMessage,
  loadingMessageParams,
  transcriptionStatus,
  lastMessageRef,
  messagesEndRef,
  onEditMessage,
  onSelectPrompt,
  onRegenerate,
  onGenerateResponse,
  onSaveAsPrompt,
  onNavigateVersion,
}) => {
  const t = useTranslations();

  const showStreamingDiv =
    (isStreaming && streamingConversationId === selectedConversationId) ||
    isDraining;

  // A TOOL activity marker set the loader text (all stream-marker keys live
  // under `chat.activity.*`). The content-based initial keys ("Thinking…",
  // "Analyzing files…" — `chat.loadingMessages.*`) are NOT tool activity:
  // they must start gray and without the elapsed counter.
  const isToolActivity = !!loadingMessage?.startsWith('chat.activity.');

  // Wall-clock anchor for the current streaming wait. Held here (not in the
  // loader) so the elapsed timer/color survive the loader remounting when
  // the first content arrives (standalone loader → above-message loader).
  // Set on the next tick: stamping Date.now() during render is impure, and
  // a synchronous setState in the effect would cascade a render.
  const [streamStartedAt, setStreamStartedAt] = useState<number | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      setStreamStartedAt((prev) => (isStreaming ? (prev ?? Date.now()) : null));
    }, 0);
    return () => clearTimeout(timer);
  }, [isStreaming]);

  // Side-channel state — when a turn emits only a consent card or tool
  // record (no text), smoothedContent is empty but we still need to mount
  // the assistant message for the card to render.
  const streamingConsentCount = useChatStore(
    (s) => s.streamingConsentRequests.length,
  );
  const streamingToolCallCount = useChatStore(
    (s) => s.streamingToolCalls.length,
  );
  const hasInterimSearch = useChatStore(
    (s) => s.streamingInterimSearch !== null,
  );
  const hasStreamingSideChannel =
    streamingConsentCount > 0 || streamingToolCallCount > 0 || hasInterimSearch;

  // During regenerate the new version replaces an existing index; otherwise
  // it appends, so the live card targets messages.length.
  const regeneratingIndex = useChatStore((s) => s.regeneratingIndex);
  const streamingMessageIndex =
    regeneratingIndex !== null ? regeneratingIndex : messages.length;

  // During drain, hide the last message to avoid duplicate content
  // (the finalized message is already in the list, but we're still animating it)
  const displayMessages = isDraining ? messages.slice(0, -1) : messages;

  const lastEntry =
    displayMessages.length > 0
      ? displayMessages[displayMessages.length - 1]
      : null;
  const lastDisplayMessage = lastEntry
    ? entryToDisplayMessage(lastEntry)
    : null;
  const showGenerateResponse =
    !showStreamingDiv &&
    !!lastDisplayMessage &&
    (lastDisplayMessage.role === 'user' ||
      (lastDisplayMessage.role === 'assistant' && !!lastDisplayMessage.error));

  return (
    <>
      {displayMessages.map((entry, index) => {
        const isLastMessage = index === displayMessages.length - 1;
        const displayMessage = entryToDisplayMessage(entry);
        const versionInfo = getVersionInfo(entry);

        return isLastMessage ? (
          <div key={index} ref={lastMessageRef} className="mb-2">
            <MemoizedChatMessage
              message={displayMessage}
              messageIndex={index}
              onEdit={onEditMessage}
              onQuestionClick={onSelectPrompt}
              onRegenerate={() => onRegenerate(index)}
              onSaveAsPrompt={onSaveAsPrompt}
              versionInfo={versionInfo}
              onPreviousVersion={() => onNavigateVersion(index, 'prev')}
              onNextVersion={() => onNavigateVersion(index, 'next')}
            />
          </div>
        ) : (
          <div key={index} className="mb-2">
            <MemoizedChatMessage
              message={displayMessage}
              messageIndex={index}
              onEdit={onEditMessage}
              onQuestionClick={onSelectPrompt}
              onRegenerate={() => onRegenerate(index)}
              onSaveAsPrompt={onSaveAsPrompt}
              versionInfo={versionInfo}
              onPreviousVersion={() => onNavigateVersion(index, 'prev')}
              onNextVersion={() => onNavigateVersion(index, 'next')}
            />
          </div>
        );
      })}

      {/* Generate response affordance — appears when the conversation is
          stuck on a trailing user message or an errored assistant turn */}
      {showGenerateResponse && (
        <div className="flex justify-center my-4">
          <button
            type="button"
            onClick={onGenerateResponse}
            className="px-4 py-2 rounded-lg bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium transition-colors"
          >
            {t('chat.generateResponseButton')}
          </button>
        </div>
      )}

      {/* Transcription status indicator */}
      {transcriptionStatus && (
        <div className="relative flex p-4 text-base md:py-6 lg:px-0 w-full">
          <div className="flex items-center space-x-3">
            <div className="w-4 h-4 bg-blue-500 dark:bg-blue-400 rounded-full animate-breathing"></div>
            <span
              className="text-sm bg-gradient-to-r from-gray-600 via-gray-500 to-gray-600 dark:from-gray-400 dark:via-gray-300 dark:to-gray-400 bg-clip-text text-transparent animate-shimmer"
              style={{
                backgroundSize: '200% 100%',
              }}
            >
              {transcriptionStatus}
            </span>
          </div>
        </div>
      )}

      {/* Streaming message or loading indicator */}
      {showStreamingDiv && (
        <>
          {smoothedContent.trim() || hasStreamingSideChannel ? (
            <>
              {/* Activity indicator on top — what the agent is doing right
                  now. The MemoizedChatMessage below renders the text, the
                  tool summary, and the consent cards as they become known. */}
              <div className="px-4 pt-2 lg:px-0">
                <div className="mx-auto max-w-3xl flex items-center gap-3">
                  <div className="w-3 h-3 bg-gray-500 dark:bg-gray-400 rounded-full animate-breathing flex-shrink-0" />
                  <AnimatedLoadingText
                    text={t(
                      loadingMessage || 'chat.thinking',
                      loadingMessageParams,
                    )}
                    startedAt={streamStartedAt}
                    hasActivity={isToolActivity}
                  />
                </div>
              </div>
              <MemoizedChatMessage
                message={{
                  role: 'assistant',
                  content: smoothedContent,
                  messageType: MessageType.TEXT,
                  citations,
                }}
                messageIndex={streamingMessageIndex}
                onEdit={() => {}}
                onQuestionClick={onSelectPrompt}
              />
            </>
          ) : (
            <div className="relative flex p-4 text-base md:py-6 lg:px-0 w-full">
              <div className="flex items-center gap-3">
                <div className="w-4 h-4 bg-gray-500 dark:bg-gray-400 rounded-full animate-breathing flex-shrink-0"></div>
                <AnimatedLoadingText
                  text={t(
                    loadingMessage || 'chat.thinking',
                    loadingMessageParams,
                  )}
                  startedAt={streamStartedAt}
                  hasActivity={isToolActivity}
                />
              </div>
            </div>
          )}
        </>
      )}

      <div ref={messagesEndRef} />
    </>
  );
};
