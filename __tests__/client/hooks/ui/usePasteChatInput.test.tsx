/**
 * @vitest-environment jsdom
 */
import { renderHook } from '@testing-library/react';

import { usePasteChatInput } from '@/client/hooks/ui/usePasteChatInput';

import { SearchMode } from '@/types/searchMode';

import { useChatInputStore } from '@/client/stores/chatInputStore';
import { useUIStore } from '@/client/stores/uiStore';
import { Mock, beforeEach, describe, expect, it, vi } from 'vitest';

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
