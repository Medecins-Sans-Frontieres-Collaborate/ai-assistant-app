import {
  IconBraces,
  IconChevronDown,
  IconChevronUp,
  IconCode,
  IconDeviceFloppy,
  IconEdit,
  IconRefresh,
  IconTrash,
  IconVolume,
} from '@tabler/icons-react';
import {
  Dispatch,
  FC,
  KeyboardEventHandler,
  MouseEventHandler,
  ReactNode,
  SetStateAction,
  useEffect,
  useState,
} from 'react';

import { useTranslations } from 'next-intl';

import { useSettings } from '@/client/hooks/settings/useSettings';
import { useTones } from '@/client/hooks/settings/useTones';

import { Conversation, Message } from '@/types/chat';

import { useArtifactStore } from '@/client/stores/artifactStore';
import { Streamdown } from 'streamdown';

interface UserMessageProps {
  message: Message;
  messageContent: string;
  setMessageContent: Dispatch<SetStateAction<Message['content']>>;
  isEditing: boolean;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  handleInputChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => void;
  handlePressEnter: KeyboardEventHandler<HTMLTextAreaElement>;
  setIsTyping: Dispatch<SetStateAction<boolean>>;
  setIsEditing: Dispatch<SetStateAction<boolean>>;
  toggleEditing: (event: React.MouseEvent) => void;
  handleDeleteMessage: MouseEventHandler<HTMLButtonElement>;
  onEdit: (message: Message) => void;
  selectedConversation: Conversation | null;
  onRegenerate?: () => void;
  onSaveAsPrompt?: () => void;
  children?: ReactNode; // Allow custom content (images, files, etc.)
}

