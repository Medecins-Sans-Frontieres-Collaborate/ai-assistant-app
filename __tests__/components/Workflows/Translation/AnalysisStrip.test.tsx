import { fireEvent, render, screen } from '@testing-library/react';

import { ANALYSIS_STRIP_HEIGHT } from '@/lib/utils/shared/translation/runProgress';

import { AnalysisStrip } from '@/components/Workflows/Translation/AnalysisStrip';

import '@testing-library/jest-dom';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// The jsdom i18n mock has no workflows namespace: labels render as raw keys.
const analysis = {
  register: 'clinical',
  trickyTerms: [{ term: 'PO', issue: 'abbreviation', suggestion: 'VO' }],
  ambiguities: [],
  notes: '',
};
const START_HEIGHT = 224;
const STEP = ANALYSIS_STRIP_HEIGHT.keyboardStep;

function renderStrip(overrides: Record<string, unknown> = {}) {
  const handlers = {
    onToggleExpanded: vi.fn(),
    onDismiss: vi.fn(),
    onResize: vi.fn(),
  };
  render(
    <AnalysisStrip
      analysis={analysis}
      rounds={[{ round: 1, verdict: 'approve', issues: [] }]}
      expanded
      height={START_HEIGHT}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

beforeAll(() => {
  // jsdom does not implement pointer capture.
  Element.prototype.setPointerCapture = vi.fn();
});

describe('AnalysisStrip', () => {
  it('renders nothing when the run left no paper trail', () => {
    const { container } = render(
      <AnalysisStrip
        rounds={[]}
        expanded
        height={START_HEIGHT}
        onToggleExpanded={vi.fn()}
        onDismiss={vi.fn()}
        onResize={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows only the header when collapsed', () => {
    renderStrip({ expanded: false });
    expect(screen.getByText('translation.analysisNotes')).toBeInTheDocument();
    expect(screen.getByText('translation.reviewSummary')).toBeInTheDocument();
    expect(screen.queryByText(/PO/)).not.toBeInTheDocument();
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
  });

  it('shows the analysis and a resize handle when expanded', () => {
    renderStrip();
    expect(screen.getByText('PO')).toBeInTheDocument();
    expect(screen.getByRole('separator')).toHaveAttribute(
      'aria-valuenow',
      String(START_HEIGHT),
    );
  });

  it('toggles from the header and dismisses from the close button', () => {
    const handlers = renderStrip();
    fireEvent.click(screen.getByRole('button', { expanded: true }));
    expect(handlers.onToggleExpanded).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole('button', { name: 'translation.analysisDismiss' }),
    );
    expect(handlers.onDismiss).toHaveBeenCalledTimes(1);
  });

  describe('resizing follows the direction convention (up grows)', () => {
    it('grows with ArrowUp and shrinks with ArrowDown', () => {
      const handlers = renderStrip();
      const handle = screen.getByRole('separator');
      fireEvent.keyDown(handle, { key: 'ArrowUp' });
      expect(handlers.onResize).toHaveBeenLastCalledWith(START_HEIGHT + STEP);
      fireEvent.keyDown(handle, { key: 'ArrowDown' });
      expect(handlers.onResize).toHaveBeenLastCalledWith(START_HEIGHT - STEP);
    });

    it('jumps to the bounds with Home and End and ignores other keys', () => {
      const handlers = renderStrip();
      const handle = screen.getByRole('separator');
      fireEvent.keyDown(handle, { key: 'Home' });
      expect(handlers.onResize).toHaveBeenLastCalledWith(
        ANALYSIS_STRIP_HEIGHT.min,
      );
      fireEvent.keyDown(handle, { key: 'End' });
      expect(handlers.onResize).toHaveBeenLastCalledWith(
        ANALYSIS_STRIP_HEIGHT.max,
      );
      handlers.onResize.mockClear();
      fireEvent.keyDown(handle, { key: 'a' });
      expect(handlers.onResize).not.toHaveBeenCalled();
    });

    it('does not step past a bound', () => {
      const handlers = renderStrip({ height: ANALYSIS_STRIP_HEIGHT.max });
      fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowUp' });
      expect(handlers.onResize).toHaveBeenLastCalledWith(
        ANALYSIS_STRIP_HEIGHT.max,
      );
    });

    it('grows when dragged up and reports once, on release', () => {
      const handlers = renderStrip();
      const handle = screen.getByRole('separator');
      fireEvent.pointerDown(handle, { pointerId: 1, clientY: 500 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientY: 460 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientY: 440 });
      expect(handlers.onResize).not.toHaveBeenCalled();
      expect(handle).toHaveAttribute(
        'aria-valuenow',
        String(START_HEIGHT + 60),
      );
      fireEvent.pointerUp(handle, { pointerId: 1, clientY: 440 });
      expect(handlers.onResize).toHaveBeenCalledTimes(1);
      expect(handlers.onResize).toHaveBeenCalledWith(START_HEIGHT + 60);
    });

    it('shrinks when dragged down and stops at the minimum', () => {
      const handlers = renderStrip();
      const handle = screen.getByRole('separator');
      fireEvent.pointerDown(handle, { pointerId: 1, clientY: 500 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientY: 2000 });
      fireEvent.pointerUp(handle, { pointerId: 1, clientY: 2000 });
      expect(handlers.onResize).toHaveBeenCalledWith(ANALYSIS_STRIP_HEIGHT.min);
    });

    it('ignores pointer movement that is not part of a drag', () => {
      const handlers = renderStrip();
      const handle = screen.getByRole('separator');
      fireEvent.pointerMove(handle, { pointerId: 1, clientY: 100 });
      fireEvent.pointerUp(handle, { pointerId: 1, clientY: 100 });
      expect(handlers.onResize).not.toHaveBeenCalled();
    });
  });
});
