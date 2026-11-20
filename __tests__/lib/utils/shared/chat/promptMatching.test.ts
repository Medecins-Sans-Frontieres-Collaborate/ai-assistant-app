import {
  MAX_PROMPT_QUERY_CHARS,
  findPromptMatch,
  groupPromptsForList,
  promptMatchesQuery,
  replacePromptTrigger,
  updatePromptListVisibility,
} from '@/lib/utils/shared/chat/promptMatching';

import type { Prompt } from '@/types/prompt';

import { describe, expect, it } from 'vitest';

describe('promptMatching', () => {
  describe('findPromptMatch', () => {
    it('should find prompt pattern at end of string', () => {
      const result = findPromptMatch('Hello /email');

      expect(result.matched).toBe(true);
      expect(result.searchTerm).toBe('email');
    });

    it('should find prompt pattern with longer command', () => {
      const result = findPromptMatch('/professionalEmail');

      expect(result.matched).toBe(true);
      expect(result.searchTerm).toBe('professionalEmail');
    });

    it('should find partial prompt pattern', () => {
      const result = findPromptMatch('Use /em');

      expect(result.matched).toBe(true);
      expect(result.searchTerm).toBe('em');
    });

    it('should find prompt pattern with just slash', () => {
      const result = findPromptMatch('Type /');

      expect(result.matched).toBe(true);
      expect(result.searchTerm).toBe('');
    });

    // Prompt names have spaces, so the search does too: the list shows
    // only while a name holds it (usePromptSelection), so ordinary text
    // after a "/" simply finds nothing.
    it('keeps spaces in the search, for names of several words', () => {
      const result = findPromptMatch('/Weekly status');

      expect(result.matched).toBe(true);
      expect(result.searchTerm).toBe('Weekly status');
    });

    it('should not match slash with space after', () => {
      const result = findPromptMatch('Use / prompt');

      expect(result.matched).toBe(false);
      expect(result.searchTerm).toBe('');
    });

    it('should not match text without slash', () => {
      const result = findPromptMatch('Hello world');

      expect(result.matched).toBe(false);
      expect(result.searchTerm).toBe('');
    });

    it('should not match empty string', () => {
      const result = findPromptMatch('');

      expect(result.matched).toBe(false);
      expect(result.searchTerm).toBe('');
    });

    it('should handle slash followed by numbers', () => {
      const result = findPromptMatch('/123');

      expect(result.matched).toBe(true);
      expect(result.searchTerm).toBe('123');
    });

    it('should handle slash followed by underscore', () => {
      const result = findPromptMatch('/my_prompt');

      expect(result.matched).toBe(true);
      expect(result.searchTerm).toBe('my_prompt');
    });

    it('should handle camelCase command', () => {
      const result = findPromptMatch('/camelCasePrompt');

      expect(result.matched).toBe(true);
      expect(result.searchTerm).toBe('camelCasePrompt');
    });

    it('keeps hyphens and accented letters in the search', () => {
      expect(findPromptMatch('/email-test').searchTerm).toBe('email-test');
      expect(findPromptMatch('/Résumé').searchTerm).toBe('Résumé');
    });

    it('should not match slash followed by space', () => {
      const result = findPromptMatch('/ ');

      expect(result.matched).toBe(false);
      expect(result.searchTerm).toBe('');
    });

    it('should match at end after newline', () => {
      const result = findPromptMatch('Hello\n/world');

      expect(result.matched).toBe(true);
      expect(result.searchTerm).toBe('world');
    });

    it('should handle very long command name', () => {
      const longCommand = 'a'.repeat(100);
      const result = findPromptMatch(`/${longCommand}`);

      expect(result.matched).toBe(true);
      expect(result.searchTerm).toBe(longCommand);
    });

    it('should handle uppercase letters', () => {
      const result = findPromptMatch('/EMAIL');

      expect(result.matched).toBe(true);
      expect(result.searchTerm).toBe('EMAIL');
    });

    it('should handle mixed case', () => {
      const result = findPromptMatch('/EmAiL');

      expect(result.matched).toBe(true);
      expect(result.searchTerm).toBe('EmAiL');
    });

    it('does not match a slash right after another character', () => {
      // "and/", "//" and the end of a URL or path are not the trigger.
      expect(findPromptMatch('//email').matched).toBe(false);
      expect(findPromptMatch('this and/').matched).toBe(false);
      expect(findPromptMatch('see example.com/docs').matched).toBe(false);
    });

    it('stops matching past the longest search', () => {
      const atLimit = 'a'.repeat(MAX_PROMPT_QUERY_CHARS);
      expect(findPromptMatch(`/${atLimit}`).matched).toBe(true);
      expect(findPromptMatch(`/${atLimit}a`).matched).toBe(false);
    });

    it('should handle text with multiple potential patterns', () => {
      const result = findPromptMatch('/old command /new');

      expect(result.matched).toBe(true);
      expect(result.searchTerm).toBe('new'); // Only matches the last one
    });

    it('should handle single character command', () => {
      const result = findPromptMatch('/a');

      expect(result.matched).toBe(true);
      expect(result.searchTerm).toBe('a');
    });

    it('should handle command with numbers and letters', () => {
      const result = findPromptMatch('/email2024');

      expect(result.matched).toBe(true);
      expect(result.searchTerm).toBe('email2024');
    });

    it('should not match URL', () => {
      const result = findPromptMatch('https://example.com');

      expect(result.matched).toBe(false);
      expect(result.searchTerm).toBe('');
    });

    it('should not match file path', () => {
      const result = findPromptMatch('/home/user/file.txt');

      expect(result.matched).toBe(false);
      expect(result.searchTerm).toBe('');
    });

    it('should match command at very end', () => {
      const result = findPromptMatch('Please use /format');

      expect(result.matched).toBe(true);
      expect(result.searchTerm).toBe('format');
    });

    it('should handle whitespace before command', () => {
      const result = findPromptMatch('Text   /command');

      expect(result.matched).toBe(true);
      expect(result.searchTerm).toBe('command');
    });
  });

  describe('updatePromptListVisibility', () => {
    it('should show list when prompt pattern is found', () => {
      const result = updatePromptListVisibility('Hello /email');

      expect(result.showList).toBe(true);
      expect(result.inputValue).toBe('email');
    });

    it('should hide list when no prompt pattern', () => {
      const result = updatePromptListVisibility('Hello world');

      expect(result.showList).toBe(false);
      expect(result.inputValue).toBe('');
    });

    it('should show list with empty search term for just slash', () => {
      const result = updatePromptListVisibility('Type /');

      expect(result.showList).toBe(true);
      expect(result.inputValue).toBe('');
    });

    it('should show list with partial command', () => {
      const result = updatePromptListVisibility('/em');

      expect(result.showList).toBe(true);
      expect(result.inputValue).toBe('em');
    });

    it('should hide list for empty string', () => {
      const result = updatePromptListVisibility('');

      expect(result.showList).toBe(false);
      expect(result.inputValue).toBe('');
    });

    it('should hide list when a line follows the slash', () => {
      const result = updatePromptListVisibility('/email\nis great');

      expect(result.showList).toBe(false);
      expect(result.inputValue).toBe('');
    });

    it('should show list with full command name', () => {
      const result = updatePromptListVisibility('/professionalEmail');

      expect(result.showList).toBe(true);
      expect(result.inputValue).toBe('professionalEmail');
    });

    it('should show list for single character', () => {
      const result = updatePromptListVisibility('/a');

      expect(result.showList).toBe(true);
      expect(result.inputValue).toBe('a');
    });

    it('should show list for command with numbers', () => {
      const result = updatePromptListVisibility('Use /test123');

      expect(result.showList).toBe(true);
      expect(result.inputValue).toBe('test123');
    });

    it('should show list for command with underscore', () => {
      const result = updatePromptListVisibility('/my_command');

      expect(result.showList).toBe(true);
      expect(result.inputValue).toBe('my_command');
    });

    it('should hide list for slash followed by space', () => {
      const result = updatePromptListVisibility('/ ');

      expect(result.showList).toBe(false);
      expect(result.inputValue).toBe('');
    });

    it('should show list for uppercase command', () => {
      const result = updatePromptListVisibility('/EMAIL');

      expect(result.showList).toBe(true);
      expect(result.inputValue).toBe('EMAIL');
    });

    it('should handle very long command', () => {
      const longCommand = 'a'.repeat(50);
      const result = updatePromptListVisibility(`/${longCommand}`);

      expect(result.showList).toBe(true);
      expect(result.inputValue).toBe(longCommand);
    });

    it('should show list after text with slash at end', () => {
      const result = updatePromptListVisibility('Write an email using /');

      expect(result.showList).toBe(true);
      expect(result.inputValue).toBe('');
    });

    it('should handle newline before command', () => {
      const result = updatePromptListVisibility('Hello\n/world');

      expect(result.showList).toBe(true);
      expect(result.inputValue).toBe('world');
    });

    it('should only use last prompt pattern', () => {
      const result = updatePromptListVisibility('/old /new');

      expect(result.showList).toBe(true);
      expect(result.inputValue).toBe('new');
    });
  });

  describe('Integration scenarios', () => {
    it('should handle typing sequence', () => {
      // User types slash
      let result = updatePromptListVisibility('/');
      expect(result.showList).toBe(true);
      expect(result.inputValue).toBe('');

      // User types 'e'
      result = updatePromptListVisibility('/e');
      expect(result.showList).toBe(true);
      expect(result.inputValue).toBe('e');

      // User types 'ma'
      result = updatePromptListVisibility('/ema');
      expect(result.showList).toBe(true);
      expect(result.inputValue).toBe('ema');

      // User types 'il'
      result = updatePromptListVisibility('/email');
      expect(result.showList).toBe(true);
      expect(result.inputValue).toBe('email');
    });

    it('should handle backspace sequence', () => {
      // Start with full command
      let result = updatePromptListVisibility('/email');
      expect(result.showList).toBe(true);
      expect(result.inputValue).toBe('email');

      // Backspace to '/ema'
      result = updatePromptListVisibility('/ema');
      expect(result.showList).toBe(true);
      expect(result.inputValue).toBe('ema');

      // Backspace to '/'
      result = updatePromptListVisibility('/');
      expect(result.showList).toBe(true);
      expect(result.inputValue).toBe('');

      // Backspace removes slash
      result = updatePromptListVisibility('');
      expect(result.showList).toBe(false);
      expect(result.inputValue).toBe('');
    });

    it('should handle command selection and continuation', () => {
      // User types command
      let result = updatePromptListVisibility('/email');
      expect(result.showList).toBe(true);

      // User selects and continues typing
      result = updatePromptListVisibility('Hello there');
      expect(result.showList).toBe(false);

      // User starts new command
      result = updatePromptListVisibility('Hello there /format');
      expect(result.showList).toBe(true);
      expect(result.inputValue).toBe('format');
    });

    it('should handle clearing and retyping', () => {
      // User types command
      let result = updatePromptListVisibility('/email');
      expect(result.showList).toBe(true);

      // User clears input
      result = updatePromptListVisibility('');
      expect(result.showList).toBe(false);

      // User starts typing new command
      result = updatePromptListVisibility('/format');
      expect(result.showList).toBe(true);
      expect(result.inputValue).toBe('format');
    });
  });

  describe('replacePromptTrigger', () => {
    it('replaces "/" and its search, keeping what came before', () => {
      expect(replacePromptTrigger('Notes: /exec', 'Summarise:')).toBe(
        'Notes: Summarise:',
      );
      expect(replacePromptTrigger('/Weekly sta', 'Body')).toBe('Body');
      expect(replacePromptTrigger('Line one\n/x', 'Body')).toBe(
        'Line one\nBody',
      );
    });

    it('leaves text without the trigger alone', () => {
      expect(replacePromptTrigger('this and/', 'Body')).toBe('this and/');
    });
  });

  describe('promptMatchesQuery and groupPromptsForList', () => {
    const prompt = (id: string, name: string, folderId: string | null) =>
      ({ id, name, content: '', folderId }) as unknown as Prompt;

    it('matches names ignoring case and accents', () => {
      expect(
        promptMatchesQuery(prompt('1', 'Résumé check', null), 'resume'),
      ).toBe(true);
      expect(promptMatchesQuery(prompt('1', 'Email', null), 'mail')).toBe(true);
      expect(promptMatchesQuery(prompt('1', 'Email', null), 'memo')).toBe(
        false,
      );
    });

    it('orders by folder, then loose prompts; an unknown folder counts as none', () => {
      const folders = [
        { id: 'f2', name: 'Two', type: 'prompt' as const },
        { id: 'chat', name: 'Chats', type: 'chat' as const },
        { id: 'f1', name: 'One', type: 'prompt' as const },
      ];
      const { groups, ordered } = groupPromptsForList(
        [
          prompt('a', 'A', null),
          prompt('b', 'B', 'f1'),
          prompt('c', 'C', 'f2'),
          prompt('d', 'D', 'deleted'),
          prompt('e', 'E', 'chat'),
        ],
        folders,
      );
      expect(groups.map((group) => group.folder?.name ?? null)).toEqual([
        'Two',
        'One',
        null,
      ]);
      expect(ordered.map((p) => p.name)).toEqual(['C', 'B', 'A', 'D', 'E']);
    });
  });
});
