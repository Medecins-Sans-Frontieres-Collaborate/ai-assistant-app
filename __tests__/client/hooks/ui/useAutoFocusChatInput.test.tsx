/**
 * @vitest-environment jsdom
 */
import { renderHook } from '@testing-library/react';

import { useAutoFocusChatInput } from '@/client/hooks/ui/useAutoFocusChatInput';

import { SearchMode } from '@/types/searchMode';

import { useChatInputStore } from '@/client/stores/chatInputStore';
import { useUIStore } from '@/client/stores/uiStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('useAutoFocusChatInput', () => {
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

    useUIStore.setState({
      isSettingsOpen: false,
      isBotModalOpen: false,
      isTermsModalOpen: false,
      loading: false,
    });
  });

  it('appends a slash and focuses the textarea when typing unfocused', () => {
    const textarea = document.createElement('textarea');
    const focusSpy = vi.spyOn(textarea, 'focus');
    const textareaRef = { current: textarea };

    renderHook(() =>
      useAutoFocusChatInput({
        textareaRef,
        enabled: true,
      }),
    );

    const event = new KeyboardEvent('keydown', {
      key: '/',
      bubbles: true,
      cancelable: true,
    });

    const dispatchResult = window.dispatchEvent(event);

    expect(dispatchResult).toBe(false);
    expect(useChatInputStore.getState().textFieldValue).toBe('/');
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it('ignores typing when the event starts in an input', () => {
    const textarea = document.createElement('textarea');
    const focusSpy = vi.spyOn(textarea, 'focus');
    const textareaRef = { current: textarea };
    const input = document.createElement('input');

    renderHook(() =>
      useAutoFocusChatInput({
        textareaRef,
        enabled: true,
      }),
    );

    const event = new KeyboardEvent('keydown', {
      key: '/',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, 'target', {
      configurable: true,
      value: input,
    });

    window.dispatchEvent(event);

    expect(useChatInputStore.getState().textFieldValue).toBe('');
    expect(focusSpy).not.toHaveBeenCalled();
  });
});
