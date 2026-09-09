/**
 * "What's new" panel.
 *
 * This surface hangs off the update banner, so the property that matters most
 * is that it cannot make updating worse: every failure path still puts a
 * working GitHub link in front of the user. Translations resolve to their key
 * names via the global next-intl mock, so copy assertions are on raw keys.
 *
 * `next/dynamic` is bypassed so the markdown stub renders synchronously — the
 * assertions here are about what the panel shows, not about the lazy chunk
 * boundary (which exists to keep Streamdown out of the app shell).
 */
import { render, screen, waitFor } from '@testing-library/react';

import { fetchReleaseNotes } from '@/client/services/releases/releasesClient';

import type { ReleaseNotesPayload } from '@/types/releases';

import { ReleaseNotesModal } from '@/components/App/ReleaseNotesModal';

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

vi.mock('@/client/services/releases/releasesClient', () => ({
  fetchReleaseNotes: vi.fn(),
}));

const fetchReleaseNotesMock = vi.mocked(fetchReleaseNotes);

const RELEASES_URL =
  'https://github.com/Medecins-Sans-Frontieres-Collaborate/ai-assistant-app/releases';

const RELEASE = {
  tag: 'v2026.08.31',
  name: 'v2026.08.31',
  publishedAt: '2026-08-31T20:00:25Z',
  url: `${RELEASES_URL}/tag/v2026.08.31`,
  body: "## What's Changed\n* Derives the viewer's public origin",
};

function payload(
  overrides: Partial<ReleaseNotesPayload> = {},
): ReleaseNotesPayload {
  return { releases: [RELEASE], releasesUrl: RELEASES_URL, ...overrides };
}

/** The link that must survive every failure mode. */
function githubLink() {
  return screen.getByRole('link', { name: /releaseNotes\.viewOnGithub/ });
}

