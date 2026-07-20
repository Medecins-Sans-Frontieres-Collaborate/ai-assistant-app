import { render, waitFor } from '@testing-library/react';

import { RichTextEditor } from '@/components/Workflows/Document/RichTextEditor';

import { describe, expect, it, vi } from 'vitest';

/**
 * Uses a REAL Tiptap editor rather than a mock. The regression these tests
 * guard lives in Tiptap's own `setEditable(editable, emitUpdate = true)`
 * default, which a mocked editor would paper over entirely.
 */
describe('RichTextEditor', () => {
  it('does not report a change when mounted with an empty document', async () => {
    const onChange = vi.fn();
    render(<RichTextEditor contentHtml="" onChange={onChange} editable />);

    // `setEditable` runs in a mount effect. It used to emit an "update", which
    // fired onChange with Tiptap's empty-document HTML (`<p></p>`) and made a
    // brand-new document look edited — so opening the Document workflow and
    // leaving asked the user to discard changes they had never made.
    await waitFor(() => {
      expect(document.querySelector('.ProseMirror')).toBeTruthy();
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not report a change when editability is toggled', async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <RichTextEditor contentHtml="<p>Existing</p>" onChange={onChange} />,
    );
    await waitFor(() => {
      expect(document.querySelector('.ProseMirror')).toBeTruthy();
    });
    onChange.mockClear();

    // Assessing/streaming flips `editable` constantly. None of that is a
    // content change, so none of it should write back to workflow state.
    rerender(
      <RichTextEditor
        contentHtml="<p>Existing</p>"
        onChange={onChange}
        editable={false}
      />,
    );
    rerender(
      <RichTextEditor
        contentHtml="<p>Existing</p>"
        onChange={onChange}
        editable
      />,
    );

    expect(onChange).not.toHaveBeenCalled();
  });
});
