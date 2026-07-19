import { fireEvent, render, screen } from '@testing-library/react';

import { AnnotatedText } from '@/components/Workflows/Shared/Review/AnnotatedText';

import { beforeAll, describe, expect, it, vi } from 'vitest';

// next-intl is mocked globally (vitest.setup.dom.ts) and has no `workflows`
// namespace, so labels fall back to the bare key — as in the other
// Workflows component tests.
const ACCEPT = 'acceptEdit';
const REJECT = 'rejectEdit';

const EDITS = [
  { id: 'a', before: 'quick', after: 'swift' },
  { id: 'b', before: 'lazy dog', after: 'sleeping dog' },
];

const TEXT = 'The quick brown fox jumps over the lazy dog.';

beforeAll(() => {
  // jsdom has no layout engine; the active span scrolls itself into view.
  Element.prototype.scrollIntoView = () => {};
});

function setup(
  props: Partial<React.ComponentProps<typeof AnnotatedText>> = {},
) {
  const onPin = vi.fn();
  const onHover = vi.fn();
  const onAccept = vi.fn();
  const onReject = vi.fn();
  const utils = render(
    <AnnotatedText
      text={TEXT}
      edits={EDITS}
      activeId={null}
      pinnedId={null}
      onPin={onPin}
      onHover={onHover}
      i18nNamespace="workflows.translation"
      onAccept={onAccept}
      onReject={onReject}
      {...props}
    />,
  );
  return { ...utils, onPin, onHover, onAccept, onReject };
}

/**
 * Pin state lives in the parent, but the action bar's position comes from
 * the click itself — so exercising it needs a real click, not just a
 * `pinnedId` prop.
 */
function Harness({
  onAccept = () => {},
  onReject = () => {},
  resolveUnpins = true,
}: {
  onAccept?: (id: string) => void;
  onReject?: (id: string) => void;
  /** Set false to isolate click-bubbling from the resolve-then-unpin flow. */
  resolveUnpins?: boolean;
}) {
  const [pinnedId, setPinnedId] = React.useState<string | null>(null);
  const [hoveredId, setHoveredId] = React.useState<string | null>(null);
  return (
    <AnnotatedText
      text={TEXT}
      edits={EDITS}
      activeId={hoveredId ?? pinnedId}
      pinnedId={pinnedId}
      onPin={setPinnedId}
      onHover={setHoveredId}
      i18nNamespace="workflows.translation"
      // Resolving drops the edit from the queue, which unpins it — mirror
      // that here (the workspaces get it from useEditPreview).
      onAccept={(id) => {
        onAccept(id);
        if (resolveUnpins) setPinnedId(null);
      }}
      onReject={(id) => {
        onReject(id);
        if (resolveUnpins) setPinnedId(null);
      }}
    />
  );
}

/** Clicks the span for edit `a`, which is what produces the action bar. */
function clickFirstMark(container: HTMLElement) {
  fireEvent.click(container.querySelectorAll('mark')[0]);
}

