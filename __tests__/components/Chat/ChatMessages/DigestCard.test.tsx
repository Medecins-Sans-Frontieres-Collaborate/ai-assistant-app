import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { fetchDigestJob } from '@/client/services/m365/m365Client';

import type { CommsDigest, DigestMessageState } from '@/types/m365Digest';

import { DigestCard } from '@/components/Chat/ChatMessages/DigestCard';

import { useConversationStore } from '@/client/stores/conversationStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateConversation = vi.hoisted(() => vi.fn());
const conversations = vi.hoisted(() => ({ list: [] as unknown[] }));

vi.mock('@/client/hooks/conversation/useConversations', () => ({
  useConversations: () => ({
    conversations: conversations.list,
    updateConversation,
  }),
}));
vi.mock('@/client/services/m365/m365Client', () => ({
  M365ClientError: class M365ClientError extends Error {
    constructor(
      message: string,
      readonly code?: string,
    ) {
      super(message);
    }
  },
  fetchDigestJob: vi.fn(),
  deleteDigestJob: vi.fn().mockResolvedValue(undefined),
  createTodoTasks: vi.fn(),
}));

const request: DigestMessageState['request'] = {
  window: {
    startIso: '2026-10-23T00:00:00.000Z',
    endIso: '2026-10-30T09:00:00.000Z',
    preset: '7d',
  },
  sources: ['mail', 'chat'],
  channels: [],
};

const digest: CommsDigest = {
  version: 1,
  jobId: 'job-1',
  generatedAt: '2026-10-30T09:00:00.000Z',
  window: request.window,
  channels: [],
  sources: [
    { kind: 'mail', status: 'ok', scanned: 42 },
    {
      kind: 'chat',
      status: 'unavailable',
      scanned: 0,
      note: 'Permission missing',
    },
  ],
  items: [
    {
      id: 'mail:1',
      source: 'mail',
      category: 'needsReply',
      title: 'Budget review',
      from: 'Ana',
      whenIso: '2026-10-29T10:00:00.000Z',
      preview: 'Could you have a look?',
      reason: 'addressed to you, no reply sent',
      signals: {
        unanswered: true,
        mentionsMe: true,
        waitingOnOthers: false,
        broadcast: false,
        invitation: false,
        important: false,
        ageHours: 23,
      },
      webLink: 'https://outlook.office.com/mail/deeplink/read/1',
      ref: { messageId: '1' },
    },
    {
      id: 'mail:2',
      source: 'mail',
      category: 'companyUpdates',
      title: 'Project Atlas weekly',
      from: 'Comms',
      whenIso: '2026-10-28T10:00:00.000Z',
      preview: '',
      reason: 'sent to many people',
      signals: {
        unanswered: false,
        mentionsMe: false,
        waitingOnOthers: false,
        broadcast: true,
        invitation: false,
        important: false,
        ageHours: 47,
      },
      ref: { messageId: '2' },
    },
  ],
  actionItems: [
    {
      id: 'action:mail:1',
      title: 'Reply to Ana about the budget',
      sourceItemId: 'mail:1',
      askedBy: 'Ana',
    },
  ],
  themes: [],
  counts: {
    needsReply: 1,
    askedOfMe: 0,
    waitingOnOthers: 0,
    scheduling: 0,
    companyUpdates: 1,
    fyi: 0,
    bulk: 0,
  },
  withheldCount: 0,
  degraded: false,
  markdown: '## Daily digest',
};

beforeEach(() => {
  vi.clearAllMocks();
  conversations.list = [];
  useConversationStore.setState({ conversations: [] });
});

describe('DigestCard', () => {
  it('polls a pending job and writes the result into the message', async () => {
    const state: DigestMessageState = {
      jobId: 'job-1',
      status: 'pending',
      request,
    };
    conversations.list = [
      {
        id: 'conv-1',
        messages: [
          {
            type: 'assistant_group',
            activeIndex: 0,
            versions: [
              {
                content: 'working',
                messageType: 'TEXT',
                createdAt: 'x',
                digest: state,
              },
            ],
          },
        ],
      },
    ];
    useConversationStore.setState({
      conversations: conversations.list as never,
    });
    vi.mocked(fetchDigestJob).mockResolvedValue({
      jobId: 'job-1',
      status: 'succeeded',
      progress: { stage: 'done', sources: [] },
      result: digest,
    });
    render(<DigestCard state={state} conversationId="conv-1" />);
    expect(screen.getByRole('status')).toHaveTextContent(/Scanning/);
    await waitFor(() => expect(updateConversation).toHaveBeenCalled());
    const [, updates] = updateConversation.mock.calls[0];
    const version = updates.messages[0].versions[0];
    expect(version.digest.status).toBe('succeeded');
    expect(version.content).toBe('## Daily digest');
  });

  it('renders categories, signals, source problems and action items from the result', () => {
    render(
      <DigestCard
        state={{ jobId: 'job-1', status: 'succeeded', request, result: digest }}
        conversationId="conv-1"
      />,
    );
    expect(fetchDigestJob).not.toHaveBeenCalled();
    expect(screen.getByText('Needs my reply')).toBeInTheDocument();
    expect(screen.getByText('Budget review')).toBeInTheDocument();
    expect(screen.getByText('unanswered')).toBeInTheDocument();
    // Company updates are collapsed by default: important, rarely urgent.
    expect(screen.getByText('Company and project updates')).toBeInTheDocument();
    expect(screen.queryByText('Project Atlas weekly')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Company and project updates'));
    expect(screen.getByText('Project Atlas weekly')).toBeInTheDocument();
    // The chat source reported no permission.
    expect(screen.getByText(/Teams chats: no permission/)).toBeInTheDocument();
    expect(
      screen.getByText('Reply to Ana about the budget'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Open in Outlook/ }),
    ).toHaveAttribute(
      'href',
      'https://outlook.office.com/mail/deeplink/read/1',
    );
  });

  it('offers a re-run when the job failed', () => {
    render(
      <DigestCard
        state={{
          jobId: 'job-1',
          status: 'failed',
          request,
          error: 'Graph said no',
        }}
        conversationId="conv-1"
      />,
    );
    expect(screen.getByText('Graph said no')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Run again/ }),
    ).toBeInTheDocument();
  });
});