beforeEach(() => {
  fetchReleaseNotesMock.mockReset();
  fetchReleaseNotesMock.mockResolvedValue(payload());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ReleaseNotesModal', () => {
  it('renders nothing and fetches nothing while closed', () => {
    render(<ReleaseNotesModal isOpen={false} onClose={vi.fn()} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fetchReleaseNotesMock).not.toHaveBeenCalled();
  });

  it('loads the notes when it opens', async () => {
    render(<ReleaseNotesModal isOpen onClose={vi.fn()} />);

    await waitFor(() => expect(fetchReleaseNotesMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('v2026.08.31')).toBeInTheDocument();
  });

  it('shows a loading line before the notes arrive', async () => {
    let resolve!: (value: ReleaseNotesPayload) => void;
    fetchReleaseNotesMock.mockReturnValue(
      new Promise<ReleaseNotesPayload>((r) => {
        resolve = r;
      }),
    );

    render(<ReleaseNotesModal isOpen onClose={vi.fn()} />);

    expect(screen.getByText('releaseNotes.loading')).toBeInTheDocument();
    resolve(payload());
    await waitFor(() =>
      expect(
        screen.queryByText('releaseNotes.loading'),
      ).not.toBeInTheDocument(),
    );
  });

  it('renders the release body through the markdown renderer', async () => {
    render(<ReleaseNotesModal isOpen onClose={vi.fn()} />);

    const body = await screen.findByTestId('markdown');
    expect(body).toHaveTextContent("Derives the viewer's public origin");
  });

  it('links the release title to its own GitHub page, in a new tab', async () => {
    render(<ReleaseNotesModal isOpen onClose={vi.fn()} />);

    const title = await screen.findByRole('link', { name: 'v2026.08.31' });
    expect(title).toHaveAttribute('href', RELEASE.url);
    // Release links must not navigate the chat away mid-conversation.
    expect(title).toHaveAttribute('target', '_blank');
    expect(title).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('shows the publish date', async () => {
    render(<ReleaseNotesModal isOpen onClose={vi.fn()} />);

    const time = await screen.findByText(
      new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(
        new Date(RELEASE.publishedAt),
      ),
    );
    expect(time).toHaveAttribute('dateTime', RELEASE.publishedAt);
  });

  it('always offers the GitHub link alongside the notes', async () => {
    render(<ReleaseNotesModal isOpen onClose={vi.fn()} />);

    await screen.findByText('v2026.08.31');
    expect(githubLink()).toHaveAttribute('href', RELEASES_URL);
  });

  it('falls back to a plain link when the notes are unavailable', async () => {
    fetchReleaseNotesMock.mockResolvedValue(
      payload({ releases: [], unavailable: true }),
    );

    render(<ReleaseNotesModal isOpen onClose={vi.fn()} />);

    expect(
      await screen.findByText('releaseNotes.unavailable'),
    ).toBeInTheDocument();
    expect(githubLink()).toHaveAttribute('href', RELEASES_URL);
  });

  it('keeps a working link even when the payload carried no URL', async () => {
    // Belt and braces: the escape hatch is the whole degraded experience.
    fetchReleaseNotesMock.mockResolvedValue({
      releases: [],
      releasesUrl: '',
      unavailable: true,
    });

    render(<ReleaseNotesModal isOpen onClose={vi.fn()} />);

    await screen.findByText('releaseNotes.unavailable');
    expect(githubLink()).toHaveAttribute('href', RELEASES_URL);
  });

  it('flags notes served from an expired cache', async () => {
    fetchReleaseNotesMock.mockResolvedValue(payload({ stale: true }));

    render(<ReleaseNotesModal isOpen onClose={vi.fn()} />);

    expect(await screen.findByText('releaseNotes.stale')).toBeInTheDocument();
  });

  it('does not flag fresh notes as stale', async () => {
    render(<ReleaseNotesModal isOpen onClose={vi.fn()} />);

    await screen.findByText('v2026.08.31');
    expect(screen.queryByText('releaseNotes.stale')).not.toBeInTheDocument();
  });

  it('explains a release that has no body rather than rendering a gap', async () => {
    fetchReleaseNotesMock.mockResolvedValue(
      payload({ releases: [{ ...RELEASE, body: '' }] }),
    );

    render(<ReleaseNotesModal isOpen onClose={vi.fn()} />);

    expect(
      await screen.findByText('releaseNotes.noDetails'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('markdown')).not.toBeInTheDocument();
  });

  it('omits the date line when GitHub gave no timestamp', async () => {
    fetchReleaseNotesMock.mockResolvedValue(
      payload({ releases: [{ ...RELEASE, publishedAt: '' }] }),
    );

    const { container } = render(
      <ReleaseNotesModal isOpen onClose={vi.fn()} />,
    );

    await screen.findByText('v2026.08.31');
    expect(container.ownerDocument.querySelector('time')).toBeNull();
  });

  it('says the notes are English so non-English users are not left guessing', async () => {
    // GitHub notes are English-only; the chrome around them is translated.
    render(<ReleaseNotesModal isOpen onClose={vi.fn()} />);

    expect(
      await screen.findByText('releaseNotes.englishOnly'),
    ).toBeInTheDocument();
  });

  it('closes on the close button', async () => {
    const onClose = vi.fn();
    render(<ReleaseNotesModal isOpen onClose={onClose} />);

    await screen.findByText('v2026.08.31');
    await userEvent.click(screen.getByRole('button', { name: /close/i }));

    expect(onClose).toHaveBeenCalled();
  });

  it('aborts the in-flight request when it closes', async () => {
    let capturedSignal: AbortSignal | undefined;
    fetchReleaseNotesMock.mockImplementation(async (options) => {
      capturedSignal = options?.signal;
      return payload();
    });

    const { rerender } = render(<ReleaseNotesModal isOpen onClose={vi.fn()} />);
    await waitFor(() => expect(capturedSignal).toBeDefined());
    expect(capturedSignal?.aborted).toBe(false);

    rerender(<ReleaseNotesModal isOpen={false} onClose={vi.fn()} />);

    expect(capturedSignal?.aborted).toBe(true);
  });

  it('refetches on reopen so a long-lived tab is not stuck on old notes', async () => {
    const { rerender } = render(<ReleaseNotesModal isOpen onClose={vi.fn()} />);
    await waitFor(() => expect(fetchReleaseNotesMock).toHaveBeenCalledTimes(1));

    rerender(<ReleaseNotesModal isOpen={false} onClose={vi.fn()} />);
    rerender(<ReleaseNotesModal isOpen onClose={vi.fn()} />);

    await waitFor(() => expect(fetchReleaseNotesMock).toHaveBeenCalledTimes(2));
  });

  it('survives an abort rejection without surfacing an error', async () => {
    // The client rethrows aborts; the modal must swallow them silently.
    fetchReleaseNotesMock.mockRejectedValue(
      new DOMException('The operation was aborted.', 'AbortError'),
    );

    render(<ReleaseNotesModal isOpen onClose={vi.fn()} />);

    await waitFor(() =>
      expect(
        screen.queryByText('releaseNotes.loading'),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText('releaseNotes.unavailable')).toBeInTheDocument();
    expect(githubLink()).toHaveAttribute('href', RELEASES_URL);
  });

  it('renders every release it is given', async () => {
    fetchReleaseNotesMock.mockResolvedValue(
      payload({
        releases: [
          RELEASE,
          { ...RELEASE, tag: 'v2026.08.27', name: 'v2026.08.27' },
          { ...RELEASE, tag: 'v2026.08.25', name: 'v2026.08.25' },
        ],
      }),
    );

    render(<ReleaseNotesModal isOpen onClose={vi.fn()} />);

    await screen.findByText('v2026.08.31');
    expect(screen.getByText('v2026.08.27')).toBeInTheDocument();
    expect(screen.getByText('v2026.08.25')).toBeInTheDocument();
  });
});
