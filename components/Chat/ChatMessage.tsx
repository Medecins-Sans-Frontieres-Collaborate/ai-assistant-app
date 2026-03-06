import { FC, useEffect, useRef, useState } from 'react';

import { useChat } from '@/client/hooks/chat/useChat';
import { useConversations } from '@/client/hooks/conversation/useConversations';

import { MessageContentAnalyzer } from '@/lib/utils/shared/chat/messageContentAnalyzer';

import {
  FileMessageContent,
  ImageMessageContent,
  Message,
  MessageType,
  TextMessageContent,
  VersionInfo,
  isAssistantMessageGroup,
  isLegacyMessage,
} from '@/types/chat';

import { AssistantMessage } from '@/components/Chat/ChatMessages/AssistantMessage';
import ChatMessageText from '@/components/Chat/ChatMessages/ChatMessageText';
import { FileContent } from '@/components/Chat/ChatMessages/FileContent';
import { ImageContent } from '@/components/Chat/ChatMessages/ImageContent';
import { UserMessage } from '@/components/Chat/ChatMessages/UserMessage';
import { TranscriptViewer } from '@/components/Chat/TranscriptViewer';

export interface Props {
  message: Message;
  messageIndex: number;
  onEdit?: (editedMessage: Message) => void;
  onEditMessage?: () => void;
  onQuestionClick?: (question: string) => void;
  onRegenerate?: () => void;
  onSaveAsPrompt?: (content: string) => void;
  // Version navigation props
  versionInfo?: VersionInfo | null;
  onPreviousVersion?: () => void;
  onNextVersion?: () => void;
}

