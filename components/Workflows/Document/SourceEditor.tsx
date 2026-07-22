'use client';

import { FC } from 'react';

interface SourceEditorProps {
  value: string;
  onChange: (next: string) => void;
  editable: boolean;
  label: string;
}

/**
 * Plain source editing for the Document workflow — the markdown and HTML
 * modes behind the editor-mode switch.
 *
 * Deliberately a bare textarea rather than a code editor: the document is
 * prose, the round-trip to `docHtml` happens on every keystroke in
 * DocumentWorkspace, and a syntax-highlighting editor would drag in a second
 * editing engine alongside Tiptap for no gain a writer would notice.
 *
 * Spellcheck is off — in these modes the buffer contains markup, and every
 * tag and fence would be underlined as a misspelling.
 */
export const SourceEditor: FC<SourceEditorProps> = ({
  value,
  onChange,
  editable,
  label,
}) => (
  <textarea
    aria-label={label}
    value={value}
    onChange={(e) => onChange(e.target.value)}
    readOnly={!editable}
    spellCheck={false}
    autoComplete="off"
    autoCorrect="off"
    autoCapitalize="off"
    className="h-full w-full resize-none border-0 bg-transparent px-4 py-3 font-mono text-sm leading-relaxed text-gray-900 focus:outline-none read-only:opacity-60 dark:text-gray-100"
  />
);
