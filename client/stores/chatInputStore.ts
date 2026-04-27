import {
  ChatInputSubmitTypes,
  FileFieldValue,
  FilePreview,
  ImageFieldValue,
  ImageMessageContent,
  TranscriptionJobStatus,
} from '@/types/chat';
import { SearchMode } from '@/types/searchMode';

import { onFileUpload } from '@/client/handlers/chatInput/file-upload';
import { create } from 'zustand';

/**
 * Revoke an object URL created via URL.createObjectURL. Safe to call on
 * non-blob URLs (no-op for http/https refs from completed uploads). Wrapped
 * in try/catch because revoke can throw on browsers that have already GC'd
 * the underlying Blob.
 */
function revokeIfBlobUrl(url: string | undefined | null): void {
  if (!url || !url.startsWith('blob:')) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    /* already revoked or unsupported — nothing to do */
  }
}

/** Revoke every blob: preview URL in the array (no-op for non-blob URLs). */
function revokeAllPreviewUrls(previews: FilePreview[]): void {
  for (const preview of previews) {
    revokeIfBlobUrl(preview.previewUrl);
  }
}

/**
 * Remove items matching `predicate` from a value that's either a single
 * item, an array of items, or null. Returns the same shape, collapsing
 * empty arrays to null. Used by `removeFile` to prune the file/image
 * field-value containers without four near-identical branches.
 */
function removeMatching<T>(
  value: T | T[] | null,
  predicate: (item: T) => boolean,
): T | T[] | null {
  if (value === null) return null;
  if (Array.isArray(value)) {
    const next = value.filter((item) => !predicate(item));
    return next.length === 0 ? null : next;
  }
  return predicate(value) ? null : value;
}

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

  // Search mode & tone
  searchMode: SearchMode;
  selectedToneId: string | null;

  // Upload state
  filePreviews: FilePreview[];
  fileFieldValue: FileFieldValue;
  imageFieldValue: ImageFieldValue;
  uploadProgress: { [key: string]: number };
  submitType: ChatInputSubmitTypes;
  // Cancels the in-flight upload batch. Lives outside React state so that
  // aborting it doesn't trigger a re-render. Per-batch (not per-file): when
  // the user removes any file from a batch, the still-queued and in-flight
  // uploads are cancelled together. Already-completed uploads are unaffected.
  uploadAbortController: AbortController | null;

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
  removeFile: (filePreview: FilePreview) => void;

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

  // Initial state - Batch Transcription
  pendingTranscriptions: new Map(),

  // Initial state - Search mode & tone
  searchMode: SearchMode.OFF,
  selectedToneId: null,

  // Initial state - Upload
  filePreviews: [],
  fileFieldValue: null,
  imageFieldValue: null,
  uploadProgress: {},
  submitType: 'TEXT',
  uploadAbortController: null,

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
    // Abort any prior in-flight batch — onFileUpload starts a fresh batch.
    const prior = get().uploadAbortController;
    if (prior && !prior.signal.aborted) {
      prior.abort();
    }
    const controller = new AbortController();
    set({ uploadAbortController: controller });
    try {
      await onFileUpload(
        event,
        get().setSubmitType,
        get().setFilePreviews,
        get().setFileFieldValue,
        get().setImageFieldValue,
        get().setUploadProgress,
        controller.signal,
      );
    } finally {
      // Only clear if this is still the current controller — a newer batch
      // may have started before this one finished.
      if (get().uploadAbortController === controller) {
        set({ uploadAbortController: null });
      }
    }
  },

  removeFile: (filePreview) =>
    set((state) => {
      // If the file being removed isn't already in a terminal state, cancel
      // the batch so we don't waste bandwidth and so server-side cleanup can
      // run (cancelChunkedUploadAction releases any committed remnants).
      // Includes 'pending' — a queued file whose preview is removed should
      // not silently land in imageFieldValue/fileFieldValue when its turn
      // comes up in the upload loop.
      const shouldCancelBatch =
        filePreview.status === 'pending' ||
        filePreview.status === 'uploading' ||
        filePreview.status === 'extracting';
      if (
        shouldCancelBatch &&
        state.uploadAbortController &&
        !state.uploadAbortController.signal.aborted
      ) {
        state.uploadAbortController.abort();
      }

      // Release the preview's object URL — `URL.createObjectURL` retains the
      // underlying Blob until revoked, so without this each removed image
      // leaks its full bytes for the rest of the session.
      revokeIfBlobUrl(filePreview.previewUrl);

      const newPreviews = state.filePreviews.filter((fp) => fp !== filePreview);

      // Match an image-field entry to this preview by the server URL we
      // stored on completion. `previewUrl` is a `blob:` URL and never
      // equals `image_url.url` (which is `/api/file/{hash}.{ext}`), so the
      // earlier comparison silently never matched.
      const matchesImageEntry = (img: ImageMessageContent): boolean =>
        !!filePreview.uploadedUrl &&
        img.image_url.url === filePreview.uploadedUrl;

      // fileFieldValue holds a mix: file entries are matched by filename;
      // image entries (when files+images are mixed) by the server URL.
      const newFileFieldValue = removeMatching(
        state.fileFieldValue,
        (entry) => {
          if ('originalFilename' in entry) {
            return entry.originalFilename === filePreview.name;
          }
          if ('image_url' in entry) {
            return matchesImageEntry(entry);
          }
          return false;
        },
      );

      const newImageFieldValue = removeMatching(
        state.imageFieldValue,
        matchesImageEntry,
      );

      // Clean up uploadProgress for this file
      const { [filePreview.name]: _, ...newProgress } = state.uploadProgress;

      return {
        filePreviews: newPreviews,
        fileFieldValue: newFileFieldValue,
        imageFieldValue: newImageFieldValue,
        uploadProgress: newProgress,
        submitType: newPreviews.length === 0 ? 'TEXT' : state.submitType,
      };
    }),

  // Actions - Prompt
  setUsedPromptId: (id) => set({ usedPromptId: id }),
  setUsedPromptVariables: (variables) =>
    set({ usedPromptVariables: variables }),

  // Actions - General
  clearInput: () =>
    set({
      textFieldValue: '',
      selectedToneId: null,
      usedPromptId: null,
      usedPromptVariables: null,
    }),

  clearUploadState: () => {
    const prior = get().uploadAbortController;
    if (prior && !prior.signal.aborted) {
      prior.abort();
    }
    revokeAllPreviewUrls(get().filePreviews);
    set({
      uploadAbortController: null,
      filePreviews: [],
      fileFieldValue: null,
      imageFieldValue: null,
      uploadProgress: {},
      submitType: 'TEXT',
      pendingTranscriptions: new Map(),
    });
  },

  resetForNewConversation: (defaultSearchMode = SearchMode.OFF) => {
    const prior = get().uploadAbortController;
    if (prior && !prior.signal.aborted) {
      prior.abort();
    }
    revokeAllPreviewUrls(get().filePreviews);
    set({
      uploadAbortController: null,
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
      pendingTranscriptions: new Map(),
    });
  },
}));
