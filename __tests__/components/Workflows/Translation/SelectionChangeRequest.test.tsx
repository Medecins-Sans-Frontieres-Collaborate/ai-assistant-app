import { fireEvent, render, screen } from '@testing-library/react';

import { locateSelection } from '@/lib/utils/shared/translation/changeRequest';

import { SelectionChangeRequest } from '@/components/Workflows/Translation/SelectionChangeRequest';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

const TEXT = 'Tome 1 comprimido. Luego tome 1 comprimido más.';
const FIELD = 'translation.changeSelectionLabel';

function mount(disabled = false) {
  const onSubmit = vi.fn();
  const view = render(
    <SelectionChangeRequest text={TEXT} disabled={disabled} onSubmit={onSubmit}>
      <span data-testid="text">{TEXT}</span>
    </SelectionChangeRequest>,
  );
  return { onSubmit, ...view };
}

/** Highlights characters [from, to) of the rendered text, as a drag would. */
function highlight(from: number, to: number) {
  const node = screen.getByTestId('text').firstChild!;
  const range = document.createRange();
  range.setStart(node, from);
  range.setEnd(node, to);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.mouseUp(screen.getByTestId('text'));
}

beforeEach(() => {
  window.getSelection()?.removeAllRanges();
});

describe('locateSelection', () => {
  it('uses the measured offset when the text is there', () => {
    expect(locateSelection(TEXT, '1 comprimido', 30)).toEqual({
      text: '1 comprimido',
      start: 30,
    });
  });

  it('falls back to the occurrence nearest a slightly wrong offset', () => {
    // Bracket the midpoint between the two occurrences (5 and 30).
    expect(locateSelection(TEXT, '1 comprimido', 17)?.start).toBe(5);
    expect(locateSelection(TEXT, '1 comprimido', 18)?.start).toBe(30);
  });

  it('drops whitespace caught by the drag and moves the start with it', () => {
    expect(locateSelection(TEXT, '  Luego tome ', 17)).toEqual({
      text: 'Luego tome',
      start: 19,
    });
  });

  it('returns null for blank text and for text that is not in the translation', () => {
    expect(locateSelection(TEXT, '   ', 3)).toBeNull();
    expect(locateSelection(TEXT, 'tableta', 3)).toBeNull();
  });
});

describe('SelectionChangeRequest', () => {
  it('offers nothing until text is highlighted', () => {
    mount();
    expect(screen.queryByLabelText(FIELD)).toBeNull();
  });

  it('sends the instruction with the highlighted passage and its place', () => {
    const { onSubmit } = mount();
    highlight(30, 42);
    const field = screen.getByLabelText(FIELD);
    expect(
      screen.getByText('translation.changeSelectionScope'),
    ).toBeInTheDocument();
    // Not focused: highlighting to copy must keep working.
    expect(field).not.toHaveFocus();
    fireEvent.change(field, { target: { value: '  say tableta ' } });
    fireEvent.submit(field.closest('form')!);
    expect(onSubmit).toHaveBeenCalledWith('say tableta', {
      text: '1 comprimido',
      start: 30,
    });
    expect(screen.queryByLabelText(FIELD)).toBeNull();
  });

  it('does not send an empty instruction', () => {
    const { onSubmit } = mount();
    highlight(0, 4);
    expect(
      screen.getByRole('button', { name: 'translation.changeSend' }),
    ).toBeDisabled();
    fireEvent.submit(screen.getByLabelText(FIELD).closest('form')!);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('keeps the offer while the user types in its field', () => {
    mount();
    highlight(0, 4);
    const field = screen.getByLabelText(FIELD);
    // Focusing the field collapses the page selection in a real browser.
    window.getSelection()!.removeAllRanges();
    fireEvent.mouseUp(field);
    fireEvent.keyUp(field, { key: 'a' });
    expect(screen.getByLabelText(FIELD)).toBeInTheDocument();
  });

  it('withdraws the offer on Escape, on the close button and on a click elsewhere', () => {
    mount();
    highlight(0, 4);
    fireEvent.keyDown(screen.getByLabelText(FIELD), { key: 'Escape' });
    expect(screen.queryByLabelText(FIELD)).toBeNull();

    highlight(0, 4);
    fireEvent.click(
      screen.getByRole('button', { name: 'translation.changeSelectionClose' }),
    );
    expect(screen.queryByLabelText(FIELD)).toBeNull();

    highlight(0, 4);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByLabelText(FIELD)).toBeNull();
  });

  it('withdraws the offer when the highlight is cleared', () => {
    mount();
    highlight(0, 4);
    window.getSelection()!.removeAllRanges();
    fireEvent.mouseUp(screen.getByTestId('text'));
    expect(screen.queryByLabelText(FIELD)).toBeNull();
  });

  it('offers nothing while requests are not possible', () => {
    const { rerender, onSubmit } = mount(true);
    highlight(0, 4);
    expect(screen.queryByLabelText(FIELD)).toBeNull();
    // And an open offer goes away when requests stop being possible.
    rerender(
      <SelectionChangeRequest text={TEXT} onSubmit={onSubmit}>
        <span data-testid="text">{TEXT}</span>
      </SelectionChangeRequest>,
    );
    highlight(0, 4);
    expect(screen.getByLabelText(FIELD)).toBeInTheDocument();
    rerender(
      <SelectionChangeRequest text={TEXT} disabled onSubmit={onSubmit}>
        <span data-testid="text">{TEXT}</span>
      </SelectionChangeRequest>,
    );
    expect(screen.queryByLabelText(FIELD)).toBeNull();
  });

  it('drops an offer whose passage is no longer in the text', () => {
    const { rerender, onSubmit } = mount();
    highlight(5, 17);
    expect(screen.getByLabelText(FIELD)).toBeInTheDocument();
    rerender(
      <SelectionChangeRequest text="Tome 1 tableta." onSubmit={onSubmit}>
        <span data-testid="text">Tome 1 tableta.</span>
      </SelectionChangeRequest>,
    );
    expect(screen.queryByLabelText(FIELD)).toBeNull();
  });
});
