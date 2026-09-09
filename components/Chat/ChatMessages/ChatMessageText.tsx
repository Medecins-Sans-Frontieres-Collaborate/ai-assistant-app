import React, { Dispatch, FC, KeyboardEvent, SetStateAction } from 'react';

import { handleRichCopy } from '@/lib/utils/app/richCopy';

import { Conversation, Message, VersionInfo } from '@/types/chat';

import { AssistantMessage } from '@/components/Chat/ChatMessages/AssistantMessage';
import { UserMessage } from '@/components/Chat/ChatMessages/UserMessage';

interface ChatMessageTextProps {
  message: Message;
  isEditing: boolean;
  setIsEditing: Dispatch<SetStateAction<boolean>>;
  setIsTyping: Dispatch<SetStateAction<boolean>>;
  handleInputChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  handlePressEnter: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  handleEditMessage: () => void;
  messageContent: string;
  setMessageContent: Dispatch<SetStateAction<Message['content']>>;
  toggleEditing: (event: React.MouseEvent) => void;
  handleDeleteMessage: () => void;
  messageIsStreaming: boolean;
  messageIndex: number;
  selectedConversation: Conversation | null;
  onEdit?: (message: Message) => void;
  onQuestionClick?: (question: string) => void;
  onRegenerate?: () => void;
  onSaveAsPrompt?: () => void;
  // Version navigation props
  versionInfo?: VersionInfo | null;
  onPreviousVersion?: () => void;
  onNextVersion?: () => void;
}

export const ChatMessageText: FC<ChatMessageTextProps> = ({
  message,
  isEditing,
  setIsEditing,
  setIsTyping,
  handleInputChange,
  textareaRef,
  handlePressEnter,
  handleEditMessage,
  messageContent,
  setMessageContent,
  toggleEditing,
  handleDeleteMessage,
  messageIsStreaming,
  messageIndex,
  selectedConversation,
  onEdit,
  onQuestionClick,
  onRegenerate,
  onSaveAsPrompt,
  versionInfo,
  onPreviousVersion,
  onNextVersion,
}) => {
  const { role, content } = message;

  return (
    <div
      className="group text-gray-800 dark:text-gray-100"
      style={{ overflowWrap: 'anywhere' }}
      onCopy={handleRichCopy}
    >
      {role === 'assistant' ? (
        <AssistantMessage
          content={content as string}
          message={message}
          messageIsStreaming={messageIsStreaming}
          messageIndex={messageIndex}
          selectedConversation={selectedConversation}
          onRegenerate={onRegenerate}
          versionInfo={versionInfo}
          onPreviousVersion={onPreviousVersion}
          onNextVersion={onNextVersion}
        />
      ) : (
        <UserMessage
          message={message}
          messageContent={messageContent}
          isEditing={isEditing}
          textareaRef={textareaRef}
          handleInputChange={handleInputChange}
          handlePressEnter={handlePressEnter}
          setIsTyping={setIsTyping}
          setMessageContent={setMessageContent}
          setIsEditing={setIsEditing}
          toggleEditing={toggleEditing}
          handleDeleteMessage={handleDeleteMessage}
          onEdit={onEdit || (() => {})}
          selectedConversation={selectedConversation}
          onSaveAsPrompt={onSaveAsPrompt}
        />
      )}
    </div>
  );
};

export default ChatMessageText;
