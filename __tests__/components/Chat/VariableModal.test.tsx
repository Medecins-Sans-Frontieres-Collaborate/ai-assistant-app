import React from 'react';

import { Prompt } from '@/types/prompt';

import { VariableModal } from '@/components/Chat/ChatInput/VariableModal';

import { fireEvent, render, screen, within } from '@/__tests__/testUtils';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The form a prompt's variables are filled in with before it goes into the
 * message box: fields named in words with the sentence each sits in, a
 * live preview, defaults left empty, and keys to move and insert.
 */
describe('VariableModal', () => {
  const onSubmit = vi.fn();
  const onClose = vi.fn();
  const model = {
    id: 'gpt-4.1' as const,
    name: 'GPT-4.1',
    maxLength: 128000,
    tokenLimit: 128000,
  };
  const FORMULA: Prompt = {
    id: 'formula',
    name: 'Explain a formula',
    description: 'Explains a formula step by step for a chosen audience',
    content:
      'Explain the formula {{formula}} step by step for {{audience:a non-specialist}}.\n\n' +
      'Define every symbol and work one example using {{example_values:realistic values}}.',
    model,
    folderId: null,
  };

  const open = (prompt: Prompt = FORMULA) =>
    render(
      <VariableModal prompt={prompt} onSubmit={onSubmit} onClose={onClose} />,
    );
  const field = (label: RegExp) => screen.getByLabelText(label);
  const preview = () => screen.getByRole('region', { name: 'Message preview' });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is a dialog named after the prompt, with its description', () => {
    open();
    const dialog = screen.getByRole('dialog', { name: 'Explain a formula' });
    expect(dialog).toHaveTextContent(
      'Explains a formula step by step for a chosen audience',
    );
  });

  it('names each field in words and marks only the optional ones', () => {
    open();
    expect(field(/^Formula$/)).toBeInTheDocument();
    expect(field(/^Audience \(optional\)$/)).toBeInTheDocument();
    expect(field(/^Example values \(optional\)$/)).toBeInTheDocument();
  });

  it('describes each field with the sentence it sits in', () => {
    open();
    expect(field(/^Formula$/)).toHaveAccessibleDescription(
      'Explain the formula [Formula] step by step for a non-specialist.',
    );
    expect(field(/^Example values/)).toHaveAccessibleDescription(
      'Define every symbol and work one example using realistic values.',
    );
  });

  it('offers a default as the placeholder, shown once', () => {
    open();
    expect(field(/^Audience/)).toHaveAttribute(
      'placeholder',
      'a non-specialist (default)',
    );
    expect(screen.queryByText(/Default:/)).toBeNull();
  });

  it('starts in the first field', () => {
    open();
    expect(document.activeElement).toBe(field(/^Formula$/));
  });

  it('previews the message as it is typed', () => {
    open();
    expect(preview()).toHaveTextContent(
      'Explain the formula [Formula] step by step for a non-specialist.',
    );
    fireEvent.change(field(/^Formula$/), { target: { value: 'E = mc^2' } });
    expect(preview()).toHaveTextContent(
      'Explain the formula E = mc^2 step by step for a non-specialist.',
    );
  });

  it('points at a missing value instead of inserting', () => {
    open();
    fireEvent.click(
      screen.getByRole('button', { name: 'Insert into message' }),
    );
    expect(onSubmit).not.toHaveBeenCalled();
    const formula = field(/^Formula$/);
    expect(formula).toHaveAttribute('aria-invalid', 'true');
    expect(formula).toHaveAccessibleDescription(
      expect.stringContaining('Fill this in to use the prompt.'),
    );
    expect(document.activeElement).toBe(formula);
    // Typing clears the warning.
    fireEvent.change(formula, { target: { value: 'x' } });
    expect(formula).not.toHaveAttribute('aria-invalid');
  });

  it('inserts with defaults standing in for empty fields', () => {
    open();
    fireEvent.change(field(/^Formula$/), { target: { value: 'E = mc^2' } });
    fireEvent.change(field(/^Audience/), { target: { value: 'nurses' } });
    fireEvent.click(
      screen.getByRole('button', { name: 'Insert into message' }),
    );
    expect(onSubmit).toHaveBeenCalledWith(['E = mc^2', 'nurses', ''], {
      formula: 'E = mc^2',
      audience: 'nurses',
      example_values: '',
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('moves on with Enter and inserts from the last field', () => {
    open();
    const formula = field(/^Formula$/);
    fireEvent.change(formula, { target: { value: 'E = mc^2' } });
    fireEvent.keyDown(formula, { key: 'Enter' });
    expect(document.activeElement).toBe(field(/^Audience/));
    fireEvent.keyDown(field(/^Audience/), { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(field(/^Example values/), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('inserts from any field with Ctrl+Enter, and leaves Shift+Enter to the text', () => {
    open();
    const formula = field(/^Formula$/);
    fireEvent.change(formula, { target: { value: 'E = mc^2' } });
    expect(fireEvent.keyDown(formula, { key: 'Enter', shiftKey: true })).toBe(
      true,
    );
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(formula, { key: 'Enter', ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('cancels with the button and with Escape', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('asks once for a variable used twice', () => {
    open({
      ...FORMULA,
      content: 'Dear {{name}}, thank you. Kind regards to {{name}}.',
    });
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    fireEvent.change(field(/^Name$/), { target: { value: 'Ada' } });
    expect(within(preview()).getAllByText('Ada', { exact: true })).toHaveLength(
      2,
    );
  });
});