export const UserMessage: FC<UserMessageProps> = ({
  message,
  messageContent,
  setMessageContent,
  isEditing,
  textareaRef,
  handleInputChange,
  handlePressEnter,
  setIsTyping,
  selectedConversation,
  setIsEditing,
  toggleEditing,
  handleDeleteMessage,
  onEdit,
  onRegenerate,
  onSaveAsPrompt,
  children,
}) => {
  const t = useTranslations();
  const { tones } = useTones();
  const { prompts } = useSettings();
  const { openArtifact, openDocument } = useArtifactStore();
  const {
    role,
    content,
    messageType,
    toneId,
    promptId,
    promptVariables,
    artifactContext,
  } = message;
  const [localMessageContent, setLocalMessageContent] = useState<string>(
    content as string,
  );
  const [isPromptExpanded, setIsPromptExpanded] = useState(false);

  // Find the used prompt
  const usedPrompt = promptId ? prompts.find((p) => p.id === promptId) : null;

  const handleEditMessage = () => {
    if (localMessageContent !== content) {
      if (selectedConversation && onEdit) {
        onEdit({ ...message, content: localMessageContent });
        setMessageContent(localMessageContent);
      }
    }
    setIsEditing(false);
  };

  useEffect(() => {
    setLocalMessageContent(content as string);
  }, [content]);

  useEffect(() => {
    if (
      message.content !== messageContent &&
      typeof message.content === 'string'
    ) {
      setMessageContent(message.content);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message.content, messageContent]);

  // Check if message has attachments
  const hasAttachments = !!children;

  return (
    <div className="relative flex flex-col items-end px-4 py-1 text-base lg:px-0 w-full">
      <div
        className={`${hasAttachments ? 'w-full max-w-2xl' : 'inline-block max-w-[85%]'} bg-gray-200 dark:bg-[#323537] rounded-3xl px-4 text-gray-800 dark:text-white text-base`}
      >
        {isEditing ? (
          <div className="flex flex-col">
            <textarea
              ref={textareaRef}
              className="w-full resize-none whitespace-pre-wrap border-none bg-transparent text-gray-800 dark:text-white"
              value={localMessageContent}
              onChange={(event) => setLocalMessageContent(event.target.value)}
              onKeyDown={handlePressEnter}
              onCompositionStart={() => setIsTyping(true)}
              onCompositionEnd={() => setIsTyping(false)}
              style={{
                fontFamily: 'inherit',
                fontSize: 'inherit',
                lineHeight: 'inherit',
                padding: '0',
                margin: '0',
                overflow: 'hidden',
              }}
            />

            <div className="mt-10 flex justify-center space-x-4">
              <button
                className="h-[40px] rounded-md bg-blue-500 px-4 py-1 text-sm font-medium text-white enabled:hover:bg-blue-600 disabled:opacity-50"
                onClick={handleEditMessage}
                disabled={localMessageContent.trim().length <= 0}
              >
                {t('Save & Submit')}
              </button>
              <button
                className="h-[40px] rounded-md border border-neutral-300 px-4 py-1 text-sm font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                onClick={() => {
                  setLocalMessageContent(content as string);
                  setIsEditing(false);
                }}
              >
                {t('Cancel')}
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Artifact Context Badge */}
            {artifactContext && (
              <div className="py-2 border-b border-white/10 mb-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <IconCode size={16} className="text-blue-400" />
                    <span className="font-medium text-sm">
                      {artifactContext.fileName}
                    </span>
                    <span className="text-xs text-white/50">
                      ({artifactContext.language})
                    </span>
                  </div>
                  <button
                    onClick={(e) => {
                      e.preventDefault();

                      // Detect if this is a document type file
                      const ext = artifactContext.fileName
                        .split('.')
                        .pop()
                        ?.toLowerCase();
                      const documentExtensions = [
                        'md',
                        'markdown',
                        'txt',
                        'html',
                        'htm',
                      ];

                      if (ext && documentExtensions.includes(ext)) {
                        // Open as document with proper source format
                        const sourceFormatMap: Record<
                          string,
                          'md' | 'markdown' | 'txt' | 'html' | 'htm'
                        > = {
                          md: 'md',
                          markdown: 'markdown',
                          txt: 'txt',
                          html: 'html',
                          htm: 'htm',
                        };
                        const sourceFormat = sourceFormatMap[ext] || 'txt';
                        openDocument(
                          artifactContext.code,
                          sourceFormat,
                          artifactContext.fileName,
                          'document', // Start in document mode by default
                        );
                      } else {
                        // Open as code artifact
                        openArtifact(
                          artifactContext.code,
                          artifactContext.language,
                          artifactContext.fileName,
                        );
                      }
                    }}
                    className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-blue-400 hover:text-blue-300 hover:bg-blue-950/30 rounded transition-colors"
                    title="Open in editor"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="16 18 22 12 16 6"></polyline>
                      <polyline points="8 6 2 12 8 18"></polyline>
                    </svg>
                    <span>Open</span>
                  </button>
                </div>
              </div>
            )}

            {promptId && usedPrompt ? (
              <div className="py-1">
                {/* Collapsed view - show by default */}
                {!isPromptExpanded ? (
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <IconBraces size={16} className="text-blue-400" />
                      <span className="font-medium">{usedPrompt.name}</span>
                    </div>

                    {promptVariables &&
                      Object.keys(promptVariables).length > 0 && (
                        <div className="space-y-1.5 mb-3">
                          {Object.entries(promptVariables).map(
                            ([key, value]) => (
                              <div key={key} className="text-sm">
                                <span className="text-blue-300/70 font-mono text-xs">
                                  {key}:
                                </span>{' '}
                                <span className="text-white/90">{value}</span>
                              </div>
                            ),
                          )}
                        </div>
                      )}

                    <button
                      onClick={() => setIsPromptExpanded(true)}
                      className="text-xs text-white/50 hover:text-white/80 underline"
                    >
                      Show full message
                    </button>
                  </div>
                ) : (
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <IconBraces size={16} className="text-blue-400" />
                      <span className="font-medium">{usedPrompt.name}</span>
                    </div>

                    <div className="prose prose-invert prose-p:my-2 text-white max-w-none mb-2">
                      <Streamdown
                        controls={true}
                        shikiTheme={['github-light', 'github-dark']}
                      >
                        {localMessageContent}
                      </Streamdown>
                    </div>

                    <button
                      onClick={() => setIsPromptExpanded(false)}
                      className="text-xs text-white/50 hover:text-white/80 underline"
                    >
                      Collapse
                    </button>
                  </div>
                )}

                {/* Tone Badge */}
                {toneId && (
                  <div className="flex items-center gap-1.5 mt-3 pt-2 pb-1 border-t border-white/20">
                    <IconVolume
                      size={14}
                      className="text-purple-400 flex-shrink-0"
                    />
                    <span className="text-xs text-white/70">
                      {tones.find((t) => t.id === toneId)?.name ||
                        'Custom Tone'}
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <>
                {children || (
                  <div className="prose dark:prose-invert prose-p:my-2 text-gray-800 dark:text-white max-w-none">
                    <Streamdown
                      controls={true}
                      shikiTheme={['github-light', 'github-dark']}
                    >
                      {localMessageContent}
                    </Streamdown>
                  </div>
                )}
                {toneId && (
                  <div className="flex items-center gap-1.5 mt-2 pt-2 border-t border-gray-800/20 dark:border-white/20">
                    <IconVolume
                      size={14}
                      className="text-purple-400 flex-shrink-0"
                    />
                    <span className="text-xs text-gray-800/70 dark:text-white/70">
                      {tones.find((t) => t.id === toneId)?.name ||
                        'Custom Tone'}
                    </span>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>

      {!isEditing && (
        <div className="flex gap-2 mt-1">
          {onRegenerate && (
            <button
              className="visible md:invisible md:group-hover:visible focus:visible text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300 transition-colors"
              onClick={onRegenerate}
              aria-label={t('chat.retryMessage')}
            >
              <IconRefresh size={18} />
            </button>
          )}
          {onSaveAsPrompt && (
            <button
              className="visible md:invisible md:group-hover:visible focus:visible text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300 transition-colors"
              onClick={onSaveAsPrompt}
              aria-label={t('Save as prompt')}
              title={t('Save as prompt')}
            >
              <IconDeviceFloppy size={18} />
            </button>
          )}
          <button
            className="visible md:invisible md:group-hover:visible focus:visible text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300 transition-colors"
            onClick={toggleEditing}
            aria-label={t('chat.editMessage')}
          >
            <IconEdit size={18} />
          </button>
          <button
            className="visible md:invisible md:group-hover:visible focus:visible text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300 transition-colors"
            onClick={handleDeleteMessage}
            aria-label={t('chat.deleteMessage')}
          >
            <IconTrash size={18} />
          </button>
        </div>
      )}
    </div>
  );
};

export default UserMessage;
