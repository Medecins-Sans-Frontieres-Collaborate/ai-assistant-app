import { renderHook } from '@testing-library/react';

import { useConversationInitialization } from '@/client/hooks/chat/useConversationInitialization';

import { Conversation } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the conversation initialization utilities
const mockCanInitializeConversation = vi.fn();
const mockShouldCreateDefaultConversation = vi.fn();
const mockCreateDefaultConversation = vi.fn();

vi.mock('@/lib/utils/app/conversationInit', () => ({
  canInitializeConversation: (...args: any[]) =>
    mockCanInitializeConversation(...args),
  shouldCreateDefaultConversation: (...args: any[]) =>
    mockShouldCreateDefaultConversation(...args),
  createDefaultConversation: (...args: any[]) =>
    mockCreateDefaultConversation(...args),
}));

describe('useConversationInitialization', () => {
  const mockModels: OpenAIModel[] = [
    { id: 'gpt-4', name: 'GPT-4' } as any,
    { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo' } as any,
  ];

  const mockConversation: Conversation = {
    id: 'conv-1',
    name: 'Test Conversation',
    messages: [],
    model: mockModels[0],
    prompt: '',
    temperature: 0.7,
    folderId: null,
  };

  const mockAddConversation = vi.fn();
  const mockSelectConversation = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockCanInitializeConversation.mockReturnValue(true);
    mockShouldCreateDefaultConversation.mockReturnValue(false);
  });

  describe('initialization checks', () => {
    it('should not initialize if not loaded', () => {
      mockCanInitializeConversation.mockReturnValue(false);

      renderHook(() =>
        useConversationInitialization({
          isLoaded: false,
          models: mockModels,
          conversations: [],
          selectedConversation: null,
          addConversation: mockAddConversation,
          selectConversation: mockSelectConversation,
        }),
      );

      expect(mockAddConversation).not.toHaveBeenCalled();
      expect(mockSelectConversation).not.toHaveBeenCalled();
    });

    it('should not initialize if no models available', () => {
      mockCanInitializeConversation.mockReturnValue(false);

      renderHook(() =>
        useConversationInitialization({
          isLoaded: true,
          models: [],
          conversations: [],
          selectedConversation: null,
          addConversation: mockAddConversation,
          selectConversation: mockSelectConversation,
        }),
      );

      expect(mockAddConversation).not.toHaveBeenCalled();
      expect(mockSelectConversation).not.toHaveBeenCalled();
    });

    it('should not initialize twice', () => {
      mockShouldCreateDefaultConversation.mockReturnValue(true);
      mockCreateDefaultConversation.mockReturnValue(mockConversation);

      const { rerender } = renderHook(() =>
        useConversationInitialization({
          isLoaded: true,
          models: mockModels,
          conversations: [],
          selectedConversation: null,
          addConversation: mockAddConversation,
          selectConversation: mockSelectConversation,
        }),
      );

      expect(mockAddConversation).toHaveBeenCalledTimes(1);

      // Re-render should not trigger initialization again
      rerender();

      expect(mockAddConversation).toHaveBeenCalledTimes(1);
    });
  });

  describe('creating default conversation', () => {
    it('should create default conversation when none exist', () => {
      mockShouldCreateDefaultConversation.mockReturnValue(true);
      mockCreateDefaultConversation.mockReturnValue(mockConversation);

      renderHook(() =>
        useConversationInitialization({
          isLoaded: true,
          models: mockModels,
          conversations: [],
          selectedConversation: null,
          defaultModelId: 'gpt-4',
          systemPrompt: 'You are a helpful assistant',
          temperature: 0.8,
          addConversation: mockAddConversation,
          selectConversation: mockSelectConversation,
        }),
      );

      expect(mockCreateDefaultConversation).toHaveBeenCalledWith(
        mockModels,
        'gpt-4',
        'You are a helpful assistant',
        0.8,
        undefined,
      );
      expect(mockAddConversation).toHaveBeenCalledWith(mockConversation);
    });

    it('should use empty string for system prompt if not provided', () => {
      mockShouldCreateDefaultConversation.mockReturnValue(true);
      mockCreateDefaultConversation.mockReturnValue(mockConversation);

      renderHook(() =>
        useConversationInitialization({
          isLoaded: true,
          models: mockModels,
          conversations: [],
          selectedConversation: null,
          addConversation: mockAddConversation,
          selectConversation: mockSelectConversation,
        }),
      );

      expect(mockCreateDefaultConversation).toHaveBeenCalledWith(
        mockModels,
        undefined,
        '',
        0.5,
        undefined,
      );
    });

    it('should use default temperature if not provided', () => {
      mockShouldCreateDefaultConversation.mockReturnValue(true);
      mockCreateDefaultConversation.mockReturnValue(mockConversation);

      renderHook(() =>
        useConversationInitialization({
          isLoaded: true,
          models: mockModels,
          conversations: [],
          selectedConversation: null,
          addConversation: mockAddConversation,
          selectConversation: mockSelectConversation,
        }),
      );

      expect(mockCreateDefaultConversation).toHaveBeenCalledWith(
        mockModels,
        undefined,
        '',
        0.5,
        undefined,
      );
    });
  });

  describe('selecting existing conversation', () => {
    it('should select first conversation if none selected', () => {
      mockShouldCreateDefaultConversation.mockReturnValue(false);

      renderHook(() =>
        useConversationInitialization({
          isLoaded: true,
          models: mockModels,
          conversations: [mockConversation],
          selectedConversation: null,
          addConversation: mockAddConversation,
          selectConversation: mockSelectConversation,
        }),
      );

      expect(mockSelectConversation).toHaveBeenCalledWith('conv-1');
      expect(mockAddConversation).not.toHaveBeenCalled();
    });

    it('should not select conversation if already selected', () => {
      mockShouldCreateDefaultConversation.mockReturnValue(false);

      renderHook(() =>
        useConversationInitialization({
          isLoaded: true,
          models: mockModels,
          conversations: [mockConversation],
          selectedConversation: mockConversation,
          addConversation: mockAddConversation,
          selectConversation: mockSelectConversation,
        }),
      );

      expect(mockSelectConversation).not.toHaveBeenCalled();
    });
  });
});
