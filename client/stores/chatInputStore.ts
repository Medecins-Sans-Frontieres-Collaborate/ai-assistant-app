import {
  ChatInputSubmitTypes,
  FileFieldValue,
  FilePreview,
  ImageFieldValue,
  TranscriptionJobStatus,
} from '@/types/chat';
import { CodeInterpreterMode } from '@/types/codeInterpreter';
import { SearchMode } from '@/types/searchMode';

import { onFileUpload } from '@/client/handlers/chatInput/file-upload';
import { create } from 'zustand';

/**
 * Represents a pending batch transcription job
 */
export interface PendingTranscription {
  jobId: string;
  fileId: string;
  filename: string;
  status: TranscriptionJobStatus;
  startedAt: number;
}

interface ChatInputState {
  // Text input state
  textFieldValue: string;
  placeholderText: string;
  isTyping: boolean;
  isMultiline: boolean;
  isFocused: boolean;
  textareaScrollHeight: number;

  // Transcription state
  transcriptionStatus: string | null;
  isTranscribing: boolean;

  // Batch transcription tracking (for files >25MB)
  pendingTranscriptions: Map<string, PendingTranscription>;

  // Search mode, Code Interpreter mode & tone
  searchMode: SearchMode;
  codeInterpreterMode: CodeInterpreterMode;
  selectedToneId: string | null;

  // Upload state
  filePreviews: FilePreview[];
  fileFieldValue: FileFieldValue;
  imageFieldValue: ImageFieldValue;
  uploadProgress: { [key: string]: number };
  submitType: ChatInputSubmitTypes;

  // Prompt state
  usedPromptId: string | null;
  usedPromptVariables: { [key: string]: string } | null;

  // Actions - Text
  setTextFieldValue: (value: string | ((prev: string) => string)) => void;
  setPlaceholderText: (text: string) => void;
  setIsTyping: (typing: boolean) => void;
  setIsMultiline: (multiline: boolean) => void;
  setIsFocused: (focused: boolean) => void;
  setTextareaScrollHeight: (height: number) => void;

  // Actions - Transcription
  setTranscriptionStatus: (status: string | null) => void;
  setIsTranscribing: (transcribing: boolean) => void;

  // Actions - Batch Transcription
  addPendingTranscription: (fileId: string, job: PendingTranscription) => void;
  removePendingTranscription: (fileId: string) => void;
  updateTranscriptionStatus: (
    fileId: string,
    status: TranscriptionJobStatus,
  ) => void;

  // Actions - Search mode, Code Interpreter mode & tone
  setSearchMode: (mode: SearchMode) => void;
  setCodeInterpreterMode: (mode: CodeInterpreterMode) => void;
  setSelectedToneId: (id: string | null) => void;

  // Actions - Upload
  setFilePreviews: (
    previews: FilePreview[] | ((prev: FilePreview[]) => FilePreview[]),
  ) => void;
  setFileFieldValue: (
    value: FileFieldValue | ((prev: FileFieldValue) => FileFieldValue),
  ) => void;
  setImageFieldValue: (
    value: ImageFieldValue | ((prev: ImageFieldValue) => ImageFieldValue),
  ) => void;
  setUploadProgress: (
    progress:
      | { [key: string]: number }
      | ((prev: { [key: string]: number }) => { [key: string]: number }),
  ) => void;
  setSubmitType: (
    type:
      | ChatInputSubmitTypes
      | ((prev: ChatInputSubmitTypes) => ChatInputSubmitTypes),
  ) => void;
  handleFileUpload: (
    event: React.ChangeEvent<HTMLInputElement> | FileList | File[],
  ) => Promise<void>;

  // Actions - Prompt
  setUsedPromptId: (id: string | null) => void;
  setUsedPromptVariables: (variables: { [key: string]: string } | null) => void;

  // Actions - General
  clearInput: () => void;
  clearUploadState: () => void;
  resetForNewConversation: (
    defaultSearchMode?: SearchMode,
    defaultCodeInterpreterMode?: CodeInterpreterMode,
  ) => void;
}

