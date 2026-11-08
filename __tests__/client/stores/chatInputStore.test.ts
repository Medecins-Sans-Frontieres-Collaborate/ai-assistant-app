import { InterpreterMode } from '@/types/interpreterMode';
import { SearchMode } from '@/types/searchMode';

import { onFileUpload } from '@/client/handlers/chatInput/file-upload';
import { useChatInputStore } from '@/client/stores/chatInputStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the file-upload handler to avoid next-auth import chain
vi.mock('@/client/handlers/chatInput/file-upload', () => ({
  onFileUpload: vi.fn(),
}));

describe('chatInputStore', () => {
  beforeEach(() => {
    useChatInputStore.setState({
      textFieldValue: '',
      placeholderText: '',
      isTyping: false,
      isMultiline: false,
      isFocused: false,
      textareaScrollHeight: 0,
      transcriptionStatus: null,
      isTranscribing: false,
      pendingTranscriptions: new Map(),
      searchMode: SearchMode.OFF,
      selectedToneId: null,
      filePreviews: [],
      fileFieldValue: null,
      imageFieldValue: null,
      uploadProgress: {},
      submitType: 'TEXT',
      usedPromptId: null,
      usedPromptVariables: null,
    });
  });

  describe('clearInput', () => {
    it('clears text field value', () => {
      useChatInputStore.setState({ textFieldValue: 'Hello world' });

      useChatInputStore.getState().clearInput();

      expect(useChatInputStore.getState().textFieldValue).toBe('');
    });

    it('clears selectedToneId', () => {
      useChatInputStore.setState({ selectedToneId: 'tone-123' });

      useChatInputStore.getState().clearInput();

      expect(useChatInputStore.getState().selectedToneId).toBeNull();
    });

    it('clears usedPromptId', () => {
      useChatInputStore.setState({ usedPromptId: 'prompt-456' });

      useChatInputStore.getState().clearInput();

      expect(useChatInputStore.getState().usedPromptId).toBeNull();
    });

    it('clears usedPromptVariables', () => {
      useChatInputStore.setState({
        usedPromptVariables: { topic: 'testing', language: 'TypeScript' },
      });

      useChatInputStore.getState().clearInput();

      expect(useChatInputStore.getState().usedPromptVariables).toBeNull();
    });

    it('clears all input state together', () => {
      useChatInputStore.setState({
        textFieldValue: 'Some message',
        selectedToneId: 'tone-professional',
        usedPromptId: 'prompt-abc',
        usedPromptVariables: { key: 'value' },
      });

      useChatInputStore.getState().clearInput();

      const state = useChatInputStore.getState();
      expect(state.textFieldValue).toBe('');
      expect(state.selectedToneId).toBeNull();
      expect(state.usedPromptId).toBeNull();
      expect(state.usedPromptVariables).toBeNull();
    });

    it('does not affect upload state', () => {
      useChatInputStore.setState({
        textFieldValue: 'text',
        submitType: 'FILE',
        filePreviews: [
          {
            name: 'test.pdf',
            size: 1000,
            previewUrl: '/test',
            status: 'ready',
          },
        ],
      });

      useChatInputStore.getState().clearInput();

      const state = useChatInputStore.getState();
      expect(state.submitType).toBe('FILE');
      expect(state.filePreviews).toHaveLength(1);
    });
  });

  describe('clearUploadState', () => {
    it('clears upload-related fields but not prompt state', () => {
      useChatInputStore.setState({
        filePreviews: [
          {
            name: 'test.pdf',
            size: 1000,
            previewUrl: '/test',
            status: 'ready',
          },
        ],
        fileFieldValue: {
          type: 'file_url',
          url: '/test',
          originalFilename: 'test.pdf',
        },
        imageFieldValue: { type: 'image_url', image_url: { url: '/img' } },
        uploadProgress: { file1: 50 },
        submitType: 'FILE',
        usedPromptId: 'prompt-abc',
      });

      useChatInputStore.getState().clearUploadState();

      const state = useChatInputStore.getState();
      expect(state.filePreviews).toEqual([]);
      expect(state.fileFieldValue).toBeNull();
      expect(state.imageFieldValue).toBeNull();
      expect(state.uploadProgress).toEqual({});
      expect(state.submitType).toBe('TEXT');
      // Prompt state should NOT be cleared by clearUploadState
      expect(state.usedPromptId).toBe('prompt-abc');
    });
  });

  describe('resetForNewConversation', () => {
    it('clears all state including prompt fields', () => {
      useChatInputStore.setState({
        textFieldValue: 'Hello',
        searchMode: SearchMode.INTELLIGENT,
        selectedToneId: 'tone-1',
        usedPromptId: 'prompt-1',
        usedPromptVariables: { var: 'val' },
        filePreviews: [
          { name: 'f.txt', size: 100, previewUrl: '/f', status: 'ready' },
        ],
        submitType: 'FILE',
      });

      useChatInputStore.getState().resetForNewConversation();

      const state = useChatInputStore.getState();
      expect(state.textFieldValue).toBe('');
      expect(state.searchMode).toBe(SearchMode.OFF);
      expect(state.selectedToneId).toBeNull();
      expect(state.usedPromptId).toBeNull();
      expect(state.usedPromptVariables).toBeNull();
      expect(state.filePreviews).toEqual([]);
      expect(state.submitType).toBe('TEXT');
    });

    it('accepts a default search mode', () => {
      useChatInputStore
        .getState()
        .resetForNewConversation(SearchMode.INTELLIGENT);

      expect(useChatInputStore.getState().searchMode).toBe(
        SearchMode.INTELLIGENT,
      );
    });

    it('resets interpreterMode to OFF by default', () => {
      useChatInputStore.setState({
        interpreterMode: InterpreterMode.ALWAYS,
      });

      useChatInputStore.getState().resetForNewConversation();

      expect(useChatInputStore.getState().interpreterMode).toBe(
        InterpreterMode.OFF,
      );
    });

    it('accepts a default interpreter mode', () => {
      useChatInputStore
        .getState()
        .resetForNewConversation(SearchMode.OFF, InterpreterMode.INTELLIGENT);

      expect(useChatInputStore.getState().interpreterMode).toBe(
        InterpreterMode.INTELLIGENT,
      );
    });
  });

  describe('setInterpreterMode', () => {
    it('updates interpreterMode', () => {
      useChatInputStore.getState().setInterpreterMode(InterpreterMode.ALWAYS);

      expect(useChatInputStore.getState().interpreterMode).toBe(
        InterpreterMode.ALWAYS,
      );
    });
  });

  describe('prompt state actions', () => {
    it('sets usedPromptId', () => {
      useChatInputStore.getState().setUsedPromptId('prompt-123');

      expect(useChatInputStore.getState().usedPromptId).toBe('prompt-123');
    });

    it('clears usedPromptId with null', () => {
      useChatInputStore.setState({ usedPromptId: 'prompt-123' });

      useChatInputStore.getState().setUsedPromptId(null);

      expect(useChatInputStore.getState().usedPromptId).toBeNull();
    });

    it('sets usedPromptVariables', () => {
      const variables = { topic: 'AI', format: 'markdown' };

      useChatInputStore.getState().setUsedPromptVariables(variables);

      expect(useChatInputStore.getState().usedPromptVariables).toEqual(
        variables,
      );
    });

    it('clears usedPromptVariables with null', () => {
      useChatInputStore.setState({
        usedPromptVariables: { key: 'value' },
      });

      useChatInputStore.getState().setUsedPromptVariables(null);

      expect(useChatInputStore.getState().usedPromptVariables).toBeNull();
    });
  });

  describe('handleFileUpload batches', () => {
    it('runs a second selection alongside the first instead of aborting it', async () => {
      const signals: AbortSignal[] = [];
      const releases: Array<() => void> = [];
      vi.mocked(onFileUpload).mockImplementation(
        async (_e, _a, _b, _c, _d, _f, signal) => {
          signals.push(signal as AbortSignal);
          await new Promise<void>((resolve) => releases.push(resolve));
        },
      );
      const a = new File(['a'], 'a.pdf');
      const b = new File(['b'], 'b.pdf');
      const first = useChatInputStore.getState().handleFileUpload([a]);
      const second = useChatInputStore.getState().handleFileUpload([b]);

      expect(signals).toHaveLength(2);
      expect(signals[0].aborted).toBe(false);
      expect(useChatInputStore.getState().uploadBatches).toHaveLength(2);

      // Removing an in-flight file cancels only the batch carrying it.
      useChatInputStore.getState().removeFile({
        name: 'b.pdf',
        type: '',
        status: 'uploading',
        previewUrl: '',
        file: b,
      });
      expect(signals[1].aborted).toBe(true);
      expect(signals[0].aborted).toBe(false);

      releases.forEach((release) => release());
      await Promise.all([first, second]);
      expect(useChatInputStore.getState().uploadBatches).toHaveLength(0);
    });

    it('passes the composer previews so per-message limits see them', async () => {
      vi.mocked(onFileUpload).mockResolvedValue(undefined);
      const existing = [
        {
          name: 'x.pdf',
          type: 'application/pdf',
          status: 'completed' as const,
          previewUrl: '',
        },
      ];
      useChatInputStore.setState({ filePreviews: existing });
      await useChatInputStore
        .getState()
        .handleFileUpload([new File(['y'], 'y.pdf')]);
      expect(vi.mocked(onFileUpload).mock.calls.at(-1)?.[7]).toEqual(existing);
    });

    it('clearUploadState aborts every batch in flight', async () => {
      const signals: AbortSignal[] = [];
      vi.mocked(onFileUpload).mockImplementation(
        async (_e, _a, _b, _c, _d, _f, signal) => {
          signals.push(signal as AbortSignal);
          await new Promise(() => {});
        },
      );
      void useChatInputStore
        .getState()
        .handleFileUpload([new File(['a'], 'a.pdf')]);
      void useChatInputStore
        .getState()
        .handleFileUpload([new File(['b'], 'b.pdf')]);
      useChatInputStore.getState().clearUploadState();
      expect(signals.every((s) => s.aborted)).toBe(true);
      expect(useChatInputStore.getState().uploadBatches).toHaveLength(0);
    });
  });
});
