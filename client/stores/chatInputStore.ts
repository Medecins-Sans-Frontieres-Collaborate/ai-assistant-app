import {
  ChatInputSubmitTypes,
  FileFieldValue,
  FilePreview,
  ImageFieldValue,
} from '@/types/chat';
import { SearchMode } from '@/types/searchMode';

import { onFileUpload } from '@/client/handlers/chatInput/file-upload';
import { create } from 'zustand';

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

  // Search mode & tone
  searchMode: SearchMode;
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

  // Actions - Search mode & tone
  setSearchMode: (mode: SearchMode) => void;
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
  resetForNewConversation: (defaultSearchMode?: SearchMode) => void;
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

  // Initial state - Search mode & tone
  searchMode: SearchMode.OFF,
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

  // Actions - Search mode & tone
  setSearchMode: (mode) => set({ searchMode: mode }),
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
    }),

  resetForNewConversation: (defaultSearchMode = SearchMode.OFF) =>
    set({
      textFieldValue: '',
      searchMode: defaultSearchMode,
      selectedToneId: null,
      filePreviews: [],
      fileFieldValue: null,
      imageFieldValue: null,
      uploadProgress: {},
      submitType: 'TEXT',
      usedPromptId: null,
      usedPromptVariables: null,
    }),
}));
