import { useCallback, useState } from 'react';

import { useTranslations } from 'next-intl';

import { buildMessageContent } from '@/lib/utils/chat/contentBuilder';
import { validateMessageSubmission } from '@/lib/utils/chat/validation';

import {
  ChatInputSubmitTypes,
  FileFieldValue,
  FilePreview,
  ImageFieldValue,
  Message,
  MessageType,
} from '@/types/chat';
import { SearchMode } from '@/types/searchMode';

import { useArtifactStore } from '@/client/stores/artifactStore';

interface UseMessageSenderProps {
  textFieldValue: string;
  submitType: ChatInputSubmitTypes;
  imageFieldValue: ImageFieldValue;
  fileFieldValue: FileFieldValue;
  filePreviews: FilePreview[];
  uploadProgress: { [key: string]: number };
  selectedToneId: string | null;
  searchMode: SearchMode;
  onSend: (message: Message, searchMode?: SearchMode) => void;
  onClearInput: () => void;
  setSubmitType: React.Dispatch<React.SetStateAction<ChatInputSubmitTypes>>;
  setImageFieldValue: React.Dispatch<React.SetStateAction<ImageFieldValue>>;
  setFileFieldValue: React.Dispatch<React.SetStateAction<FileFieldValue>>;
  setFilePreviews: React.Dispatch<React.SetStateAction<FilePreview[]>>;
}

/**
 * Maps ChatInputSubmitTypes to MessageType enum
 */
const mapSubmitTypeToMessageType = (
  submitType: ChatInputSubmitTypes,
): MessageType => {
  const mapping: Record<ChatInputSubmitTypes, MessageType> = {
    TEXT: MessageType.TEXT,
    IMAGE: MessageType.IMAGE,
    FILE: MessageType.FILE,
    MULTI_FILE: MessageType.FILE, // Multi-file also maps to FILE
  };
  return mapping[submitType];
};

/**
 * Custom hook to manage message sending logic
 * Handles validation, content building, and sending
 */
export function useMessageSender({
  textFieldValue,
  submitType,
  imageFieldValue,
  fileFieldValue,
  filePreviews,
  uploadProgress,
  selectedToneId,
  searchMode,
  onSend,
  onClearInput,
  setSubmitType,
  setImageFieldValue,
  setFileFieldValue,
  setFilePreviews,
}: UseMessageSenderProps) {
  const t = useTranslations();
  const { getArtifactContext } = useArtifactStore();

  const [usedPromptId, setUsedPromptId] = useState<string | null>(null);
  const [usedPromptVariables, setUsedPromptVariables] = useState<{
    [key: string]: string;
  } | null>(null);

  const buildContent = useCallback(() => {
    // Don't prepend artifact context to content anymore
    // It will be attached as metadata
    return buildMessageContent(
      submitType,
      textFieldValue,
      imageFieldValue,
      fileFieldValue,
      null, // No longer prepending artifact context
    );
  }, [submitType, textFieldValue, imageFieldValue, fileFieldValue]);

  const handleSend = useCallback(async () => {
    const validation = validateMessageSubmission(
      textFieldValue,
      filePreviews,
      uploadProgress,
    );

    if (!validation.valid) {
      alert(t(validation.error || 'Cannot send message'));
      return;
    }

    // Get artifact context if editor is open
    const artifactContext = await getArtifactContext();

    // If we have an artifact context, remove any uploaded file that matches the artifact fileName
    // This prevents sending both the original upload AND the edited version
    let filteredFileFieldValue = fileFieldValue;
    if (artifactContext && fileFieldValue) {
      const fileArray = Array.isArray(fileFieldValue)
        ? fileFieldValue
        : [fileFieldValue];
      const filtered = fileArray.filter((file) => {
        if (
          file.type === 'file_url' &&
          file.originalFilename === artifactContext.fileName
        ) {
          return false; // Remove this file - we'll use artifact context instead
        }
        return true;
      });

      filteredFileFieldValue =
        filtered.length > 0
          ? filtered.length === 1
            ? filtered[0]
            : filtered
          : null;
    }

    // Build content with filtered file field value (if artifact is being edited)
    const content = buildMessageContent(
      submitType,
      textFieldValue,
      imageFieldValue,
      filteredFileFieldValue,
      null,
    );

    onSend(
      {
        role: 'user',
        content,
        messageType: mapSubmitTypeToMessageType(submitType ?? 'TEXT'),
        toneId: selectedToneId,
        promptId: usedPromptId,
        promptVariables: usedPromptVariables || undefined,
        artifactContext: artifactContext || undefined,
      },
      searchMode,
    );

    // Clear input state
    onClearInput();
    setImageFieldValue(null);
    setFileFieldValue(null);
    setSubmitType('TEXT');
    setUsedPromptId(null);
    setUsedPromptVariables(null);

    if (filePreviews.length > 0) {
      setFilePreviews([]);
    }
  }, [
    textFieldValue,
    filePreviews,
    uploadProgress,
    submitType,
    fileFieldValue,
    imageFieldValue,
    selectedToneId,
    searchMode,
    usedPromptId,
    usedPromptVariables,
    t,
    onSend,
    onClearInput,
    setImageFieldValue,
    setFileFieldValue,
    setSubmitType,
    setFilePreviews,
    getArtifactContext,
  ]);

  return {
    handleSend,
    usedPromptId,
    setUsedPromptId,
    usedPromptVariables,
    setUsedPromptVariables,
  };
}
