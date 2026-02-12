import { useMessageSender } from '@/client/hooks/chat/useMessageSender';

import { Message, MessageType } from '@/types/chat';
import { SearchMode } from '@/types/searchMode';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dependencies before imports
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock('@/client/stores/artifactStore', () => ({
  useArtifactStore: () => ({
    getArtifactContext: vi.fn().mockResolvedValue(null),
  }),
}));

vi.mock('@/lib/utils/shared/chat/contentBuilder', () => ({
  buildMessageContent: vi.fn(
    (_submitType: string, text: string) => text || 'built-content',
  ),
}));

// Must mock react since we're in node environment, not jsdom
vi.mock('react', () => ({
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  useCallback: (fn: Function) => fn,
}));

/**
 * Creates default props for useMessageSender with optional overrides.
 * In node environment, useCallback is mocked to return the function directly,
 * so we can call handleSend without renderHook.
 */
function createDefaultProps(
  overrides: Partial<Parameters<typeof useMessageSender>[0]> = {},
) {
  return {
    textFieldValue: 'Hello',
    submitType: 'TEXT' as const,
    imageFieldValue: null,
    fileFieldValue: null,
    filePreviews: [],
    uploadProgress: {},
    selectedToneId: null,
    usedPromptId: null,
    usedPromptVariables: null,
    searchMode: SearchMode.OFF,
    onSend: vi.fn(),
    onClearInput: vi.fn(),
    setSubmitType: vi.fn(),
    setImageFieldValue: vi.fn(),
    setFileFieldValue: vi.fn(),
    setFilePreviews: vi.fn(),
    setUsedPromptId: vi.fn(),
    setUsedPromptVariables: vi.fn(),
    ...overrides,
  };
}

