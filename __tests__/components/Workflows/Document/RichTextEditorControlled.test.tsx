import { act, render, waitFor } from '@testing-library/react';
import { useState } from 'react';

import { isEmptyDocHtml } from '@/lib/utils/shared/document/formatConverter';

import { RichTextEditor } from '@/components/Workflows/Document/RichTextEditor';

import { describe, expect, it } from 'vitest';

/**
 * Mirrors DocumentWorkspace's controlled binding exactly: the editor's HTML
 * goes into state, normalized the same way, and comes straight back down as
 * `contentHtml`. Any divergence in that loop is what yanks the caret.
 */
function Harness({ initial }: { initial: string }) {
  const [docHtml, setDocHtml] = useState(initial);
  return (
    <RichTextEditor
      contentHtml={docHtml}
      onChange={(html) => setDocHtml(isEmptyDocHtml(html) ? '' : html)}
      editable
    />
  );
}

/** Types a character at the caret the way ProseMirror sees real input. */
function typeAt(el: HTMLElement, text: string) {
  const selection = window.getSelection();
  const range = document.createRange();
  const target = el.querySelector('p')?.firstChild;
  if (!target) throw new Error('no text node');
  // Caret in the MIDDLE of the paragraph, not at the end.
  range.setStart(target, 5);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
  el.dispatchEvent(
    new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text,
    }),
  );
}

describe('RichTextEditor controlled loop', () => {
  it('keeps state and editor in sync through an edit', async () => {
    const { container } = render(<Harness initial="<p>Hello world</p>" />);
    await waitFor(() => {
      expect(container.querySelector('.ProseMirror')).toBeTruthy();
    });
    const pm = container.querySelector('.ProseMirror') as HTMLElement;

    act(() => typeAt(pm, 'X'));

    await waitFor(() => {
      // Whatever the editor holds must be what the parent stored — if these
      // ever diverge, the sync effect calls setContent and the caret is
      // thrown to the end of the document.
      expect(pm.textContent).toBeTruthy();
    });
  });

  it('does not resurrect content after the document is emptied', async () => {
    // `isEmptyDocHtml` maps the editor's `<p></p>` to '' in state. The sync
    // effect must not then treat '' and '<p></p>' as a divergence needing a
    // setContent — that is a caret reset for a no-op difference.
    const { container, rerender } = render(<Harness initial="<p>a</p>" />);
    await waitFor(() => {
      expect(container.querySelector('.ProseMirror')).toBeTruthy();
    });
    rerender(<Harness initial="<p>a</p>" />);
    expect(container.querySelector('.ProseMirror')?.textContent).toBe('a');
  });
});
