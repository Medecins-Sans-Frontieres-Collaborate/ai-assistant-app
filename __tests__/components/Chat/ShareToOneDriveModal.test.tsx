import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

import { M365ClientError } from '@/client/services/m365/m365Client';

import type { Conversation } from '@/types/chat';

import ShareToOneDriveModal from '@/components/Chat/ShareToOneDriveModal';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  saveToOneDrive: vi.fn<() => Promise<unknown>>(),
  shareDriveItem: vi.fn<() => Promise<unknown>>(),
  buildBlob: vi.fn<() => Promise<Blob>>(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('@/client/services/m365/m365Client', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/client/services/m365/m365Client')>();
  return {
    ...actual,
    saveToOneDrive: mocks.saveToOneDrive,
    shareDriveItem: mocks.shareDriveItem,
  };
});

// buildBlob's docx path calls a conversion endpoint; the modal only needs
// A blob back.
vi.mock('@/client/hooks/document/useM365Save', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/client/hooks/document/useM365Save')
    >();
  return { ...actual, buildBlob: mocks.buildBlob };
});

vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  }),
}));

function conversation(): Conversation {
  return {
    id: 'c1',
    name: 'Field visit notes',
    messages: [
      { role: 'user', content: 'What did we find?' },
      { role: 'assistant', content: 'Finding one.' },
      { role: 'user', content: 'And then?' },
      { role: 'assistant', content: 'Finding two.' },
    ],
  } as Conversation;
}

function lastMarkdown(): string {
  const call = mocks.buildBlob.mock.calls.at(-1) as unknown[];
  return call[2] as string;
}

describe('ShareToOneDriveModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildBlob.mockResolvedValue(new Blob(['doc']));
    mocks.saveToOneDrive.mockResolvedValue({
      name: 'Field visit notes.docx',
      webUrl: 'https://onedrive.example/file',
      itemId: 'item-1',
      driveId: 'drive-1',
    });
    mocks.shareDriveItem.mockResolvedValue({
      link: 'https://share.example/l',
      scope: 'organization',
    });
  });

  it('keeps the simple case simple: filters live behind a collapsed Customize', () => {
    render(
      <ShareToOneDriveModal
        isOpen
        onClose={vi.fn()}
        conversation={conversation()}
      />,
    );
    expect(screen.getByText(/introConversation/)).toBeInTheDocument();
    expect(screen.queryByText('assistantOnly')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('customize'));
    expect(screen.getByText('assistantOnly')).toBeInTheDocument();
  });

  it('default share: whole conversation → org view link, then copyable link', async () => {
    render(
      <ShareToOneDriveModal
        isOpen
        onClose={vi.fn()}
        conversation={conversation()}
      />,
    );

    fireEvent.click(screen.getByText('shareAction'));

    await waitFor(() =>
      expect(screen.getByText('sharedAsLink')).toBeInTheDocument(),
    );
    expect(mocks.saveToOneDrive).toHaveBeenCalledWith(
      expect.any(Blob),
      'Field visit notes.docx',
    );
    expect(mocks.shareDriveItem).toHaveBeenCalledWith(
      'drive-1',
      'item-1',
      undefined,
    );
    const markdown = lastMarkdown();
    expect(markdown).toContain('# Field visit notes');
    expect(markdown).toContain('What did we find?');
    expect(markdown).toContain('Finding two.');
    expect(
      screen.getByDisplayValue('https://share.example/l'),
    ).toBeInTheDocument();
  });

  it('applies assistant-only + last-N filters to the rendered document', async () => {
    render(
      <ShareToOneDriveModal
        isOpen
        onClose={vi.fn()}
        conversation={conversation()}
      />,
    );

    fireEvent.click(screen.getByText('customize'));
    fireEvent.click(screen.getByText('assistantOnly'));
    fireEvent.click(screen.getByText(/lastMessagesPre/));
    fireEvent.change(screen.getByRole('spinbutton'), {
      target: { value: '1' },
    });
    fireEvent.click(screen.getByText('shareAction'));

    await waitFor(() => expect(mocks.buildBlob).toHaveBeenCalled());
    const markdown = lastMarkdown();
    expect(markdown).toContain('Finding two.');
    expect(markdown).not.toContain('Finding one.');
    expect(markdown).not.toContain('What did we find?');
  });

  it('shares with specific people when emails are given; rejects garbage', async () => {
    mocks.shareDriveItem.mockResolvedValue({ scope: 'people', granted: 2 });
    render(
      <ShareToOneDriveModal
        isOpen
        onClose={vi.fn()}
        conversation={conversation()}
      />,
    );

    fireEvent.click(screen.getByText('customize'));
    const input = screen.getByPlaceholderText('recipientsPlaceholder');

    fireEvent.change(input, { target: { value: 'not-an-email' } });
    fireEvent.click(screen.getByText('shareAction'));
    expect(await screen.findByText('invalidRecipients')).toBeInTheDocument();
    expect(mocks.saveToOneDrive).not.toHaveBeenCalled();

    fireEvent.change(input, {
      target: { value: 'ana@msf.org, bo@msf.org' },
    });
    fireEvent.click(screen.getByText('shareAction'));

    await waitFor(() =>
      expect(mocks.shareDriveItem).toHaveBeenCalledWith('drive-1', 'item-1', [
        'ana@msf.org',
        'bo@msf.org',
      ]),
    );
    await waitFor(() =>
      expect(screen.getByText('sharedWithPeople')).toBeInTheDocument(),
    );
  });

  it('message scope hides filters and shares the single response as prose', async () => {
    render(
      <ShareToOneDriveModal
        isOpen
        onClose={vi.fn()}
        conversation={conversation()}
        messageContent="Just this answer."
      />,
    );

    fireEvent.click(screen.getByText('customize'));
    expect(screen.queryByText('assistantOnly')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('shareAction'));
    await waitFor(() => expect(mocks.buildBlob).toHaveBeenCalled());
    const markdown = lastMarkdown();
    expect(markdown).toContain('Just this answer.');
    expect(markdown).not.toContain('roleAssistant');
  });

  it('maps a policy rejection to its dedicated message and creates nothing further', async () => {
    mocks.shareDriveItem.mockRejectedValue(
      new M365ClientError('blocked', 'M365_FORBIDDEN'),
    );
    render(
      <ShareToOneDriveModal
        isOpen
        onClose={vi.fn()}
        conversation={conversation()}
      />,
    );

    fireEvent.click(screen.getByText('shareAction'));

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('blockedByPolicy'),
    );
    expect(screen.queryByText('sharedAsLink')).not.toBeInTheDocument();
  });
});