describe('AnnotatedText', () => {
  it('renders plain text when there are no edits', () => {
    const { container } = setup({ edits: [] });
    expect(container.textContent).toBe(TEXT);
    expect(container.querySelectorAll('mark')).toHaveLength(0);
  });

  it('marks every pending edit without altering the text', () => {
    const { container } = setup();
    expect(container.textContent).toBe(TEXT);
    expect(
      [...container.querySelectorAll('mark')].map((m) => m.textContent),
    ).toEqual(['quick', 'lazy dog']);
  });

  it('expands the active edit into an inline diff, leaving others marked', () => {
    const { container } = setup({ activeId: 'a' });
    expect(container.querySelector('ins')?.textContent).toBe('swift');
    expect(
      [...container.querySelectorAll('del')].map((d) => d.textContent),
    ).toEqual(['quick']);
    expect(container.textContent).toContain('lazy dog');
  });

  it('keeps the surrounding sentence visible around the diff', () => {
    const { container } = setup({ activeId: 'a' });
    expect(container.textContent).toContain('The ');
    expect(container.textContent).toContain(' brown fox jumps over');
  });

  it('leaves unlocatable edits unmarked rather than guessing', () => {
    const { container } = setup({
      edits: [{ id: 'x', before: 'not in the text', after: 'y' }],
      activeId: 'x',
    });
    expect(container.textContent).toBe(TEXT);
    expect(container.querySelectorAll('mark')).toHaveLength(0);
  });

  it('pins the edit when its span is clicked', () => {
    const { container, onPin } = setup();
    fireEvent.click(container.querySelectorAll('mark')[0]);
    expect(onPin).toHaveBeenCalledWith('a');
  });

  it('unpins when the already-pinned span is clicked again', () => {
    const { container, onPin } = setup({ activeId: 'a', pinnedId: 'a' });
    fireEvent.click(container.querySelector('mark')!);
    expect(onPin).toHaveBeenCalledWith(null);
  });

  it('pins via keyboard on Enter', () => {
    const { container, onPin } = setup();
    fireEvent.keyDown(container.querySelectorAll('mark')[0], { key: 'Enter' });
    expect(onPin).toHaveBeenCalledWith('a');
  });

  it('reports hover so the matching card can highlight in step', () => {
    const { container, onHover } = setup();
    fireEvent.mouseEnter(container.querySelectorAll('mark')[0]);
    expect(onHover).toHaveBeenCalledWith('a');
    fireEvent.mouseLeave(container.querySelectorAll('mark')[0]);
    expect(onHover).toHaveBeenCalledWith(null);
  });

  it('shows no quick actions until a span is clicked', () => {
    const { container } = render(<Harness />);
    expect(screen.queryByLabelText(ACCEPT)).toBeNull();
    clickFirstMark(container);
    expect(screen.getAllByLabelText(ACCEPT)).toHaveLength(1);
    expect(screen.getAllByLabelText(REJECT)).toHaveLength(1);
  });

  it('floats the action bar at the click point, not the end of the span', () => {
    const { container } = render(<Harness />);
    fireEvent.click(container.querySelectorAll('mark')[0], {
      clientX: 120,
      clientY: 40,
    });
    const bar = screen.getByLabelText(ACCEPT).closest('span[style]')!;
    expect(bar.getAttribute('style')).toContain('left: 124px');
    expect(bar.getAttribute('style')).toContain('top: 40px');
  });

  it('accepts and rejects from the pinned actions', () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    const { container } = render(
      <Harness onAccept={onAccept} onReject={onReject} />,
    );

    clickFirstMark(container);
    fireEvent.click(screen.getByLabelText(ACCEPT));
    expect(onAccept).toHaveBeenCalledWith('a');

    clickFirstMark(container);
    fireEvent.click(screen.getByLabelText(REJECT));
    expect(onReject).toHaveBeenCalledWith('a');
  });

  it('does not let a click on the bar reach the dismiss handler', () => {
    const { container } = render(<Harness resolveUnpins={false} />);
    clickFirstMark(container);
    fireEvent.click(screen.getByLabelText(ACCEPT));
    expect(screen.queryByLabelText(ACCEPT)).not.toBeNull();
  });

  it('dismisses the pin when the surrounding prose is clicked', () => {
    const { container } = render(<Harness />);
    clickFirstMark(container);
    fireEvent.click(container.firstElementChild!);
    expect(screen.queryByLabelText(ACCEPT)).toBeNull();
  });

  it('dismisses when the pinned span is clicked again', () => {
    const { container } = render(<Harness />);
    clickFirstMark(container);
    expect(screen.queryByLabelText(ACCEPT)).not.toBeNull();
    clickFirstMark(container);
    expect(screen.queryByLabelText(ACCEPT)).toBeNull();
  });
});
