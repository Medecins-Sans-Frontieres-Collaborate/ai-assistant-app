'use client';

import { diffWords } from '@/lib/utils/shared/review/editApplication';

interface InlineWordDiffProps {
  before: string;
  after: string;
}

/** Word-level inline diff: red strikethrough deletions, green insertions. */
export function InlineWordDiff({ before, after }: InlineWordDiffProps) {
  const parts = diffWords(before, after);
  return (
    <span className="whitespace-pre-wrap break-words">
      {parts.map((part, i) =>
        part.kind === 'same' ? (
          <span key={i}>{part.text}</span>
        ) : part.kind === 'del' ? (
          <del
            key={i}
            className="rounded-sm bg-red-50 text-red-700 decoration-red-400 dark:bg-red-900/20 dark:text-red-400"
          >
            {part.text}
          </del>
        ) : (
          <ins
            key={i}
            className="rounded-sm bg-green-50 text-green-700 no-underline dark:bg-green-900/20 dark:text-green-400"
          >
            {part.text}
          </ins>
        ),
      )}
    </span>
  );
}
