import {
  PANES_SIDE_BY_SIDE_MIN_WIDTH,
  REVIEW_BESIDE_MIN_WIDTH,
  workspaceLayout,
} from '@/lib/utils/shared/translation/workspaceLayout';

import { describe, expect, it } from 'vitest';

describe('workspaceLayout', () => {
  it('puts the review beside the panes from its minimum width, and below one pixel under', () => {
    expect(workspaceLayout(REVIEW_BESIDE_MIN_WIDTH).reviewBeside).toBe(true);
    expect(workspaceLayout(REVIEW_BESIDE_MIN_WIDTH - 1).reviewBeside).toBe(
      false,
    );
  });

  it('puts the panes side by side from their minimum width, and stacks them one pixel under', () => {
    expect(workspaceLayout(PANES_SIDE_BY_SIDE_MIN_WIDTH).panesSideBySide).toBe(
      true,
    );
    expect(
      workspaceLayout(PANES_SIDE_BY_SIDE_MIN_WIDTH - 1).panesSideBySide,
    ).toBe(false);
  });

  it('never puts the review beside panes that are themselves stacked', () => {
    // The thresholds must stay ordered, or a mid width would do exactly that.
    expect(REVIEW_BESIDE_MIN_WIDTH).toBeGreaterThan(
      PANES_SIDE_BY_SIDE_MIN_WIDTH,
    );
    for (const width of [0, 300, 559, 560, 700, 819, 820, 1600]) {
      const layout = workspaceLayout(width);
      expect(layout.reviewBeside && !layout.panesSideBySide).toBe(false);
    }
  });
});
