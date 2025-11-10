import { act, renderHook, waitFor } from '@testing-library/react';

import { useInputState } from '@/client/hooks/chat/useInputState';

import { SearchMode } from '@/types/searchMode';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the useConversations hook
vi.mock('@/client/hooks/conversation/useConversations', () => ({
  useConversations: vi.fn(() => ({
    selectedConversation: null,
  })),
}));

describe('useInputState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('should initialize with empty text field', () => {
      const { result } = renderHook(() => useInputState());

      expect(result.current.textFieldValue).toBe('');
    });

    it('should initialize with default search mode OFF', () => {
      const { result } = renderHook(() => useInputState());

      expect(result.current.searchMode).toBe(SearchMode.OFF);
    });

    it('should initialize with no selected tone', () => {
      const { result } = renderHook(() => useInputState());

      expect(result.current.selectedToneId).toBeNull();
    });

    it('should initialize UI states to false', () => {
      const { result } = renderHook(() => useInputState());

      expect(result.current.isTyping).toBe(false);
      expect(result.current.isMultiline).toBe(false);
      expect(result.current.isFocused).toBe(false);
      expect(result.current.isTranscribing).toBe(false);
    });
  });

  describe('text field management', () => {
    it('should update text field value', () => {
      const { result } = renderHook(() => useInputState());

      act(() => {
        result.current.setTextFieldValue('Hello world');
      });

      expect(result.current.textFieldValue).toBe('Hello world');
    });

    it('should clear input when clearInput is called', () => {
      const { result } = renderHook(() => useInputState());

      act(() => {
        result.current.setTextFieldValue('Some text');
        result.current.setSelectedToneId('tone-123');
      });

      expect(result.current.textFieldValue).toBe('Some text');
      expect(result.current.selectedToneId).toBe('tone-123');

      act(() => {
        result.current.clearInput();
      });

      expect(result.current.textFieldValue).toBe('');
      expect(result.current.selectedToneId).toBeNull();
    });
  });

  describe('search mode management', () => {
    it('should update search mode', () => {
      const { result } = renderHook(() => useInputState());

      act(() => {
        result.current.setSearchMode(SearchMode.INTELLIGENT);
      });

      expect(result.current.searchMode).toBe(SearchMode.INTELLIGENT);
    });

    it('should toggle between search modes', () => {
      const { result } = renderHook(() => useInputState());

      act(() => {
        result.current.setSearchMode(SearchMode.INTELLIGENT);
      });
      expect(result.current.searchMode).toBe(SearchMode.INTELLIGENT);

      act(() => {
        result.current.setSearchMode(SearchMode.OFF);
      });
      expect(result.current.searchMode).toBe(SearchMode.OFF);
    });
  });

  describe('tone management', () => {
    it('should set selected tone', () => {
      const { result } = renderHook(() => useInputState());

      act(() => {
        result.current.setSelectedToneId('tone-friendly');
      });

      expect(result.current.selectedToneId).toBe('tone-friendly');
    });

    it('should clear selected tone', () => {
      const { result } = renderHook(() => useInputState());

      act(() => {
        result.current.setSelectedToneId('tone-professional');
      });
      expect(result.current.selectedToneId).toBe('tone-professional');

      act(() => {
        result.current.setSelectedToneId(null);
      });
      expect(result.current.selectedToneId).toBeNull();
    });
  });

  describe('UI state management', () => {
    it('should update typing state', () => {
      const { result } = renderHook(() => useInputState());

      act(() => {
        result.current.setIsTyping(true);
      });

      expect(result.current.isTyping).toBe(true);
    });

    it('should update multiline state', () => {
      const { result } = renderHook(() => useInputState());

      act(() => {
        result.current.setIsMultiline(true);
      });

      expect(result.current.isMultiline).toBe(true);
    });

    it('should update focused state', () => {
      const { result } = renderHook(() => useInputState());

      act(() => {
        result.current.setIsFocused(true);
      });

      expect(result.current.isFocused).toBe(true);
    });

    it('should update textarea scroll height', () => {
      const { result } = renderHook(() => useInputState());

      act(() => {
        result.current.setTextareaScrollHeight(150);
      });

      expect(result.current.textareaScrollHeight).toBe(150);
    });
  });

  describe('transcription state', () => {
    it('should set transcription status', () => {
      const { result } = renderHook(() => useInputState());

      act(() => {
        result.current.setTranscriptionStatus('Transcribing...');
      });

      expect(result.current.transcriptionStatus).toBe('Transcribing...');
    });

    it('should update transcription in-progress state', () => {
      const { result } = renderHook(() => useInputState());

      act(() => {
        result.current.setIsTranscribing(true);
      });

      expect(result.current.isTranscribing).toBe(true);
    });
  });

  describe('placeholder management', () => {
    it('should update placeholder text', () => {
      const { result } = renderHook(() => useInputState());

      act(() => {
        result.current.setPlaceholderText('Type your message...');
      });

      expect(result.current.placeholderText).toBe('Type your message...');
    });
  });
});
