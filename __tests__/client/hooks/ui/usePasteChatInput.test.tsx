/**
 * @vitest-environment jsdom
 */
import { renderHook } from '@testing-library/react';

import { usePasteChatInput } from '@/client/hooks/ui/usePasteChatInput';

import { SearchMode } from '@/types/searchMode';

import { useChatInputStore } from '@/client/stores/chatInputStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import { useUIStore } from '@/client/stores/uiStore';
import { Mock, beforeEach, describe, expect, it, vi } from 'vitest';

const mockAttachUrl = vi.hoisted(() => vi.fn());
vi.mock('@/client/hooks/chat/useUrlAttachment', () => ({
  useUrlAttachment: () => ({ attachUrl: mockAttachUrl }),
}));

function createPasteEvent(options: {
  imageFiles?: File[];
  text?: string;
  target?: EventTarget;
}): ClipboardEvent {
  const event = new Event('paste', {
    bubbles: true,
    cancelable: true,
  }) as ClipboardEvent;
  const items = (options.imageFiles ?? []).map((file) => ({
    kind: 'file',
    type: file.type,
    getAsFile: () => file,
  }));
  Object.defineProperty(event, 'clipboardData', {
    configurable: true,
    value: {
      items,
      files: options.imageFiles ?? [],
      getData: () => options.text ?? '',
    },
  });
  if (options.target) {
    Object.defineProperty(event, 'target', {
      configurable: true,
      value: options.target,
    });
  }
  return event;
}

