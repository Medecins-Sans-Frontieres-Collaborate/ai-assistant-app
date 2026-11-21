import { act, renderHook } from '@testing-library/react';

import { usePromptSelection } from '@/client/hooks/ui/usePromptSelection';

import * as promptMatching from '@/lib/utils/shared/chat/promptMatching';
import * as variables from '@/lib/utils/shared/chat/variables';

import type { Prompt } from '@/types/prompt';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the trigger parsing the tests drive; the list's order and matching
// (groupPromptsForList, promptMatchesQuery) stay real, as the hook relies on
// them for which prompt a position means.
vi.mock('@/lib/utils/shared/chat/promptMatching', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/lib/utils/shared/chat/promptMatching')
  >()),
  findPromptMatch: vi.fn(),
  updatePromptListVisibility: vi.fn(),
}));
vi.mock('@/lib/utils/shared/chat/variables');

describe('usePromptSelection', () => {
  const mockModel = {
    id: 'gpt-4.1',
    name: 'GPT-4.1',
    maxLength: 128000,
    tokenLimit: 16384,
  };

  const mockPrompts: Prompt[] = [
    {
      id: 'prompt-1',
      name: 'Email Template',
      description: 'Professional email',
      content: 'Dear {{recipient}}, this is about {{topic}}.',
      model: mockModel,
      folderId: null,
    },
    {
      id: 'prompt-2',
      name: 'Code Review',
      description: 'Code review template',
      content: 'Review the following code: {{code}}',
      model: mockModel,
      folderId: null,
    },
    {
      id: 'prompt-3',
      name: 'Meeting Notes',
      description: 'Meeting notes template',
      content: 'Meeting on {{date}} about {{subject}}',
      model: mockModel,
      folderId: null,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup default mock implementations
    vi.mocked(promptMatching.findPromptMatch).mockReturnValue({
      matched: false,
      searchTerm: '',
    });
    vi.mocked(promptMatching.updatePromptListVisibility).mockReturnValue({
      showList: false,
      inputValue: '',
    });
    vi.mocked(variables.parseVariables).mockReturnValue([]);
  });

  describe('Initial State', () => {
    it('initializes with showPromptList false', () => {
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: mockPrompts }),
      );

      expect(result.current.showPromptList).toBe(false);
    });

    it('initializes with activePromptIndex 0', () => {
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: mockPrompts }),
      );

      expect(result.current.activePromptIndex).toBe(0);
    });

    it('initializes with empty promptInputValue', () => {
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: mockPrompts }),
      );

      expect(result.current.promptInputValue).toBe('');
    });

    it('provides promptListRef', () => {
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: mockPrompts }),
      );

      expect(result.current.promptListRef).toHaveProperty('current');
    });

    it('returns all prompts as filteredPrompts when input is empty', () => {
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: mockPrompts }),
      );

      expect(result.current.filteredPrompts).toHaveLength(3);
      expect(result.current.filteredPrompts).toEqual(mockPrompts);
    });
  });

  describe('Prompt Filtering', () => {
    it('filters prompts by name (case-insensitive)', () => {
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: mockPrompts }),
      );

      act(() => {
        result.current.setPromptInputValue('email');
      });

      expect(result.current.filteredPrompts).toHaveLength(1);
      expect(result.current.filteredPrompts[0].name).toBe('Email Template');
    });

    it('handles uppercase input', () => {
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: mockPrompts }),
      );

      act(() => {
        result.current.setPromptInputValue('EMAIL');
      });

      expect(result.current.filteredPrompts).toHaveLength(1);
      expect(result.current.filteredPrompts[0].name).toBe('Email Template');
    });

    it('returns multiple matches', () => {
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: mockPrompts }),
      );

      act(() => {
        result.current.setPromptInputValue('e'); // 'Email' and 'Code Review' and 'Meeting Notes'
      });

      // 'e' appears in 'Email', 'Code Review', and 'Meeting'
      expect(result.current.filteredPrompts.length).toBeGreaterThan(0);
    });

    it('returns empty array when no matches', () => {
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: mockPrompts }),
      );

      act(() => {
        result.current.setPromptInputValue('nonexistent');
      });

      expect(result.current.filteredPrompts).toHaveLength(0);
    });

    it('filters based on partial match', () => {
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: mockPrompts }),
      );

      act(() => {
        result.current.setPromptInputValue('code');
      });

      expect(result.current.filteredPrompts).toHaveLength(1);
      expect(result.current.filteredPrompts[0].name).toBe('Code Review');
    });
  });

  describe('Keyboard Navigation', () => {
    it('moves down with ArrowDown', () => {
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: mockPrompts }),
      );

      const event = {
        key: 'ArrowDown',
        preventDefault: vi.fn(),
      } as any;

      act(() => {
        result.current.handleKeyDownPromptList(event);
      });

      expect(event.preventDefault).toHaveBeenCalled();
      expect(result.current.activePromptIndex).toBe(1);
    });

    it('does not move down past last prompt', () => {
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: mockPrompts }),
      );

      const event = {
        key: 'ArrowDown',
        preventDefault: vi.fn(),
      } as any;

      // Move to last prompt (index 2)
      act(() => {
        result.current.setActivePromptIndex(2);
      });

      act(() => {
        result.current.handleKeyDownPromptList(event);
      });

      expect(result.current.activePromptIndex).toBe(2);
    });

    it('moves up with ArrowUp', () => {
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: mockPrompts }),
      );

      const event = {
        key: 'ArrowUp',
        preventDefault: vi.fn(),
      } as any;

      // Start at index 1
      act(() => {
        result.current.setActivePromptIndex(1);
      });

      act(() => {
        result.current.handleKeyDownPromptList(event);
      });

      expect(event.preventDefault).toHaveBeenCalled();
      expect(result.current.activePromptIndex).toBe(0);
    });

    it('does not move up past first prompt', () => {
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: mockPrompts }),
      );

      const event = {
        key: 'ArrowUp',
        preventDefault: vi.fn(),
      } as any;

      act(() => {
        result.current.handleKeyDownPromptList(event);
      });

      expect(result.current.activePromptIndex).toBe(0);
    });

    it('cycles through prompts with Tab', () => {
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: mockPrompts }),
      );

      const event = {
        key: 'Tab',
        preventDefault: vi.fn(),
      } as any;

      act(() => {
        result.current.handleKeyDownPromptList(event);
      });

      expect(event.preventDefault).toHaveBeenCalled();
      expect(result.current.activePromptIndex).toBe(1);

      act(() => {
        result.current.handleKeyDownPromptList(event);
      });

      expect(result.current.activePromptIndex).toBe(2);
    });

    it('wraps to first prompt with Tab at end', () => {
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: mockPrompts }),
      );

      const event = {
        key: 'Tab',
        preventDefault: vi.fn(),
      } as any;

      // Move to last prompt
      act(() => {
        result.current.setActivePromptIndex(2);
      });

      act(() => {
        result.current.handleKeyDownPromptList(event);
      });

      expect(result.current.activePromptIndex).toBe(0);
    });

    it('selects active prompt with Enter', () => {
      const onPromptSelect = vi.fn();
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: mockPrompts, onPromptSelect }),
      );

      vi.mocked(variables.parseVariables).mockReturnValue([
        'recipient',
        'topic',
      ]);

      const event = {
        key: 'Enter',
        preventDefault: vi.fn(),
      } as any;

      act(() => {
        result.current.handleKeyDownPromptList(event);
      });

      expect(event.preventDefault).toHaveBeenCalled();
      expect(onPromptSelect).toHaveBeenCalledWith(
        mockPrompts[0],
        ['recipient', 'topic'],
        true,
      );
      expect(result.current.showPromptList).toBe(false);
    });

    it('calls onResetInputState when Enter is pressed', () => {
      const onResetInputState = vi.fn();
      const { result } = renderHook(() =>
        usePromptSelection({
          prompts: mockPrompts,
          onResetInputState,
        }),
      );

      const event = {
        key: 'Enter',
        preventDefault: vi.fn(),
      } as any;

      act(() => {
        result.current.handleKeyDownPromptList(event);
      });

      expect(onResetInputState).toHaveBeenCalled();
    });

    it('hides prompt list with Escape', () => {
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: mockPrompts }),
      );

      // Show the list first
      act(() => {
        result.current.setShowPromptList(true);
      });

      const event = {
        key: 'Escape',
        preventDefault: vi.fn(),
      } as any;

      act(() => {
        result.current.handleKeyDownPromptList(event);
      });

      expect(event.preventDefault).toHaveBeenCalled();
      expect(result.current.showPromptList).toBe(false);
    });

    it('resets activePromptIndex to 0 for other keys', () => {
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: mockPrompts }),
      );

      // Move to index 2
      act(() => {
        result.current.setActivePromptIndex(2);
      });

      const event = {
        key: 'a',
        preventDefault: vi.fn(),
      } as any;

      act(() => {
        result.current.handleKeyDownPromptList(event);
      });

      expect(result.current.activePromptIndex).toBe(0);
    });
  });

  describe('Prompt Selection', () => {
    it('calls onPromptSelect with parsed variables', () => {
      const onPromptSelect = vi.fn();
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: mockPrompts, onPromptSelect }),
      );

      vi.mocked(variables.parseVariables).mockReturnValue(['code']);

      act(() => {
        result.current.handlePromptSelect(mockPrompts[1]);
      });

      expect(variables.parseVariables).toHaveBeenCalledWith(
        mockPrompts[1].content,
      );
      expect(onPromptSelect).toHaveBeenCalledWith(
        mockPrompts[1],
        ['code'],
        true,
      );
    });

    it('calls onPromptSelect with no variables', () => {
      const onPromptSelect = vi.fn();
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: mockPrompts, onPromptSelect }),
      );

      const promptWithoutVars: Prompt = {
        id: 'prompt-4',
        name: 'Simple',
        description: 'Simple prompt',
        content: 'No variables here',
        model: mockModel,
        folderId: null,
      };

      vi.mocked(variables.parseVariables).mockReturnValue([]);

      act(() => {
        result.current.handlePromptSelect(promptWithoutVars);
      });

      expect(onPromptSelect).toHaveBeenCalledWith(promptWithoutVars, [], false);
    });

    it('does not crash when onPromptSelect is not provided', () => {
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: mockPrompts }),
      );

      expect(() => {
        act(() => {
          result.current.handlePromptSelect(mockPrompts[0]);
        });
      }).not.toThrow();
    });
  });

  describe('handleInitModal', () => {
    it('selects active prompt and hides list', () => {
      const onPromptSelect = vi.fn();
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: mockPrompts, onPromptSelect }),
      );

      vi.mocked(variables.parseVariables).mockReturnValue([]);

      // Set active index to 1
      act(() => {
        result.current.setActivePromptIndex(1);
        result.current.setShowPromptList(true);
      });

      act(() => {
        result.current.handleInitModal();
      });

      expect(onPromptSelect).toHaveBeenCalledWith(mockPrompts[1], [], false);
      expect(result.current.showPromptList).toBe(false);
    });

    it('handles empty filtered prompts', () => {
      const onPromptSelect = vi.fn();
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: mockPrompts, onPromptSelect }),
      );

      // Filter to empty
      act(() => {
        result.current.setPromptInputValue('nonexistent');
      });

      act(() => {
        result.current.handleInitModal();
      });

      expect(onPromptSelect).not.toHaveBeenCalled();
      expect(result.current.showPromptList).toBe(false);
    });
  });

  describe('updatePromptListVisibilityCallback', () => {
    it('updates visibility and input value based on text', () => {
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: mockPrompts }),
      );

      vi.mocked(promptMatching.updatePromptListVisibility).mockReturnValue({
        showList: true,
        inputValue: 'email',
      });

      act(() => {
        result.current.updatePromptListVisibilityCallback('/email');
      });

      expect(promptMatching.updatePromptListVisibility).toHaveBeenCalledWith(
        '/email',
      );
      expect(result.current.showPromptList).toBe(true);
      expect(result.current.promptInputValue).toBe('email');
    });

    it('hides list when no match', () => {
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: mockPrompts }),
      );

      vi.mocked(promptMatching.updatePromptListVisibility).mockReturnValue({
        showList: false,
        inputValue: '',
      });

      act(() => {
        result.current.updatePromptListVisibilityCallback('hello');
      });

      expect(result.current.showPromptList).toBe(false);
      expect(result.current.promptInputValue).toBe('');
    });
  });

  describe('findAndSelectMatchingPrompt', () => {
    it('selects matching prompt when found', () => {
      const onPromptSelect = vi.fn();
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: mockPrompts, onPromptSelect }),
      );

      vi.mocked(promptMatching.findPromptMatch).mockReturnValue({
        matched: true,
        searchTerm: 'Email Template',
      });
      vi.mocked(variables.parseVariables).mockReturnValue([
        'recipient',
        'topic',
      ]);

      act(() => {
        result.current.findAndSelectMatchingPrompt(
          '/Email Template',
          mockPrompts,
        );
      });

      expect(promptMatching.findPromptMatch).toHaveBeenCalledWith(
        '/Email Template',
      );
      expect(onPromptSelect).toHaveBeenCalledWith(
        mockPrompts[0],
        ['recipient', 'topic'],
        true,
      );
    });

    it('handles case-insensitive matching', () => {
      const onPromptSelect = vi.fn();
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: mockPrompts, onPromptSelect }),
      );

      vi.mocked(promptMatching.findPromptMatch).mockReturnValue({
        matched: true,
        searchTerm: 'email template',
      });
      vi.mocked(variables.parseVariables).mockReturnValue([]);

      act(() => {
        result.current.findAndSelectMatchingPrompt(
          '/email template',
          mockPrompts,
        );
      });

      expect(onPromptSelect).toHaveBeenCalledWith(mockPrompts[0], [], false);
    });

    it('does nothing when no match found', () => {
      const onPromptSelect = vi.fn();
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: mockPrompts, onPromptSelect }),
      );

      vi.mocked(promptMatching.findPromptMatch).mockReturnValue({
        matched: false,
        searchTerm: '',
      });

      act(() => {
        result.current.findAndSelectMatchingPrompt('hello', mockPrompts);
      });

      expect(onPromptSelect).not.toHaveBeenCalled();
    });

    it('does nothing when prompt name not in list', () => {
      const onPromptSelect = vi.fn();
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: mockPrompts, onPromptSelect }),
      );

      vi.mocked(promptMatching.findPromptMatch).mockReturnValue({
        matched: true,
        searchTerm: 'Nonexistent',
      });

      act(() => {
        result.current.findAndSelectMatchingPrompt('/Nonexistent', mockPrompts);
      });

      expect(onPromptSelect).not.toHaveBeenCalled();
    });
  });

  describe('List order and visibility', () => {
    const folders = [
      { id: 'folder-b', name: 'B', type: 'prompt' as const },
      { id: 'folder-a', name: 'A', type: 'prompt' as const },
    ];
    // Stored order differs from the order the list shows.
    const filed: Prompt[] = [
      { ...mockPrompts[0], folderId: null },
      { ...mockPrompts[1], folderId: 'folder-a' },
      { ...mockPrompts[2], folderId: 'folder-b' },
      { ...mockPrompts[0], id: 'orphan', name: 'Orphan', folderId: 'gone' },
    ];

    it('lists prompts in the order shown: folders in order, then the rest', () => {
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: filed, folders }),
      );
      expect(result.current.filteredPrompts.map((p) => p.name)).toEqual([
        'Meeting Notes', // folder B
        'Code Review', // folder A
        'Email Template', // no folder
        'Orphan', // folder no longer exists: listed, not lost
      ]);
    });

    it('uses the prompt shown at the highlighted position', () => {
      const onPromptSelect = vi.fn();
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: filed, folders, onPromptSelect }),
      );
      // Position 0 is "Meeting Notes" on screen but "Email Template" in
      // storage order, which is what the old lookup used.
      act(() => result.current.setActivePromptIndex(0));
      act(() => result.current.handleInitModal());
      expect(onPromptSelect.mock.calls[0][0].name).toBe('Meeting Notes');
    });

    it('uses the prompt clicked, whatever is highlighted', () => {
      const onPromptSelect = vi.fn();
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: filed, folders, onPromptSelect }),
      );
      act(() => result.current.setShowPromptList(true));
      act(() => result.current.selectPromptAt(2));
      expect(onPromptSelect.mock.calls[0][0].name).toBe('Email Template');
      expect(result.current.showPromptList).toBe(false);
    });

    it('is visible only while open and something matches', () => {
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: mockPrompts }),
      );
      expect(result.current.isPromptListVisible).toBe(false);
      act(() => result.current.setShowPromptList(true));
      expect(result.current.isPromptListVisible).toBe(true);
      act(() => result.current.setPromptInputValue('no such prompt'));
      expect(result.current.isPromptListVisible).toBe(false);
    });

    it('matches names regardless of accents and case', () => {
      const { result } = renderHook(() =>
        usePromptSelection({
          prompts: [{ ...mockPrompts[0], name: 'Résumé review' }],
        }),
      );
      act(() => result.current.setPromptInputValue('RESUME'));
      expect(result.current.filteredPrompts).toHaveLength(1);
    });
  });

  describe('Setters', () => {
    it('setShowPromptList updates state', () => {
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: mockPrompts }),
      );

      act(() => {
        result.current.setShowPromptList(true);
      });

      expect(result.current.showPromptList).toBe(true);
    });

    it('setActivePromptIndex updates state', () => {
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: mockPrompts }),
      );

      act(() => {
        result.current.setActivePromptIndex(2);
      });

      expect(result.current.activePromptIndex).toBe(2);
    });

    it('setActivePromptIndex accepts function', () => {
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: mockPrompts }),
      );

      act(() => {
        result.current.setActivePromptIndex(1);
      });

      act(() => {
        result.current.setActivePromptIndex((prev) => prev + 1);
      });

      expect(result.current.activePromptIndex).toBe(2);
    });

    it('setPromptInputValue updates state', () => {
      const { result } = renderHook(() =>
        usePromptSelection({ prompts: mockPrompts }),
      );

      act(() => {
        result.current.setPromptInputValue('test');
      });

      expect(result.current.promptInputValue).toBe('test');
    });
  });
});
