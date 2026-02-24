import { useCallback } from 'react';

import { useTranslations } from 'next-intl';

import { buildMessageContent } from '@/lib/utils/shared/chat/contentBuilder';
import { validateMessageSubmission } from '@/lib/utils/shared/chat/validation';

import {
  ChatInputSubmitTypes,
  FileFieldValue,
  FileMessageContent,
  FilePreview,
  ImageFieldValue,
  Message,
  MessageType,
} from '@/types/chat';
import { CodeInterpreterMode } from '@/types/codeInterpreter';
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
  usedPromptId: string | null;
  usedPromptVariables: { [key: string]: string } | null;
  searchMode: SearchMode;
  codeInterpreterMode: CodeInterpreterMode;
  onSend: (
    message: Message,
    searchMode?: SearchMode,
    codeInterpreterMode?: CodeInterpreterMode,
  ) => void;
  onClearInput: () => void;
  setSubmitType: React.Dispatch<React.SetStateAction<ChatInputSubmitTypes>>;
  setImageFieldValue: React.Dispatch<React.SetStateAction<ImageFieldValue>>;
  setFileFieldValue: React.Dispatch<React.SetStateAction<FileFieldValue>>;
  setFilePreviews: React.Dispatch<React.SetStateAction<FilePreview[]>>;
  setUsedPromptId: (id: string | null) => void;
  setUsedPromptVariables: (variables: { [key: string]: string } | null) => void;
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
 * Merges transcription options from FilePreviews into FileFieldValue.
 * This ensures transcriptionLanguage and transcriptionPrompt are passed to the server.
 */
const mergeTranscriptionOptions = (
  fileFieldValue: FileFieldValue,
  filePreviews: FilePreview[],
): FileFieldValue => {
  if (!fileFieldValue) return null;

  const fileArray = Array.isArray(fileFieldValue)
    ? fileFieldValue
    : [fileFieldValue];

  const merged = fileArray.map((file) => {
    if (file.type !== 'file_url') return file;

    // Find matching file preview by original filename
    const preview = filePreviews.find(
      (fp) => fp.name === file.originalFilename || fp.previewUrl === file.url,
    );

    if (!preview) return file;

    // Merge transcription options if present
    const fileMessage = file as FileMessageContent;
    return {
      ...fileMessage,
      transcriptionLanguage:
        preview.transcriptionLanguage || fileMessage.transcriptionLanguage,
      transcriptionPrompt:
        preview.transcriptionPrompt || fileMessage.transcriptionPrompt,
    };
  });

  return merged.length === 1 ? merged[0] : merged;
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
  usedPromptId,
  usedPromptVariables,
  searchMode,
  codeInterpreterMode,
  onSend,
  onClearInput,
  setSubmitType,
  setImageFieldValue,
  setFileFieldValue,
  setFilePreviews,
  setUsedPromptId,
  setUsedPromptVariables,
}: UseMessageSenderProps) {
  const t = useTranslations();
  const { getArtifactContext } = useArtifactStore();

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

    // Merge transcription options from file previews into file field value
    // This ensures user-selected language and prompt are passed to the server
    const fileFieldWithTranscriptionOptions = mergeTranscriptionOptions(
      fileFieldValue,
      filePreviews,
    );

    // Get artifact context if editor is open
    const artifactContext = await getArtifactContext();

    // If we have an artifact context, remove any uploaded file that matches the artifact fileName
    // This prevents sending both the original upload AND the edited version
    let filteredFileFieldValue = fileFieldWithTranscriptionOptions;
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
    // Content contains file references (e.g., /api/file/abc123.png) - NOT base64
    // ChatService.chat() converts to base64 at API call time to avoid bloating localStorage
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
      codeInterpreterMode,
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
    codeInterpreterMode,
    usedPromptId,
    usedPromptVariables,
    t,
    onSend,
    onClearInput,
    setImageFieldValue,
    setFileFieldValue,
    setSubmitType,
    setFilePreviews,
    setUsedPromptId,
    setUsedPromptVariables,
    getArtifactContext,
  ]);

  return {
    handleSend,
  };
}