describe('useMessageSender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock alert for validation errors
    globalThis.alert = vi.fn();
  });

  describe('promptId and promptVariables on sent messages', () => {
    it('includes promptId on the message when usedPromptId is set', async () => {
      const onSend = vi.fn();
      const props = createDefaultProps({
        usedPromptId: 'prompt-abc-123',
        onSend,
      });

      const { handleSend } = useMessageSender(props);
      await handleSend();

      expect(onSend).toHaveBeenCalledTimes(1);
      const sentMessage: Message = onSend.mock.calls[0][0];
      expect(sentMessage.promptId).toBe('prompt-abc-123');
    });

    it('includes promptVariables on the message when set', async () => {
      const onSend = vi.fn();
      const variables = { topic: 'TypeScript', format: 'markdown' };
      const props = createDefaultProps({
        usedPromptId: 'prompt-xyz',
        usedPromptVariables: variables,
        onSend,
      });

      const { handleSend } = useMessageSender(props);
      await handleSend();

      const sentMessage: Message = onSend.mock.calls[0][0];
      expect(sentMessage.promptId).toBe('prompt-xyz');
      expect(sentMessage.promptVariables).toEqual(variables);
    });

    it('sends promptId as null when no prompt is used', async () => {
      const onSend = vi.fn();
      const props = createDefaultProps({
        usedPromptId: null,
        usedPromptVariables: null,
        onSend,
      });

      const { handleSend } = useMessageSender(props);
      await handleSend();

      const sentMessage: Message = onSend.mock.calls[0][0];
      expect(sentMessage.promptId).toBeNull();
      expect(sentMessage.promptVariables).toBeUndefined();
    });

    it('converts null promptVariables to undefined on the message', async () => {
      const onSend = vi.fn();
      const props = createDefaultProps({
        usedPromptId: 'prompt-1',
        usedPromptVariables: null,
        onSend,
      });

      const { handleSend } = useMessageSender(props);
      await handleSend();

      const sentMessage: Message = onSend.mock.calls[0][0];
      expect(sentMessage.promptVariables).toBeUndefined();
    });
  });

  describe('toneId on sent messages', () => {
    it('includes toneId on the message when selectedToneId is set', async () => {
      const onSend = vi.fn();
      const props = createDefaultProps({
        selectedToneId: 'tone-professional',
        onSend,
      });

      const { handleSend } = useMessageSender(props);
      await handleSend();

      const sentMessage: Message = onSend.mock.calls[0][0];
      expect(sentMessage.toneId).toBe('tone-professional');
    });

    it('sends toneId as null when no tone is selected', async () => {
      const onSend = vi.fn();
      const props = createDefaultProps({
        selectedToneId: null,
        onSend,
      });

      const { handleSend } = useMessageSender(props);
      await handleSend();

      const sentMessage: Message = onSend.mock.calls[0][0];
      expect(sentMessage.toneId).toBeNull();
    });
  });

  describe('state clearing after send', () => {
    it('calls setUsedPromptId(null) after sending', async () => {
      const setUsedPromptId = vi.fn();
      const props = createDefaultProps({
        usedPromptId: 'prompt-123',
        setUsedPromptId,
      });

      const { handleSend } = useMessageSender(props);
      await handleSend();

      expect(setUsedPromptId).toHaveBeenCalledWith(null);
    });

    it('calls setUsedPromptVariables(null) after sending', async () => {
      const setUsedPromptVariables = vi.fn();
      const props = createDefaultProps({
        usedPromptVariables: { key: 'value' },
        setUsedPromptVariables,
      });

      const { handleSend } = useMessageSender(props);
      await handleSend();

      expect(setUsedPromptVariables).toHaveBeenCalledWith(null);
    });

    it('calls onClearInput after sending', async () => {
      const onClearInput = vi.fn();
      const props = createDefaultProps({ onClearInput });

      const { handleSend } = useMessageSender(props);
      await handleSend();

      expect(onClearInput).toHaveBeenCalledTimes(1);
    });

    it('resets submitType to TEXT after sending', async () => {
      const setSubmitType = vi.fn();
      const props = createDefaultProps({
        submitType: 'FILE',
        setSubmitType,
      });

      const { handleSend } = useMessageSender(props);
      await handleSend();

      expect(setSubmitType).toHaveBeenCalledWith('TEXT');
    });
  });

  describe('message structure', () => {
    it('sends message with correct role and messageType', async () => {
      const onSend = vi.fn();
      const props = createDefaultProps({ onSend });

      const { handleSend } = useMessageSender(props);
      await handleSend();

      const sentMessage: Message = onSend.mock.calls[0][0];
      expect(sentMessage.role).toBe('user');
      expect(sentMessage.messageType).toBe(MessageType.TEXT);
    });

    it('passes searchMode as second argument to onSend', async () => {
      const onSend = vi.fn();
      const props = createDefaultProps({
        searchMode: SearchMode.INTELLIGENT,
        onSend,
      });

      const { handleSend } = useMessageSender(props);
      await handleSend();

      expect(onSend).toHaveBeenCalledWith(
        expect.any(Object),
        SearchMode.INTELLIGENT,
      );
    });

    it('includes all metadata fields together', async () => {
      const onSend = vi.fn();
      const props = createDefaultProps({
        selectedToneId: 'tone-friendly',
        usedPromptId: 'prompt-summarize',
        usedPromptVariables: { length: 'short' },
        onSend,
      });

      const { handleSend } = useMessageSender(props);
      await handleSend();

      const sentMessage: Message = onSend.mock.calls[0][0];
      expect(sentMessage.toneId).toBe('tone-friendly');
      expect(sentMessage.promptId).toBe('prompt-summarize');
      expect(sentMessage.promptVariables).toEqual({ length: 'short' });
    });
  });

  describe('validation', () => {
    it('does not send when text is empty and no files attached', async () => {
      const onSend = vi.fn();
      const props = createDefaultProps({
        textFieldValue: '',
        filePreviews: [],
        onSend,
      });

      const { handleSend } = useMessageSender(props);
      await handleSend();

      expect(onSend).not.toHaveBeenCalled();
    });

    it('does not send when files are still uploading', async () => {
      const onSend = vi.fn();
      const props = createDefaultProps({
        uploadProgress: { 'file-1': 50 },
        onSend,
      });

      const { handleSend } = useMessageSender(props);
      await handleSend();

      expect(onSend).not.toHaveBeenCalled();
    });
  });
});
