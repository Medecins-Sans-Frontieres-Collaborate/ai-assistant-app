import { act, render, waitFor } from '@testing-library/react';

import { RichTextEditor } from '@/components/Workflows/Document/RichTextEditor';

import { describe, expect, it, vi } from 'vitest';

/**
 * The overwrite gate (docs/REVIEW_EDIT_UNFREEZE_DESIGN.md §4, §6a) with a REAL
 * Tiptap editor: the question is whether ProseMirror's `filterTransaction`
 * sees the right spans and honours the answer, which a mock cannot show.
 */

const EDITS = [{ id: 'e1', before: 'brave new', after: 'bold old' }];

/** Places the caret at a character offset within the first paragraph and types. */
function typeAt(pm: HTMLElement, offset: number, text: string) {
  const paragraph = pm.querySelector('p');
  if (!paragraph) throw new Error('no paragraph');
  const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let node = walker.nextNode();
  while (node && remaining > (node.textContent?.length ?? 0)) {
    remaining -= node.textContent?.length ?? 0;
    node = walker.nextNode();
  }
  if (!node) throw new Error('offset past end');
  const range = document.createRange();
  range.setStart(node, remaining);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  pm.dispatchEvent(
    new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text,
    }),
  );
}

async function mount(gate: (ids: string[]) => boolean) {
  const onChange = vi.fn();
  const { container } = render(
    <RichTextEditor
      contentHtml="<p>Hello brave new world</p>"
      onChange={onChange}
      editable
      previewEdits={EDITS}
      onOverwriteEdits={gate}
    />,
  );
  await waitFor(() => {
    expect(container.querySelector('.edit-suggestion-mark')).toBeTruthy();
  });
  return {
    pm: container.querySelector('.ProseMirror') as HTMLElement,
    onChange,
  };
}

describe('RichTextEditor overwrite gate', () => {
  it('lets typing outside a suggestion through without asking', async () => {
    const gate = vi.fn(() => false);
    const { pm, onChange } = await mount(gate);

    act(() => typeAt(pm, 2, 'X')); // inside "Hello"

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(gate).not.toHaveBeenCalled();
    expect(pm.textContent).toBe('HeXllo brave new world');
  });

  it('asks before typing inside a suggestion, and holds the keystroke on no', async () => {
    const gate = vi.fn(() => false);
    const { pm, onChange } = await mount(gate);

    act(() => typeAt(pm, 8, 'X')); // inside "brave"

    expect(gate).toHaveBeenCalledWith(['e1']);
    expect(pm.textContent).toBe('Hello brave new world');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('lets the keystroke land on yes', async () => {
    const gate = vi.fn(() => true);
    const { pm, onChange } = await mount(gate);

    act(() => typeAt(pm, 8, 'X'));

    expect(gate).toHaveBeenCalledWith(['e1']);
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(pm.textContent).toBe('Hello brXave new world');
  });

  it('does not ask for an insertion at the edge of a suggestion', async () => {
    const gate = vi.fn(() => false);
    const { pm, onChange } = await mount(gate);

    act(() => typeAt(pm, 6, 'X')); // exactly where "brave" begins

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(gate).not.toHaveBeenCalled();
  });
});