describe('usePasteChatInput', () => {
  let handleFileUpload: Mock;

  beforeEach(() => {
    handleFileUpload = vi.fn().mockResolvedValue(undefined);

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
      handleFileUpload,
    });

    useUIStore.setState({
      isSettingsOpen: false,
      isBotModalOpen: false,
      isTermsModalOpen: false,
      loading: false,
    });

    mockAttachUrl.mockReset();
    mockAttachUrl.mockResolvedValue(undefined);
    useSettingsStore.setState({ autoFetchPastedLinks: true });
  });

  function setup(enabled = true) {
    const textarea = document.createElement('textarea');
    const focusSpy = vi.spyOn(textarea, 'focus');
    const textareaRef = { current: textarea };

    renderHook(() => usePasteChatInput({ textareaRef, enabled }));

    return { textarea, focusSpy };
  }

  it('uploads a pasted image with a unique name and focuses the textarea', () => {
    const { focusSpy } = setup();
    const image = new File(['x'], 'image.png', { type: 'image/png' });

    const dispatchResult = window.dispatchEvent(
      createPasteEvent({ imageFiles: [image], target: document.body }),
    );

    expect(dispatchResult).toBe(false);
    expect(handleFileUpload).toHaveBeenCalledTimes(1);
    const files = handleFileUpload.mock.calls[0][0] as File[];
    expect(files).toHaveLength(1);
    expect(files[0].name).toMatch(/^pasted-image-\d+-0\.png$/);
    expect(files[0].type).toBe('image/png');
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it('refocuses the textarea after the upload settles', async () => {
    const { focusSpy } = setup();
    const image = new File(['x'], 'image.png', { type: 'image/png' });

    window.dispatchEvent(
      createPasteEvent({ imageFiles: [image], target: document.body }),
    );

    expect(focusSpy).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(focusSpy).toHaveBeenCalledTimes(2);
  });

  it('does not steal focus after upload if another control is focused', async () => {
    const { focusSpy } = setup();
    const otherInput = document.createElement('input');
    document.body.appendChild(otherInput);
    const image = new File(['x'], 'image.png', { type: 'image/png' });

    window.dispatchEvent(
      createPasteEvent({ imageFiles: [image], target: document.body }),
    );
    otherInput.focus();

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(focusSpy).toHaveBeenCalledTimes(1);
    document.body.removeChild(otherInput);
  });

  it('uploads a pasted image when the chat textarea itself is the target', () => {
    const { textarea } = setup();
    const image = new File(['x'], 'image.png', { type: 'image/png' });

    window.dispatchEvent(
      createPasteEvent({ imageFiles: [image], target: textarea }),
    );

    expect(handleFileUpload).toHaveBeenCalledTimes(1);
  });

  it('does not hijack pastes into other inputs', () => {
    const { focusSpy } = setup();
    const otherInput = document.createElement('input');
    const image = new File(['x'], 'image.png', { type: 'image/png' });

    const dispatchResult = window.dispatchEvent(
      createPasteEvent({ imageFiles: [image], target: otherInput }),
    );

    expect(dispatchResult).toBe(true);
    expect(handleFileUpload).not.toHaveBeenCalled();
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it('gives multiple pasted images unique names', () => {
    setup();
    const images = [
      new File(['a'], 'image.png', { type: 'image/png' }),
      new File(['b'], 'image.png', { type: 'image/jpeg' }),
    ];

    window.dispatchEvent(
      createPasteEvent({ imageFiles: images, target: document.body }),
    );

    const files = handleFileUpload.mock.calls[0][0] as File[];
    expect(files).toHaveLength(2);
    expect(files[0].name).not.toBe(files[1].name);
    expect(files[1].name).toMatch(/\.jpeg$/);
  });

  it('attaches the image and drops the text on mixed clipboard content', () => {
    setup();
    const image = new File(['x'], 'image.png', { type: 'image/png' });

    window.dispatchEvent(
      createPasteEvent({
        imageFiles: [image],
        text: 'copied text',
        target: document.body,
      }),
    );

    expect(handleFileUpload).toHaveBeenCalledTimes(1);
    expect(useChatInputStore.getState().textFieldValue).toBe('');
  });

  it('appends pasted text and focuses the textarea when unfocused', () => {
    const { focusSpy } = setup();
    useChatInputStore.setState({ textFieldValue: 'hello ' });

    const dispatchResult = window.dispatchEvent(
      createPasteEvent({ text: 'world', target: document.body }),
    );

    expect(dispatchResult).toBe(false);
    expect(useChatInputStore.getState().textFieldValue).toBe('hello world');
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it('leaves text pastes into the chat textarea to native handling', () => {
    const { textarea, focusSpy } = setup();

    const dispatchResult = window.dispatchEvent(
      createPasteEvent({ text: 'native paste', target: textarea }),
    );

    expect(dispatchResult).toBe(true);
    expect(useChatInputStore.getState().textFieldValue).toBe('');
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it('ignores pastes while a modal is open', () => {
    setup();
    useUIStore.setState({ isSettingsOpen: true });
    const image = new File(['x'], 'image.png', { type: 'image/png' });

    window.dispatchEvent(
      createPasteEvent({ imageFiles: [image], target: document.body }),
    );
    window.dispatchEvent(
      createPasteEvent({ text: 'text', target: document.body }),
    );

    expect(handleFileUpload).not.toHaveBeenCalled();
    expect(useChatInputStore.getState().textFieldValue).toBe('');
  });

  it('does nothing when disabled', () => {
    const { focusSpy } = setup(false);
    const image = new File(['x'], 'image.png', { type: 'image/png' });

    window.dispatchEvent(
      createPasteEvent({ imageFiles: [image], target: document.body }),
    );

    expect(handleFileUpload).not.toHaveBeenCalled();
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it('ignores pastes with no images and no text', () => {
    const { focusSpy } = setup();

    const dispatchResult = window.dispatchEvent(
      createPasteEvent({ target: document.body }),
    );

    expect(dispatchResult).toBe(true);
    expect(handleFileUpload).not.toHaveBeenCalled();
    expect(focusSpy).not.toHaveBeenCalled();
  });
});

/**
 * Pasting a bare link attaches the page instead of inserting the URL. Once
 * the content is attached the raw URL is noise the user would have to delete,
 * so the paste is swallowed in both the focused and unfocused cases.
 */
describe('usePasteChatInput — pasted links', () => {
  let handleFileUpload: Mock;

  beforeEach(() => {
    handleFileUpload = vi.fn().mockResolvedValue(undefined);
    useChatInputStore.setState({
      textFieldValue: '',
      filePreviews: [],
      handleFileUpload,
    });
    useUIStore.setState({
      isSettingsOpen: false,
      isBotModalOpen: false,
      isTermsModalOpen: false,
    });
    mockAttachUrl.mockReset();
    mockAttachUrl.mockResolvedValue(undefined);
    useSettingsStore.setState({ autoFetchPastedLinks: true });
  });

  function setup(enabled = true) {
    const textarea = document.createElement('textarea');
    const textareaRef = { current: textarea };
    renderHook(() => usePasteChatInput({ textareaRef, enabled }));
    return { textarea };
  }

  const url = 'https://news.example.com/floods';
  const text = () => useChatInputStore.getState().textFieldValue;

  it('attaches the page and keeps the URL out of the composer (textarea focused)', () => {
    const { textarea } = setup();

    const dispatchResult = window.dispatchEvent(
      createPasteEvent({ text: url, target: textarea }),
    );

    // preventDefault stops the browser inserting the URL.
    expect(dispatchResult).toBe(false);
    expect(mockAttachUrl).toHaveBeenCalledWith(url);
    expect(text()).toBe('');
  });

  it('attaches the page without appending the URL (textarea not focused)', () => {
    setup();

    const dispatchResult = window.dispatchEvent(
      createPasteEvent({ text: url, target: document.body }),
    );

    expect(dispatchResult).toBe(false);
    expect(mockAttachUrl).toHaveBeenCalledWith(url);
    expect(text()).toBe('');
  });

  it('pastes the link normally when auto-fetch is switched off', () => {
    useSettingsStore.setState({ autoFetchPastedLinks: false });
    setup();

    window.dispatchEvent(
      createPasteEvent({ text: url, target: document.body }),
    );

    expect(mockAttachUrl).not.toHaveBeenCalled();
    expect(text()).toBe(url);
  });

  it('leaves prose containing a link completely alone', () => {
    setup();
    const prose = `see ${url} for details`;

    window.dispatchEvent(
      createPasteEvent({ text: prose, target: document.body }),
    );

    expect(mockAttachUrl).not.toHaveBeenCalled();
    expect(text()).toBe(prose);
  });

  it('does not hijack a link pasted into another input', () => {
    setup();
    const otherInput = document.createElement('input');
    document.body.appendChild(otherInput);

    const dispatchResult = window.dispatchEvent(
      createPasteEvent({ text: url, target: otherInput }),
    );

    expect(dispatchResult).toBe(true);
    expect(mockAttachUrl).not.toHaveBeenCalled();
    document.body.removeChild(otherInput);
  });
});
