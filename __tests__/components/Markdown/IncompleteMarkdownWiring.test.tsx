import { render } from '@testing-library/react';

import { CitationStreamdown } from '@/components/Markdown/CitationStreamdown';
import { MathStreamdown } from '@/components/Markdown/MathStreamdown';
import { MATH_PARSE_INCOMPLETE_MARKDOWN } from '@/components/Markdown/mathRehype';

import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { streamdownProps } = vi.hoisted(() => ({
  streamdownProps: [] as Record<string, unknown>[],
}));

// Capture what the two app renderers hand `<Streamdown>`. `defaultRehypePlugins`
// is part of the mock because `mathRehype` builds its KaTeX-aware sanitize chain
// from that export at module load.
vi.mock('streamdown', () => ({
  Streamdown: (props: Record<string, unknown>) => {
    streamdownProps.push(props);
    return <div data-testid="streamdown">{String(props.children ?? '')}</div>;
  },
  defaultRehypePlugins: {},
}));

/**
 * WHY THIS TEST EXISTS.
 *
 * `MATH_PARSE_INCOMPLETE_MARKDOWN` being `false` buys nothing unless both
 * renderers actually FORWARD it: Streamdown's own default is
 * `parseIncompleteMarkdown = true`, so a dropped prop silently restores remend.
 * Measured cost of that regression, on the real components in jsdom:
 * `The array notation \[ is introduced later…` renders as
 * `…guide.](streamdown:incomplete-link)` (CommonMark never opens a link on an
 * escaped bracket, so remend's closer lands in the prose), and
 * `Area:\n\n$$\frac{\te` renders a `.katex-error` span that churns on every token.
 *
 * The node conformance harness cannot see this: it reads the CONSTANT
 * (`APP_APPLIES_REMEND` in `__tests__/lib/markdown/renderPipelines.ts`), never
 * the wiring. Nor can the other component tests: they all render `mode="static"`,
 * the one mode in which Streamdown ignores this prop entirely. So the prop value
 * each renderer forwards is asserted here, directly.
 */
describe('incomplete-markdown wiring — the prop reaches <Streamdown>', () => {
  beforeEach(() => {
    streamdownProps.length = 0;
  });

  it('the app setting is off, which is what the assertions below pin', () => {
    expect(MATH_PARSE_INCOMPLETE_MARKDOWN).toBe(false);
  });

  it('MathStreamdown forwards parseIncompleteMarkdown', () => {
    render(
      <MathStreamdown mode="streaming">{'Area \\[ x \\]'}</MathStreamdown>,
    );

    expect(streamdownProps.at(-1)?.parseIncompleteMarkdown).toBe(
      MATH_PARSE_INCOMPLETE_MARKDOWN,
    );
  });

  it('CitationStreamdown forwards parseIncompleteMarkdown', () => {
    render(
      <CitationStreamdown mode="streaming">
        {'Area \\[ x \\]'}
      </CitationStreamdown>,
    );

    expect(streamdownProps.at(-1)?.parseIncompleteMarkdown).toBe(
      MATH_PARSE_INCOMPLETE_MARKDOWN,
    );
  });

  it('an explicit override still wins, so a call site can opt back in', () => {
    render(
      <MathStreamdown mode="streaming" parseIncompleteMarkdown>
        {'Area \\[ x \\]'}
      </MathStreamdown>,
    );

    expect(streamdownProps.at(-1)?.parseIncompleteMarkdown).toBe(true);
  });
});
