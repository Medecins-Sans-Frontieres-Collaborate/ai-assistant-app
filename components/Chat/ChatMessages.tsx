import React, { useEffect, useState } from 'react';

import { Message, MessageType } from '@/types/chat';
import { Citation } from '@/types/rag';

import { MemoizedChatMessage } from './MemoizedChatMessage';

/**
 * AnimatedLoadingText - Fades in/out when text changes
 */
const AnimatedLoadingText: React.FC<{ text: string }> = ({ text }) => {
  const [displayText, setDisplayText] = useState(text);
  const [isTransitioning, setIsTransitioning] = useState(false);

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

  return (
    <div
      className={`text-sm bg-gradient-to-r from-gray-500 via-gray-400 to-gray-500 dark:from-gray-400 dark:via-gray-300 dark:to-gray-400 bg-clip-text text-transparent animate-shimmer transition-opacity duration-200 ${
        isTransitioning ? 'opacity-0' : 'opacity-100'
      }`}
      style={{
        backgroundSize: '200% 100%',
      }}
    >
      {displayText}
    </div>
  );
};

interface ChatMessagesProps {
  messages: Message[];
  isStreaming: boolean;
  streamingConversationId?: string | null;
  selectedConversationId?: string;
  streamingContent?: string;
  citations?: Citation[];
  loadingMessage?: string | null;
  transcriptionStatus: string | null;
  lastMessageRef: React.RefObject<HTMLDivElement | null>;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  onEditMessage: (message: Message) => void;
  onSelectPrompt: (prompt: string) => void;
  onRegenerate: () => void;
  onSaveAsPrompt: (content: string) => void;
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
  streamingContent,
  citations,
  loadingMessage,
  transcriptionStatus,
  lastMessageRef,
  messagesEndRef,
  onEditMessage,
  onSelectPrompt,
  onRegenerate,
  onSaveAsPrompt,
}) => {
  return (
    <>
      {messages.map((message, index) => {
        const isLastMessage = index === messages.length - 1;

        return isLastMessage ? (
          <div key={index} ref={lastMessageRef} className="mb-2">
            <MemoizedChatMessage
              message={message}
              messageIndex={index}
              onEdit={onEditMessage}
              onQuestionClick={onSelectPrompt}
              onRegenerate={onRegenerate}
              onSaveAsPrompt={onSaveAsPrompt}
            />
          </div>
        ) : (
          <div key={index} className="mb-2">
            <MemoizedChatMessage
              message={message}
              messageIndex={index}
              onEdit={onEditMessage}
              onQuestionClick={onSelectPrompt}
              onRegenerate={onRegenerate}
              onSaveAsPrompt={onSaveAsPrompt}
            />
          </div>
        );
      })}

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
      {isStreaming && streamingConversationId === selectedConversationId && (
        <>
          {streamingContent ? (
            <MemoizedChatMessage
              message={{
                role: 'assistant',
                content: streamingContent,
                messageType: MessageType.TEXT,
                citations,
              }}
              messageIndex={messages.length}
              onEdit={() => {}}
              onQuestionClick={onSelectPrompt}
            />
          ) : (
            <div className="relative flex p-4 text-base md:py-6 lg:px-0 w-full">
              <div className="flex items-center gap-3">
                <div className="w-4 h-4 bg-gray-500 dark:bg-gray-400 rounded-full animate-breathing flex-shrink-0"></div>
                <AnimatedLoadingText text={loadingMessage || 'Thinking...'} />
              </div>
            </div>
          )}
        </>
      )}

      <div ref={messagesEndRef} />
    </>
  );
};
