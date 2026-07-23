import React, { useEffect, useRef, useState } from 'react';

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
 * Shimmer color tier for the loading text, keyed off how long the user has
 * been waiting. The drift (gray → pale blue → pale yellow → pale orange →
 * brown) is a passive "this is taking a while" signal — long tool
 * round-trips (Bing grounding, code interpreter) are legitimate but the
 * color acknowledges the wait instead of pretending everything is instant.
 *
 * `activityActive` floors the tier at pale blue: the moment the loader
 * switches from the default "Thinking…" to a tool-specific message, the
 * color flips to blue instantly as part of that change (a gray tool
 * message drifting to blue seconds later reads as jarring). The default
 * "Thinking…" text itself always starts gray. Exported for tests.
 */
export function getLoadingColorClasses(
  elapsedSeconds: number,
  activityActive = false,
): string {
  if (activityActive) {
    elapsedSeconds = Math.max(elapsedSeconds, 10);
  }
  if (elapsedSeconds >= 75) {
    return 'from-amber-800 via-amber-700 to-amber-800 dark:from-amber-600 dark:via-amber-500 dark:to-amber-600';
  }
  if (elapsedSeconds >= 45) {
    return 'from-orange-500 via-orange-400 to-orange-500 dark:from-orange-400 dark:via-orange-300 dark:to-orange-400';
  }
  if (elapsedSeconds >= 25) {
    return 'from-yellow-600 via-yellow-500 to-yellow-600 dark:from-yellow-400 dark:via-yellow-300 dark:to-yellow-400';
  }
  if (elapsedSeconds >= 10) {
    // Deliberately pale — the gray→blue hop is the first shift users see
    // (and it fires instantly on tool activity), so it should read as a
    // gentle nudge, not a state change. Dark mode: sky-300 sits at similar
    // lightness to the gray-400 base text.
    return 'from-sky-400 via-sky-300 to-sky-400 dark:from-sky-300 dark:via-sky-200 dark:to-sky-300';
  }
  return 'from-gray-500 via-gray-400 to-gray-500 dark:from-gray-400 dark:via-gray-300 dark:to-gray-400';
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
        className={`text-sm bg-gradient-to-r ${getLoadingColorClasses(elapsedSeconds, hasActivity)} bg-clip-text text-transparent animate-shimmer transition-opacity duration-200 ${
          isTransitioning ? 'opacity-0' : 'opacity-100'
        }`}
        style={{
          backgroundSize: '200% 100%',
        }}
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
  const hasStreamingSideChannel =
    streamingConsentCount > 0 || streamingToolCallCount > 0;

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
