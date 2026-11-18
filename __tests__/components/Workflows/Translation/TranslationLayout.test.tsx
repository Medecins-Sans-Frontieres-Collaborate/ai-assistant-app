import { act, render, screen } from '@testing-library/react';

import { useElementWidth } from '@/client/hooks/ui/useElementWidth';

import { InlineWordDiff } from '@/components/Workflows/Shared/Review/InlineWordDiff';
import { DocumentDownloadMenu } from '@/components/Workflows/Translation/DocumentDownloadMenu';
import { GlossaryPicker } from '@/components/Workflows/Translation/GlossaryPicker';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string) => key,
}));

describe('glossary picker placement', () => {
  it('opens below its button: the toolbar is at the top and clips what rises above', () => {
    render(
      <GlossaryPicker
        orgGlossaries={[]}
        personalGlossaries={[]}
        selectedOrgIds={[]}
        selectedPersonalIds={[]}
        staleOrgIds={[]}
        stalePersonalIds={[]}
        onToggleOrg={vi.fn()}
        onTogglePersonal={vi.fn()}
        onCopyToMine={vi.fn()}
        onManage={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const classes = screen.getByRole('dialog').className;
    expect(classes).toContain('top-full');
    expect(classes).not.toContain('bottom-full');
  });
});

describe('inline diff spacing', () => {
  it('separates a removed word from its replacement, and only then', () => {
    const replaced = render(
      <InlineWordDiff before="1 tableta." after="1 gragea." />,
    );
    const replacedWord = replaced.container.querySelector('del')!;
    expect(replacedWord.nextElementSibling?.tagName).toBe('INS');
    expect(replacedWord.className).toContain('me-1');
    replaced.unmount();

    // A word removed with nothing put in its place needs no gap.
    const dropped = render(
      <InlineWordDiff before="uno dos tres" after="uno tres" />,
    );
    const droppedWord = dropped.container.querySelector('del')!;
    expect(droppedWord.nextElementSibling?.tagName).not.toBe('INS');
    expect(droppedWord.className).not.toContain('me-1');
  });
});

describe('download menu', () => {
  it('wraps its own text even inside a header that does not wrap', () => {
    render(
      <div className="whitespace-nowrap">
        <DocumentDownloadMenu
          job={{
            jobId: 'job',
            status: 'ready',
            submittedAt: '2026-11-14T10:00:00.000Z',
            sourceName: 'a.pdf',
            translatedFilename: 'a_es.pdf',
            fileExtension: 'pdf',
            targetLanguage: 'es',
            page: 1,
          }}
        />
      </div>,
    );
    act(() => screen.getByRole('button').click());
    expect(screen.getByRole('menu').className).toContain('whitespace-normal');
  });
});

describe('useElementWidth', () => {
  const observers: Array<(width: number) => void> = [];
  afterEach(() => {
    observers.length = 0;
    vi.unstubAllGlobals();
  });

  function Probe() {
    const { ref, width } = useElementWidth<HTMLDivElement>(900);
    return <div ref={ref}>width {width}</div>;
  }

  it('reports the fallback where sizes cannot be observed', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    render(<Probe />);
    expect(screen.getByText('width 900')).toBeInTheDocument();
  });

  it('follows the observed width and ignores a hidden element measuring zero', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: (entries: unknown[]) => void) {
          observers.push((width) => callback([{ contentRect: { width } }]));
        }
        observe() {}
        disconnect() {}
      },
    );
    render(<Probe />);
    act(() => observers[0](412.4));
    expect(screen.getByText('width 412')).toBeInTheDocument();
    act(() => observers[0](0));
    expect(screen.getByText('width 412')).toBeInTheDocument();
  });
});