export const ChatMessage: FC<Props> = ({
  message,
  messageIndex,
  onEdit,
  onQuestionClick,
  onRegenerate,
  onSaveAsPrompt,
  versionInfo,
  onPreviousVersion,
  onNextVersion,
}) => {
  const { selectedConversation, updateConversation, conversations } =
    useConversations();
  const { isStreaming: messageIsStreaming } = useChat();

  const [isEditing, setIsEditing] = useState<boolean>(false);
  const [isTyping, setIsTyping] = useState<boolean>(false);
  const [messageContent, setMessageContent] = useState(message.content);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const toggleEditing = () => {
    setIsEditing(!isEditing);
  };

  const handleInputChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setMessageContent(event.target.value);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'inherit';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  };

  const handleEditMessage = () => {
    if (message.content !== messageContent) {
      if (selectedConversation && onEdit) {
        onEdit({ ...message, content: messageContent });
      }
    }
    setIsEditing(false);
  };

  const handleDeleteMessage = () => {
    if (!selectedConversation) return;

    const messages = [...selectedConversation.messages];
    // Find the message - only user messages can be deleted (which are legacy Messages)
    const findIndex = messages.findIndex(
      (elm) => isLegacyMessage(elm) && elm === message,
    );

    if (findIndex < 0) return;

    // Check if next entry is an assistant message (group or legacy)
    const nextEntry = messages[findIndex + 1];
    const nextIsAssistant =
      findIndex < messages.length - 1 &&
      (isAssistantMessageGroup(nextEntry) ||
        (isLegacyMessage(nextEntry) && nextEntry.role === 'assistant'));

    if (nextIsAssistant) {
      messages.splice(findIndex, 2);
    } else {
      messages.splice(findIndex, 1);
    }

    updateConversation(selectedConversation.id, {
      ...selectedConversation,
      messages,
    });
  };

  const handlePressEnter = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !isTyping && !e.shiftKey) {
      e.preventDefault();
      handleEditMessage();
    }
  };

  const handleSaveAsPromptClick = () => {
    const analyzer = new MessageContentAnalyzer(message);
    const content = analyzer.extractText();
    if (onSaveAsPrompt) {
      onSaveAsPrompt(content);
    }
  };

  // Use JSON.stringify for stable comparison of message content
  const messageContentKey = JSON.stringify(message.content);

  useEffect(() => {
    setMessageContent(message.content);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageContentKey]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'inherit';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [isEditing]);

  // Use MessageContentAnalyzer for content detection and extraction
  const analyzer = new MessageContentAnalyzer(message);
  const hasImages = analyzer.hasImages();
  const hasFiles = analyzer.hasFiles();

  // Extract content by type
  const getContentByType = () => {
    const images = analyzer.extractImageUrls();
    const files = analyzer.extractFileUrls();
    const textString = analyzer.extractText();
    const text = textString
      ? ({ type: 'text', text: textString } as TextMessageContent)
      : undefined;

    return { images, files, text };
  };

  // Render transcript viewer for transcription messages
  if (message.transcript && message.role === 'assistant') {
    return (
      <div className="group text-gray-800 dark:text-gray-100">
        <AssistantMessage
          content={typeof message.content === 'string' ? message.content : ''}
          message={message}
          messageIsStreaming={messageIsStreaming}
          messageIndex={messageIndex}
          selectedConversation={selectedConversation}
          onRegenerate={onRegenerate}
          versionInfo={versionInfo}
          onPreviousVersion={onPreviousVersion}
          onNextVersion={onNextVersion}
        >
          <TranscriptViewer
            filename={message.transcript.filename}
            transcript={message.transcript.transcript}
            processedContent={message.transcript.processedContent}
          />
        </AssistantMessage>
      </div>
    );
  }

  // Render file messages with composition (handles both files AND images together)
  // Check hasFiles first because FileContent can render both files and images
  if (hasFiles) {
    const { images, files, text } = getContentByType();
    const textContent = text?.text || '';

    if (message.role === 'user') {
      return (
        <UserMessage
          message={message}
          messageContent={textContent}
          setMessageContent={setMessageContent}
          isEditing={isEditing}
          textareaRef={textareaRef}
          handleInputChange={handleInputChange}
          handlePressEnter={handlePressEnter}
          setIsTyping={setIsTyping}
          setIsEditing={setIsEditing}
          toggleEditing={toggleEditing}
          handleDeleteMessage={handleDeleteMessage}
          onEdit={onEdit || (() => {})}
          selectedConversation={selectedConversation}
          onRegenerate={onRegenerate}
          onSaveAsPrompt={handleSaveAsPromptClick}
        >
          <FileContent
            files={files}
            images={images}
            parentMessage={message}
            parentMessageIndex={messageIndex}
          />
          {text && (
            <div className="prose dark:prose-invert prose-p:my-2 text-gray-800 dark:text-white max-w-none mt-2">
              {text.text}
            </div>
          )}
        </UserMessage>
      );
    } else {
      return (
        <div className="group text-gray-800 dark:text-gray-100">
          <AssistantMessage
            content={textContent}
            message={message}
            messageIsStreaming={messageIsStreaming}
            messageIndex={messageIndex}
            selectedConversation={selectedConversation}
            onRegenerate={onRegenerate}
            versionInfo={versionInfo}
            onPreviousVersion={onPreviousVersion}
            onNextVersion={onNextVersion}
          >
            <div className="mb-3">
              <FileContent
                files={files}
                images={images}
                parentMessage={message}
                parentMessageIndex={messageIndex}
              />
            </div>
            {text && <div className="prose dark:prose-invert">{text.text}</div>}
          </AssistantMessage>
        </div>
      );
    }
  }

  // Render image-only messages (no files, just images)
  if (hasImages) {
    const { images, text } = getContentByType();
    const textContent = text?.text || '';

    if (message.role === 'user') {
      return (
        <UserMessage
          message={message}
          messageContent={textContent}
          setMessageContent={setMessageContent}
          isEditing={isEditing}
          textareaRef={textareaRef}
          handleInputChange={handleInputChange}
          handlePressEnter={handlePressEnter}
          setIsTyping={setIsTyping}
          setIsEditing={setIsEditing}
          toggleEditing={toggleEditing}
          handleDeleteMessage={handleDeleteMessage}
          onEdit={onEdit || (() => {})}
          selectedConversation={selectedConversation}
          onRegenerate={onRegenerate}
          onSaveAsPrompt={handleSaveAsPromptClick}
        >
          <ImageContent images={images} />
          {text && (
            <div className="prose dark:prose-invert prose-p:my-2 text-gray-800 dark:text-white max-w-none mt-2">
              {text.text}
            </div>
          )}
        </UserMessage>
      );
    } else {
      return (
        <div className="group text-gray-800 dark:text-gray-100">
          <AssistantMessage
            content={textContent}
            message={message}
            messageIsStreaming={messageIsStreaming}
            messageIndex={messageIndex}
            selectedConversation={selectedConversation}
            onRegenerate={onRegenerate}
            versionInfo={versionInfo}
            onPreviousVersion={onPreviousVersion}
            onNextVersion={onNextVersion}
          >
            <div className="mb-3">
              <ImageContent images={images} />
            </div>
            {text && <div className="prose dark:prose-invert">{text.text}</div>}
          </AssistantMessage>
        </div>
      );
    }
  }

  // Render text-only messages
  // Note: messageType is optional UI metadata, so we primarily check content type
  if (typeof message.content === 'string') {
    return (
      <ChatMessageText
        message={message}
        isEditing={isEditing}
        setIsEditing={setIsEditing}
        setIsTyping={setIsTyping}
        handleInputChange={handleInputChange}
        textareaRef={textareaRef}
        handlePressEnter={handlePressEnter}
        handleEditMessage={handleEditMessage}
        messageContent={messageContent as string}
        setMessageContent={setMessageContent}
        toggleEditing={toggleEditing}
        handleDeleteMessage={handleDeleteMessage}
        messageIsStreaming={messageIsStreaming}
        messageIndex={messageIndex}
        selectedConversation={selectedConversation}
        onEdit={onEdit}
        onQuestionClick={onQuestionClick}
        onRegenerate={onRegenerate}
        onSaveAsPrompt={handleSaveAsPromptClick}
        versionInfo={versionInfo}
        onPreviousVersion={onPreviousVersion}
        onNextVersion={onNextVersion}
      />
    );
  } else {
    return (
      <div
        className={`group md:px-4 ${
          message.role === 'assistant'
            ? 'border-b border-black/10 bg-gray-50 text-gray-800 dark:border-gray-900/50 dark:bg-[#2f2f2f] dark:text-gray-100'
            : 'border-b border-black/10 bg-white text-gray-800 dark:border-gray-900/50 dark:bg-[#2f2f2f] dark:text-gray-100'
        }`}
      >
        <div className="relative flex p-4 text-base md:gap-6 md:py-6 lg:px-0 w-full">
          <div className="prose mt-[-2px] w-full dark:prose-invert">
            Error rendering message: Unsupported message type
          </div>
        </div>
      </div>
    );
  }
};
