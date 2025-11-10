import { act, renderHook } from '@testing-library/react';

import { usePromptSaving } from '@/client/hooks/chat/usePromptSaving';

import { OpenAIModel } from '@/types/openai';

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('usePromptSaving', () => {
  const mockModels: OpenAIModel[] = [
    { id: 'gpt-4', name: 'GPT-4' } as any,
    { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo' } as any,
  ];

  const mockAddPrompt = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('should initialize with modal closed', () => {
      const { result } = renderHook(() =>
        usePromptSaving({
          models: mockModels,
          defaultModelId: 'gpt-4',
          addPrompt: mockAddPrompt,
        }),
      );

      expect(result.current.isSavePromptModalOpen).toBe(false);
    });

    it('should initialize with empty prompt fields', () => {
      const { result } = renderHook(() =>
        usePromptSaving({
          models: mockModels,
          defaultModelId: 'gpt-4',
          addPrompt: mockAddPrompt,
        }),
      );

      expect(result.current.savePromptContent).toBe('');
      expect(result.current.savePromptName).toBe('');
      expect(result.current.savePromptDescription).toBe('');
    });
  });

  describe('handleOpenSavePromptModal', () => {
    it('should open modal with provided content', () => {
      const { result } = renderHook(() =>
        usePromptSaving({
          models: mockModels,
          defaultModelId: 'gpt-4',
          addPrompt: mockAddPrompt,
        }),
      );

      act(() => {
        result.current.handleOpenSavePromptModal('Test prompt content');
      });

      expect(result.current.isSavePromptModalOpen).toBe(true);
      expect(result.current.savePromptContent).toBe('Test prompt content');
    });

    it('should set default name with timestamp', () => {
      const { result } = renderHook(() =>
        usePromptSaving({
          models: mockModels,
          defaultModelId: 'gpt-4',
          addPrompt: mockAddPrompt,
        }),
      );

      act(() => {
        result.current.handleOpenSavePromptModal('Content');
      });

      expect(result.current.savePromptName).toMatch(/^Saved prompt - /);
    });

    it('should set default description', () => {
      const { result } = renderHook(() =>
        usePromptSaving({
          models: mockModels,
          defaultModelId: 'gpt-4',
          addPrompt: mockAddPrompt,
        }),
      );

      act(() => {
        result.current.handleOpenSavePromptModal('Content');
      });

      expect(result.current.savePromptDescription).toBe('Saved from message');
    });
  });

  describe('handleSavePrompt', () => {
    it('should create and add a new prompt', () => {
      const { result } = renderHook(() =>
        usePromptSaving({
          models: mockModels,
          defaultModelId: 'gpt-4',
          addPrompt: mockAddPrompt,
        }),
      );

      act(() => {
        result.current.handleOpenSavePromptModal('Test content');
      });

      act(() => {
        result.current.handleSavePrompt(
          'My Prompt',
          'My Description',
          'Test content',
        );
      });

      expect(mockAddPrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'My Prompt',
          description: 'My Description',
          content: 'Test content',
          model: mockModels[0],
          folderId: null,
        }),
      );
    });

    it('should use default model if specified', () => {
      const { result } = renderHook(() =>
        usePromptSaving({
          models: mockModels,
          defaultModelId: 'gpt-3.5-turbo',
          addPrompt: mockAddPrompt,
        }),
      );

      act(() => {
        result.current.handleSavePrompt('Name', 'Description', 'Content');
      });

      expect(mockAddPrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          model: mockModels[1],
        }),
      );
    });

    it('should use first model if no default specified', () => {
      const { result } = renderHook(() =>
        usePromptSaving({
          models: mockModels,
          addPrompt: mockAddPrompt,
        }),
      );

      act(() => {
        result.current.handleSavePrompt('Name', 'Description', 'Content');
      });

      expect(mockAddPrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          model: mockModels[0],
        }),
      );
    });

    it('should use "Untitled prompt" if no name provided', () => {
      const { result } = renderHook(() =>
        usePromptSaving({
          models: mockModels,
          defaultModelId: 'gpt-4',
          addPrompt: mockAddPrompt,
        }),
      );

      act(() => {
        result.current.handleSavePrompt('', 'Description', 'Content');
      });

      expect(mockAddPrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Untitled prompt',
        }),
      );
    });

    it('should close modal after saving', () => {
      const { result } = renderHook(() =>
        usePromptSaving({
          models: mockModels,
          defaultModelId: 'gpt-4',
          addPrompt: mockAddPrompt,
        }),
      );

      act(() => {
        result.current.handleOpenSavePromptModal('Content');
      });

      expect(result.current.isSavePromptModalOpen).toBe(true);

      act(() => {
        result.current.handleSavePrompt('Name', 'Description', 'Content');
      });

      expect(result.current.isSavePromptModalOpen).toBe(false);
    });

    it('should reset fields after saving', () => {
      const { result } = renderHook(() =>
        usePromptSaving({
          models: mockModels,
          defaultModelId: 'gpt-4',
          addPrompt: mockAddPrompt,
        }),
      );

      act(() => {
        result.current.handleOpenSavePromptModal('Content');
      });

      act(() => {
        result.current.handleSavePrompt('Name', 'Description', 'Content');
      });

      expect(result.current.savePromptName).toBe('');
      expect(result.current.savePromptDescription).toBe('');
      expect(result.current.savePromptContent).toBe('');
    });

    it('should generate unique prompt IDs', () => {
      const { result } = renderHook(() =>
        usePromptSaving({
          models: mockModels,
          defaultModelId: 'gpt-4',
          addPrompt: mockAddPrompt,
        }),
      );

      act(() => {
        result.current.handleSavePrompt('Name 1', 'Desc 1', 'Content 1');
      });

      const firstCallId = mockAddPrompt.mock.calls[0][0].id;

      act(() => {
        result.current.handleSavePrompt('Name 2', 'Desc 2', 'Content 2');
      });

      const secondCallId = mockAddPrompt.mock.calls[1][0].id;

      expect(firstCallId).not.toBe(secondCallId);
    });
  });

  describe('handleCloseSavePromptModal', () => {
    it('should close the modal', () => {
      const { result } = renderHook(() =>
        usePromptSaving({
          models: mockModels,
          defaultModelId: 'gpt-4',
          addPrompt: mockAddPrompt,
        }),
      );

      act(() => {
        result.current.handleOpenSavePromptModal('Content');
      });

      expect(result.current.isSavePromptModalOpen).toBe(true);

      act(() => {
        result.current.handleCloseSavePromptModal();
      });

      expect(result.current.isSavePromptModalOpen).toBe(false);
    });
  });
});