export const useChatInputStore = create<ChatInputState>((set, get) => ({
  // Initial state - Text
  textFieldValue: '',
  placeholderText: '',
  isTyping: false,
  isMultiline: false,
  isFocused: false,
  textareaScrollHeight: 0,

  // Initial state - Transcription
  transcriptionStatus: null,
  isTranscribing: false,

  // Initial state - Batch Transcription
  pendingTranscriptions: new Map(),

  // Initial state - Search mode, Code Interpreter mode & tone
  searchMode: SearchMode.OFF,
  codeInterpreterMode: CodeInterpreterMode.INTELLIGENT,
  selectedToneId: null,

  // Initial state - Upload
  filePreviews: [],
  fileFieldValue: null,
  imageFieldValue: null,
  uploadProgress: {},
  submitType: 'TEXT',

  // Initial state - Prompt
  usedPromptId: null,
  usedPromptVariables: null,

  // Actions - Text
  setTextFieldValue: (value) =>
    set((state) => ({
      textFieldValue:
        typeof value === 'function' ? value(state.textFieldValue) : value,
    })),
  setPlaceholderText: (text) => set({ placeholderText: text }),
  setIsTyping: (typing) => set({ isTyping: typing }),
  setIsMultiline: (multiline) => set({ isMultiline: multiline }),
  setIsFocused: (focused) => set({ isFocused: focused }),
  setTextareaScrollHeight: (height) => set({ textareaScrollHeight: height }),

  // Actions - Transcription
  setTranscriptionStatus: (status) => set({ transcriptionStatus: status }),
  setIsTranscribing: (transcribing) => set({ isTranscribing: transcribing }),

  // Actions - Batch Transcription
  addPendingTranscription: (fileId, job) =>
    set((state) => {
      const newMap = new Map(state.pendingTranscriptions);
      newMap.set(fileId, job);
      return { pendingTranscriptions: newMap };
    }),
  removePendingTranscription: (fileId) =>
    set((state) => {
      const newMap = new Map(state.pendingTranscriptions);
      newMap.delete(fileId);
      return { pendingTranscriptions: newMap };
    }),
  updateTranscriptionStatus: (fileId, status) =>
    set((state) => {
      const existing = state.pendingTranscriptions.get(fileId);
      if (!existing) return state;

      const newMap = new Map(state.pendingTranscriptions);
      newMap.set(fileId, { ...existing, status });
      return { pendingTranscriptions: newMap };
    }),

  // Actions - Search mode, Code Interpreter mode & tone
  setSearchMode: (mode) => set({ searchMode: mode }),
  setCodeInterpreterMode: (mode) => set({ codeInterpreterMode: mode }),
  setSelectedToneId: (id) => set({ selectedToneId: id }),

  // Actions - Upload
  setFilePreviews: (previews) =>
    set((state) => ({
      filePreviews:
        typeof previews === 'function'
          ? previews(state.filePreviews)
          : previews,
    })),
  setFileFieldValue: (value) =>
    set((state) => ({
      fileFieldValue:
        typeof value === 'function' ? value(state.fileFieldValue) : value,
    })),
  setImageFieldValue: (value) =>
    set((state) => ({
      imageFieldValue:
        typeof value === 'function' ? value(state.imageFieldValue) : value,
    })),
  setUploadProgress: (progress) =>
    set((state) => ({
      uploadProgress:
        typeof progress === 'function'
          ? progress(state.uploadProgress)
          : progress,
    })),
  setSubmitType: (type) =>
    set((state) => ({
      submitType: typeof type === 'function' ? type(state.submitType) : type,
    })),
  handleFileUpload: async (event) => {
    await onFileUpload(
      event,
      get().setSubmitType,
      get().setFilePreviews,
      get().setFileFieldValue,
      get().setImageFieldValue,
      get().setUploadProgress,
    );
  },

  // Actions - Prompt
  setUsedPromptId: (id) => set({ usedPromptId: id }),
  setUsedPromptVariables: (variables) =>
    set({ usedPromptVariables: variables }),

  // Actions - General
  clearInput: () =>
    set({
      textFieldValue: '',
      selectedToneId: null,
    }),

  clearUploadState: () =>
    set({
      filePreviews: [],
      fileFieldValue: null,
      imageFieldValue: null,
      uploadProgress: {},
      submitType: 'TEXT',
      pendingTranscriptions: new Map(),
    }),

  resetForNewConversation: (
    defaultSearchMode = SearchMode.OFF,
    defaultCodeInterpreterMode = CodeInterpreterMode.INTELLIGENT,
  ) =>
    set({
      textFieldValue: '',
      searchMode: defaultSearchMode,
      codeInterpreterMode: defaultCodeInterpreterMode,
      selectedToneId: null,
      filePreviews: [],
      fileFieldValue: null,
      imageFieldValue: null,
      uploadProgress: {},
      submitType: 'TEXT',
      usedPromptId: null,
      usedPromptVariables: null,
      pendingTranscriptions: new Map(),
    }),
}));
