import { useCallback, useEffect, useRef, useState } from 'react';

import { useConversations } from '@/client/hooks/conversation/useConversations';

import { SearchMode } from '@/types/searchMode';

/**
 * Custom hook to manage all input-related state for ChatInput
 * Centralizes state management to reduce complexity in main component
 */
export function useInputState() {
  const { selectedConversation } = useConversations();

  const [textFieldValue, setTextFieldValue] = useState<string>('');
  const [isTyping, setIsTyping] = useState<boolean>(false);
  const [isMultiline, setIsMultiline] = useState<boolean>(false);
  const [isFocused, setIsFocused] = useState<boolean>(false);
  const [placeholderText, setPlaceholderText] = useState('');
  const [transcriptionStatus, setTranscriptionStatus] = useState<string | null>(
    null,
  );
  const [isTranscribing, setIsTranscribing] = useState<boolean>(false);
  const [textareaScrollHeight, setTextareaScrollHeight] = useState(0);

  // Use conversation's defaultSearchMode if set, otherwise OFF
  const [searchMode, setSearchMode] = useState<SearchMode>(
    selectedConversation?.defaultSearchMode ?? SearchMode.OFF,
  );

  // Sync searchMode with conversation's defaultSearchMode when conversation changes
  const prevConversationId = useRef<string | undefined>(undefined);
  const prevDefaultSearchMode = useRef<SearchMode | undefined>(undefined);
  useEffect(() => {
    const conversationIdChanged =
      prevConversationId.current !== selectedConversation?.id;
    const searchModeChanged =
      prevDefaultSearchMode.current !== selectedConversation?.defaultSearchMode;

    // Update if conversation ID or defaultSearchMode changed
    if (conversationIdChanged || searchModeChanged) {
      prevConversationId.current = selectedConversation?.id;
      prevDefaultSearchMode.current = selectedConversation?.defaultSearchMode;

      // Schedule state update to avoid synchronous setState in effect
      setTimeout(() => {
        setSearchMode(
          selectedConversation?.defaultSearchMode ?? SearchMode.OFF,
        );
      }, 0);
    }
  }, [selectedConversation?.id, selectedConversation?.defaultSearchMode]);

  const [selectedToneId, setSelectedToneId] = useState<string | null>(null);

  // Clear text when switching conversations
  useEffect(() => {
    setTimeout(() => {
      setTextFieldValue('');
    }, 0);
  }, [selectedConversation?.id]);

  const clearInput = useCallback(() => {
    setTextFieldValue('');
    setSelectedToneId(null);
  }, []);

  return {
    // Text state
    textFieldValue,
    setTextFieldValue,
    placeholderText,
    setPlaceholderText,

    // Input UI state
    isTyping,
    setIsTyping,
    isMultiline,
    setIsMultiline,
    isFocused,
    setIsFocused,
    textareaScrollHeight,
    setTextareaScrollHeight,

    // Transcription state
    transcriptionStatus,
    setTranscriptionStatus,
    isTranscribing,
    setIsTranscribing,

    // Search mode state
    searchMode,
    setSearchMode,

    // Tone state
    selectedToneId,
    setSelectedToneId,

    // Actions
    clearInput,
  };
}
