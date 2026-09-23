import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { AnnouncementAppMessage } from '@/types/appMessages';

import { BannerHost } from '@/components/App/BannerHost';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const messagesMock = vi.hoisted(() => vi.fn());

vi.mock('@/client/hooks/app/useAppMessages', () => ({
  useAppMessages: messagesMock,
}));
vi.mock('@/client/hooks/ui/useUI', () => ({
  useUI: () => ({ showChatbar: true }),
}));
vi.mock('@/components/App/ReleaseNotesModal', () => ({
  ReleaseNotesModal: () => null,
}));

function announcement(
  extra: Partial<AnnouncementAppMessage> = {},
): AnnouncementAppMessage {
  return {
    kind: 'announcement',
    id: 'ann-000000000001',
    revision: 1,
    severity: 'info',
    dismissible: true,
    title: 'Maintenance tonight',
    body: 'Expect interruptions.',
    variables: [],
    endsAt: '2999-01-01T00:00:00.000Z',
    ...extra,
  };
}

function queue(
  announcements: AnnouncementAppMessage[],
  isUpdateAvailable = false,
) {
  messagesMock.mockReturnValue({
    isUpdateAvailable,
    dismissUpdate: vi.fn(),
    announcements,
  });
}

describe('BannerHost', () => {
  beforeEach(() => {
    window.localStorage.clear();
    messagesMock.mockReset();
  });

  it('renders nothing when nothing is queued', () => {
    queue([]);
    const { container } = render(<BannerHost />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the refresh reminder first, holding announcements back', () => {
    queue([announcement()], true);
    render(<BannerHost />);
    expect(screen.queryByText('Maintenance tonight')).not.toBeInTheDocument();
  });

  it('shows ONE announcement at a time with a stepper, in the order the server ranked them', () => {
    queue([
      announcement({ id: 'ann-00000000000a', title: 'First' }),
      announcement({ id: 'ann-00000000000b', title: 'Second' }),
    ]);
    render(<BannerHost />);
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.queryByText('Second')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'next' }));
    expect(screen.getByText('Second')).toBeInTheDocument();
  });

  it('remembers a dismissal per browser, keyed by revision — "notify again" re-shows it', () => {
    queue([announcement()]);
    const first = render(<BannerHost />);
    fireEvent.click(screen.getByRole('button', { name: 'dismissBanner' }));
    expect(screen.queryByText('Maintenance tonight')).not.toBeInTheDocument();
    first.unmount();

    // A later visit: still dismissed.
    queue([announcement()]);
    const second = render(<BannerHost />);
    expect(screen.queryByText('Maintenance tonight')).not.toBeInTheDocument();
    second.unmount();

    // The admin ticked "show again": a new revision is a new message.
    queue([announcement({ revision: 2 })]);
    render(<BannerHost />);
    expect(screen.getByText('Maintenance tonight')).toBeInTheDocument();
  });

  it('dismissal records expire with the announcement', () => {
    window.localStorage.setItem(
      'announcement-dismissals',
      JSON.stringify({
        'ann-000000000001:1': '2000-01-01T00:00:00.000Z',
        'ann-000000000002:1': '2999-01-01T00:00:00.000Z',
      }),
    );
    queue([announcement()]);
    render(<BannerHost />);
    // The expired record no longer hides anything…
    expect(screen.getByText('Maintenance tonight')).toBeInTheDocument();

    // …and is dropped by the next write, so the store cannot grow unbounded.
    fireEvent.click(screen.getByRole('button', { name: 'dismissBanner' }));
    expect(
      JSON.parse(window.localStorage.getItem('announcement-dismissals')!),
    ).toEqual({
      'ann-000000000001:1': '2999-01-01T00:00:00.000Z',
      'ann-000000000002:1': '2999-01-01T00:00:00.000Z',
    });
  });

  it('a non-dismissible announcement has no close button, ignores stored dismissals, and can be minimised', () => {
    window.localStorage.setItem(
      'announcement-dismissals',
      JSON.stringify({ 'ann-000000000001:1': '2999-01-01T00:00:00.000Z' }),
    );
    queue([announcement({ dismissible: false, severity: 'critical' })]);
    render(<BannerHost />);

    expect(screen.getByText('Maintenance tonight')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'dismissBanner' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'minimise' }));
    expect(screen.queryByText('Expect interruptions.')).not.toBeInTheDocument();
    expect(screen.getByText('Maintenance tonight')).toBeInTheDocument();
  });

  it('shows who a delegated announcement is from, and a link only as a labelled button', () => {
    queue([
      announcement({
        from: 'OCP field IT',
        action: { label: 'Read more', url: 'https://intranet.example.org/x' },
      }),
    ]);
    render(<BannerHost />);

    expect(screen.getByText('OCP field IT')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Read more' });
    expect(link).toHaveAttribute('href', 'https://intranet.example.org/x');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(
      screen.queryByText(/intranet\.example\.org/),
    ).not.toBeInTheDocument();
  });

  it('renders time variables instead of raw placeholders', () => {
    queue([
      announcement({
        body: 'Down {window}.',
        variables: [
          {
            name: 'window',
            type: 'timeRange',
            from: '2026-10-12T14:00:00.000Z',
            to: '2026-10-12T18:00:00.000Z',
          },
        ],
      }),
    ]);
    render(<BannerHost />);
    expect(screen.queryByText(/\{window\}/)).not.toBeInTheDocument();
    expect(screen.getByText(/UTC/)).toBeInTheDocument();
  });
});
