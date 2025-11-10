import { act, renderHook } from '@testing-library/react';

import { useConversations } from '@/client/hooks/conversation/useConversations';
import { useModelSelection } from '@/client/hooks/settings/useModelSelection';

import { Conversation } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';
import { SearchMode } from '@/types/searchMode';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the useConversations hook
const mockUpdateConversation = vi.fn();
const mockSelectedConversation: Conversation = {
  id: 'conv-1',
  name: 'Test Conversation',
  messages: [],
  model: { id: 'gpt-4', name: 'GPT-4' } as any,
  prompt: '',
  temperature: 0.7,
  folderId: null,
  defaultSearchMode: SearchMode.OFF,
};

vi.mock('@/client/hooks/conversation/useConversations');

const mockUseConversations = useConversations as ReturnType<typeof vi.fn>;

describe('useModelSelection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseConversations.mockReturnValue({
      selectedConversation: mockSelectedConversation,
      updateConversation: mockUpdateConversation,
    } as any);
  });

  describe('handleModelSelect', () => {
    it('should update conversation with selected model', () => {
      const { result } = renderHook(() => useModelSelection());

      const newModel: OpenAIModel = {
        id: 'gpt-3.5-turbo',
        name: 'GPT-3.5 Turbo',
      } as any;

      act(() => {
        result.current.handleModelSelect(newModel);
      });

      expect(mockUpdateConversation).toHaveBeenCalledWith('conv-1', {
        model: newModel,
      });
    });

    it('should set default search mode to INTELLIGENT if not set', () => {
      const conversationWithoutSearchMode = {
        ...mockSelectedConversation,
        defaultSearchMode: undefined,
      };
      mockUseConversations.mockReturnValue({
        selectedConversation: conversationWithoutSearchMode,
        updateConversation: mockUpdateConversation,
      } as any);

      const { result } = renderHook(() => useModelSelection());

      const newModel: OpenAIModel = {
        id: 'gpt-3.5-turbo',
        name: 'GPT-3.5 Turbo',
      } as any;

      act(() => {
        result.current.handleModelSelect(newModel);
      });

      expect(mockUpdateConversation).toHaveBeenCalledWith('conv-1', {
        model: newModel,
        defaultSearchMode: SearchMode.INTELLIGENT,
      });
    });

    it('should not change search mode if already set', () => {
      const { result } = renderHook(() => useModelSelection());

      const newModel: OpenAIModel = {
        id: 'gpt-3.5-turbo',
        name: 'GPT-3.5 Turbo',
      } as any;

      act(() => {
        result.current.handleModelSelect(newModel);
      });

      expect(mockUpdateConversation).toHaveBeenCalledWith('conv-1', {
        model: newModel,
      });
      expect(mockUpdateConversation).not.toHaveBeenCalledWith(
        'conv-1',
        expect.objectContaining({ defaultSearchMode: expect.anything() }),
      );
    });

    it('should not update if no conversation selected', () => {
      mockUseConversations.mockReturnValue({
        selectedConversation: null,
        updateConversation: mockUpdateConversation,
      } as any);

      const { result } = renderHook(() => useModelSelection());

      const newModel: OpenAIModel = {
        id: 'gpt-3.5-turbo',
        name: 'GPT-3.5 Turbo',
      } as any;

      act(() => {
        result.current.handleModelSelect(newModel);
      });

      expect(mockUpdateConversation).not.toHaveBeenCalled();
    });
  });

  describe('handleToggleSearchMode', () => {
    it('should toggle search mode from OFF to INTELLIGENT', () => {
      mockUseConversations.mockReturnValue({
        selectedConversation: {
          ...mockSelectedConversation,
          defaultSearchMode: SearchMode.OFF,
        },
        updateConversation: mockUpdateConversation,
      } as any);

      const { result } = renderHook(() => useModelSelection());

      act(() => {
        result.current.handleToggleSearchMode();
      });

      expect(mockUpdateConversation).toHaveBeenCalledWith('conv-1', {
        defaultSearchMode: SearchMode.INTELLIGENT,
      });
    });

    it('should toggle search mode from INTELLIGENT to OFF', () => {
      mockUseConversations.mockReturnValue({
        selectedConversation: {
          ...mockSelectedConversation,
          defaultSearchMode: SearchMode.INTELLIGENT,
        },
        updateConversation: mockUpdateConversation,
      } as any);

      const { result } = renderHook(() => useModelSelection());

      act(() => {
        result.current.handleToggleSearchMode();
      });

      expect(mockUpdateConversation).toHaveBeenCalledWith('conv-1', {
        defaultSearchMode: SearchMode.OFF,
      });
    });

    it('should treat undefined search mode as OFF when toggling', () => {
      mockUseConversations.mockReturnValue({
        selectedConversation: {
          ...mockSelectedConversation,
          defaultSearchMode: undefined,
        },
        updateConversation: mockUpdateConversation,
      } as any);

      const { result } = renderHook(() => useModelSelection());

      act(() => {
        result.current.handleToggleSearchMode();
      });

      expect(mockUpdateConversation).toHaveBeenCalledWith('conv-1', {
        defaultSearchMode: SearchMode.INTELLIGENT,
      });
    });

    it('should not update if no conversation selected', () => {
      mockUseConversations.mockReturnValue({
        selectedConversation: null,
        updateConversation: mockUpdateConversation,
      } as any);

      const { result } = renderHook(() => useModelSelection());

      act(() => {
        result.current.handleToggleSearchMode();
      });

      expect(mockUpdateConversation).not.toHaveBeenCalled();
    });
  });

  describe('handleSetSearchMode', () => {
    it('should set search mode to specified value', () => {
      const { result } = renderHook(() => useModelSelection());

      act(() => {
        result.current.handleSetSearchMode(SearchMode.INTELLIGENT);
      });

      expect(mockUpdateConversation).toHaveBeenCalledWith('conv-1', {
        defaultSearchMode: SearchMode.INTELLIGENT,
      });
    });

    it('should set search mode to OFF', () => {
      const { result } = renderHook(() => useModelSelection());

      act(() => {
        result.current.handleSetSearchMode(SearchMode.OFF);
      });

      expect(mockUpdateConversation).toHaveBeenCalledWith('conv-1', {
        defaultSearchMode: SearchMode.OFF,
      });
    });

    it('should not update if no conversation selected', () => {
      mockUseConversations.mockReturnValue({
        selectedConversation: null,
        updateConversation: mockUpdateConversation,
      } as any);

      const { result } = renderHook(() => useModelSelection());

      act(() => {
        result.current.handleSetSearchMode(SearchMode.INTELLIGENT);
      });

      expect(mockUpdateConversation).not.toHaveBeenCalled();
    });
  });
});
