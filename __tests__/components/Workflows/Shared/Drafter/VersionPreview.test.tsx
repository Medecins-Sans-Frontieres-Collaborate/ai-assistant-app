import { fireEvent, render, screen } from '@testing-library/react';

import { buildChannelPreview } from '@/lib/utils/shared/drafter/channels/channelPreview';
import { getChannelProfile } from '@/lib/utils/shared/drafter/channels/channelProfiles';

import { VersionPreview } from '@/components/Workflows/Shared/Drafter/VersionPreview';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

const linkedin = getChannelProfile('linkedin')!;
const x = getChannelProfile('x')!;
const TEXT =
  'The opening line.\n\nBehind the fold: https://www.example.org/reports/2026 #WaterCrisis';

// The jsdom i18n mock has no workflows namespace: labels render as raw keys.
function renderPreview(onEditAt = vi.fn()) {
  render(
    <VersionPreview
      name="LinkedIn"
      namespace="workflows.channelDrafter"
      segments={buildChannelPreview(linkedin, [
        { id: 's1', text: TEXT, usedItemIds: [] },
      ])}
      onEditAt={onEditAt}
    />,
  );
  return onEditAt;
}

describe('VersionPreview', () => {
  it('says it is approximate and names the channel in words', () => {
    renderPreview();
    expect(screen.getByText('previewApproximate')).toBeInTheDocument();
    expect(screen.getByText('LinkedIn')).toBeInTheDocument();
  });

  it('hides what is behind the fold until "see more" is pressed', () => {
    renderPreview();
    expect(screen.getByText('The opening line.')).toBeInTheDocument();
    expect(screen.queryByText('#WaterCrisis')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'slots.seeMore' }));
    expect(screen.getByText('#WaterCrisis')).toBeInTheDocument();
    // A link is shown the way a platform shows it, not as it was typed.
    expect(screen.getByText('example.org/reports/2026')).toBeInTheDocument();
    expect(screen.queryByText(/https:\/\//u)).not.toBeInTheDocument();
  });

  it('goes back to the editor at the word that was pressed', () => {
    const onEditAt = renderPreview();
    fireEvent.click(screen.getByRole('button', { name: 'slots.seeMore' }));
    fireEvent.click(screen.getByText('#WaterCrisis'));
    expect(onEditAt).toHaveBeenCalledWith('s1', TEXT.indexOf('#WaterCrisis'));
  });

  it('shows a thread as numbered posts and carries an over-limit verdict', () => {
    render(
      <VersionPreview
        name="X"
        namespace="workflows.channelDrafter"
        segments={buildChannelPreview(x, [
          { id: 'a', text: 'a'.repeat(300), usedItemIds: [] },
          { id: 'b', text: 'Second post.', usedItemIds: [] },
        ])}
        onEditAt={vi.fn()}
      />,
    );
    expect(screen.getAllByText('X')).toHaveLength(2);
    expect(screen.getByText('1/2')).toBeInTheDocument();
    expect(screen.getByText('previewOver')).toBeInTheDocument();
    // No fold on this channel, so there is no "see more".
    expect(
      screen.queryByRole('button', { name: 'slots.seeMore' }),
    ).not.toBeInTheDocument();
  });
});
