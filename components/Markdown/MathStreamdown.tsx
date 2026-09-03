'use client';

// components/Markdown/MathStreamdown.tsx
import { FC } from 'react';

import {
  MATH_PARSE_INCOMPLETE_MARKDOWN,
  MATH_REHYPE_PLUGINS,
} from './mathRehype';

import { Streamdown } from 'streamdown';
import type { StreamdownProps } from 'streamdown';

/**
 * Bare Streamdown with the KaTeX-aware sanitize schema already applied — the
 * drop-in replacement for `<Streamdown>` at every call site that does NOT need
 * citation tooltips (`CitationStreamdown` carries the same config).
 *
 * Renderer configuration only: it deliberately does NOT normalize math
 * delimiters. Whether `\( … \)` should be rewritten depends on who wrote the
 * text — model output yes, a user's own message no — so that decision stays
 * visible at the call site rather than hiding behind a default here.
 *
 * Also exported as default so it can be `next/dynamic`-imported as one lazy
 * chunk; importing the plugin list on its own would drag Streamdown (and Shiki,
 * and KaTeX) into whatever bundle did the importing.
 */
export const MathStreamdown: FC<StreamdownProps> = ({
  rehypePlugins = MATH_REHYPE_PLUGINS,
  parseIncompleteMarkdown = MATH_PARSE_INCOMPLETE_MARKDOWN,
  ...props
}) => (
  <Streamdown
    rehypePlugins={rehypePlugins}
    parseIncompleteMarkdown={parseIncompleteMarkdown}
    {...props}
  />
);

MathStreamdown.displayName = 'MathStreamdown';

export default MathStreamdown;
