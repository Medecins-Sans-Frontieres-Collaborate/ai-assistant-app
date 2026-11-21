import { fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';

import { Prompt } from '@/types/prompt';

import {
  PromptList,
  promptOptionId,
} from '@/components/Chat/ChatInput/PromptList';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

/**
 * The prompts offered while typing "/": the order shown is the order the
 * keys count in, a click uses the prompt clicked, and each prompt says
 * what it will ask for.
 */
describe('PromptList', () => {
  const prompt = (
    id: string,
    name: string,
    folderId: string | null,
    content = '',
  ): Prompt => ({
    id,
    name,
    description: `${name} description`,
    content,
    model: {} as Prompt['model'],
    folderId,
  });
  const folders = [{ id: 'work', name: 'Work', type: 'prompt' as const }];
  const PROMPTS = [
    prompt('loose', 'Loose prompt', null),
    prompt('filed', 'Filed prompt', 'work', 'Use {{target_language}}'),
    prompt('orphan', 'Orphan prompt', 'deleted-folder'),
  ];

  const show = (
    overrides: Partial<React.ComponentProps<typeof PromptList>>,
  ) => {
    const props = {
      prompts: PROMPTS,
      folders,
      activePromptIndex: 0,
      onSelect: vi.fn(),
      onMouseOver: vi.fn(),
      promptListRef: { current: null },
      id: 'list',
      ...overrides,
    };
    render(<PromptList {...props} />);
    return props;
  };

  it('is a listbox of options in folder order, the folderless last', () => {
    show({});
    const list = screen.getByRole('listbox');
    expect(
      within(list)
        .getAllByRole('option')
        .map((option) => option.firstElementChild?.textContent),
    ).toEqual(['Filed prompt', 'Loose prompt', 'Orphan prompt']);
  });

  it('marks the highlighted option for the message box to point at', () => {
    show({ activePromptIndex: 1 });
    const options = screen.getAllByRole('option');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    expect(options[1].id).toBe(promptOptionId('list', 1));
    expect(options[0]).toHaveAttribute('aria-selected', 'false');
  });

  it('uses the prompt clicked, by its position, whatever is highlighted', () => {
    const { onSelect } = show({ activePromptIndex: 0 });
    fireEvent.click(screen.getByText('Orphan prompt'));
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it('keeps the keyboard in the message box when an option is pressed', () => {
    show({});
    const pressed = fireEvent.mouseDown(screen.getByText('Loose prompt'));
    expect(pressed).toBe(false);
  });

  it('says what a prompt will ask for', () => {
    show({});
    const [filed, loose] = screen.getAllByRole('option');
    expect(
      within(filed).getByText('Asks for Target language'),
    ).toBeInTheDocument();
    // A prompt with nothing to fill in says nothing about it.
    expect(within(loose).queryByText(/Asks for/)).toBeNull();
  });
});
