import { act, render, waitFor } from '@testing-library/react';
import { createRef } from 'react';

import {
  RichTextEditor,
  RichTextEditorHandle,
} from '@/components/Workflows/Document/RichTextEditor';

import { describe, expect, it, vi } from 'vitest';

/**
 * The overwrite gate (docs/REVIEW_EDIT_UNFREEZE_DESIGN.md §4, §6a) against a
 * REAL Tiptap editor: whether ProseMirror's `filterTransaction` sees the
 * right spans and honours the answer is exactly what a mock could not show.
 *
 * jsdom delivers neither `beforeinput` nor DOM mutations to ProseMirror, so
 * typing is driven through the handle's `insertText`, which dispatches the
 * same kind of transaction a keystroke does.
 */

const EDITS = [{ id: 'e1', before: 'brave new', after: 'bold old' }];

// <p>Hello brave new world</p>: text starts at position 1, so "brave" (text
// offset 6) begins at position 7.
const INSIDE_HELLO = 3;
const SPAN_START = 7;
const INSIDE_BRAVE = 9;

async function mount(gate: (ids: string[]) => boolean) {
  const ref = createRef<RichTextEditorHandle>();
  const onChange = vi.fn();
  const { container } = render(
    <RichTextEditor
      ref={ref}
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
  const pm = container.querySelector('.ProseMirror') as HTMLElement;
  const type = (pos: number, text: string) =>
    act(() => ref.current!.insertText(pos, pos, text));
  return { pm, onChange, type };
}

describe('RichTextEditor overwrite gate', () => {
  it('lets typing outside a suggestion through without asking', async () => {
    const gate = vi.fn(() => false);
    const { pm, onChange, type } = await mount(gate);

    await type(INSIDE_HELLO, 'X');

    expect(gate).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalled();
    expect(pm.textContent).toBe('HeXllo brave new world');
  });

  it('asks before typing inside a suggestion, and holds the keystroke on no', async () => {
    const gate = vi.fn(() => false);
    const { pm, onChange, type } = await mount(gate);

    await type(INSIDE_BRAVE, 'X');

    expect(gate).toHaveBeenCalledWith(['e1']);
    expect(onChange).not.toHaveBeenCalled();
    expect(pm.textContent).toBe('Hello brave new world');
  });

  it('lets the keystroke land on yes', async () => {
    const gate = vi.fn(() => true);
    const { pm, onChange, type } = await mount(gate);

    await type(INSIDE_BRAVE, 'X');

    expect(gate).toHaveBeenCalledWith(['e1']);
    expect(onChange).toHaveBeenCalled();
    expect(pm.textContent).toBe('Hello brXave new world');
  });

  it('does not ask for an insertion at the edge of a suggestion', async () => {
    const gate = vi.fn(() => false);
    const { pm, onChange, type } = await mount(gate);

    await type(SPAN_START, 'X');

    expect(gate).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalled();
    expect(pm.textContent).toBe('Hello Xbrave new world');
  });

  it('exempts a programmatic replaceRange from the gate', async () => {
    const gate = vi.fn(() => false);
    const ref = createRef<RichTextEditorHandle>();
    const { container } = render(
      <RichTextEditor
        ref={ref}
        contentHtml="<p>Hello brave new world</p>"
        onChange={vi.fn()}
        editable
        previewEdits={EDITS}
        onOverwriteEdits={gate}
      />,
    );
    await waitFor(() => {
      expect(container.querySelector('.edit-suggestion-mark')).toBeTruthy();
    });

    act(() => {
      ref.current!.replaceRange(INSIDE_BRAVE, INSIDE_BRAVE + 2, 'ZZ');
    });

    expect(gate).not.toHaveBeenCalled();
    expect(container.querySelector('.ProseMirror')?.textContent).toBe(
      'Hello brZZe new world',
    );
  });
});
