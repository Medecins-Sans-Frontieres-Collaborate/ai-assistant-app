/**
 * Update banner, and the "what changed?" detour added beside its Refresh
 * button.
 *
 * The banner's job is to get people onto the new build; the release notes are
 * strictly optional. So the tests below pin that the notes panel is opt-in
 * (nothing is fetched until it is asked for) and that adding it left the
 * refresh and dismiss paths alone.
 */
import { render, screen, waitFor } from '@testing-library/react';

import { fetchReleaseNotes } from '@/client/services/releases/releasesClient';

import { UpdateBanner } from '@/components/App/UpdateBanner';

import '@testing-library/jest-dom';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/dynamic', () => ({
  default: () => {
    const Stub = (props: Record<string, unknown>) => (
      <div data-testid="markdown">{String(props.children ?? '')}</div>
    );
    return Stub;
  },
}));

const dismissMock = vi.hoisted(() => vi.fn());
const versionCheckMock = vi.hoisted(() => vi.fn());

vi.mock('@/client/hooks/app/useVersionCheck', () => ({
  useVersionCheck: versionCheckMock,
}));
vi.mock('@/client/hooks/ui/useUI', () => ({
  useUI: () => ({ showChatbar: true }),
}));
vi.mock('@/client/services/releases/releasesClient', () => ({
  fetchReleaseNotes: vi.fn(),
}));

const fetchReleaseNotesMock = vi.mocked(fetchReleaseNotes);

const RELEASES_URL =
  'https://github.com/Medecins-Sans-Frontieres-Collaborate/ai-assistant-app/releases';

let mockReload: ReturnType<typeof vi.fn>;
let originalLocation: typeof window.location;

beforeEach(() => {
  versionCheckMock.mockReturnValue({
    isUpdateAvailable: true,
    dismiss: dismissMock,
  });
  fetchReleaseNotesMock.mockReset();
  fetchReleaseNotesMock.mockResolvedValue({
    releases: [
      {
        tag: 'v2026.08.31',
        name: 'v2026.08.31',
        publishedAt: '2026-08-31T20:00:25Z',
        url: `${RELEASES_URL}/tag/v2026.08.31`,
        body: '* Something changed',
      },
    ],
    releasesUrl: RELEASES_URL,
  });

  mockReload = vi.fn();
  originalLocation = window.location;
  delete (window as any).location;
  window.location = { ...originalLocation, reload: mockReload } as any;
});

afterEach(() => {
  window.location = originalLocation as any;
  vi.clearAllMocks();
});

describe('UpdateBanner', () => {
  it('renders nothing when no update is available', () => {
    versionCheckMock.mockReturnValue({
      isUpdateAvailable: false,
      dismiss: dismissMock,
    });

    render(<UpdateBanner />);

    expect(screen.queryByText('updateBanner.title')).not.toBeInTheDocument();
  });

  it('still offers refresh as the primary action', async () => {
    render(<UpdateBanner />);

    await userEvent.click(
      screen.getByRole('button', { name: /updateBanner\.refresh/ }),
    );

    expect(mockReload).toHaveBeenCalledTimes(1);
  });

  it('still dismisses', async () => {
    render(<UpdateBanner />);

    await userEvent.click(
      screen.getByRole('button', { name: 'common.dismissBanner' }),
    );

    expect(dismissMock).toHaveBeenCalledTimes(1);
  });

  it('does not fetch release notes until they are asked for', () => {
    // Every signed-in tab mounts this banner; an eager fetch here would be a
    // request per user rather than a request per curious user.
    render(<UpdateBanner />);

    expect(fetchReleaseNotesMock).not.toHaveBeenCalled();
  });

  it('opens the notes panel from the banner', async () => {
    render(<UpdateBanner />);

    await userEvent.click(
      screen.getByRole('button', { name: 'releaseNotes.whatChanged' }),
    );

    await waitFor(() => expect(fetchReleaseNotesMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('v2026.08.31')).toBeInTheDocument();
  });

  it('leaves the banner in place while the notes are open', async () => {
    // Reading the notes must not cost the user their way to update.
    render(<UpdateBanner />);

    await userEvent.click(
      screen.getByRole('button', { name: 'releaseNotes.whatChanged' }),
    );
    await screen.findByText('v2026.08.31');

    expect(
      screen.getByRole('button', { name: /updateBanner\.refresh/ }),
    ).toBeInTheDocument();
  });
});
