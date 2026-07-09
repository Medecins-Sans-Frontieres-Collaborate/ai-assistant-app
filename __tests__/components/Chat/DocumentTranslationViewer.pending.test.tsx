import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';

import { Conversation } from '@/types/chat';

import { DocumentTranslationContent } from '@/components/Chat/ChatMessages/DocumentTranslationContent';
import {
  DocumentTranslationViewer,
  formatPendingTranslationReference,
  isDocumentTranslationPendingReference,
  parsePendingTranslationReference,
} from '@/components/Chat/DocumentTranslationViewer';

import { useConversationStore } from '@/client/stores/conversationStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const JOB_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PENDING = formatPendingTranslationReference(
  'report_fr.pdf',
  'fr',
  JOB_ID,
  'pdf',
  '2026-07-09T10:00:00.000Z',
);

function seedConversation(): Conversation {
  const conversation = {
    id: 'conv-1',
    name: 'Translation: report.pdf',
    messages: [
      {
        type: 'assistant_group',
        activeIndex: 0,
        versions: [
          {
            content: PENDING,
            messageType: 'TEXT',
            createdAt: '2026-07-09T10:00:00.000Z',
          },
        ],
      },
    ],
    model: { id: 'gpt-5.2', name: 'GPT-5.2' },
    prompt: '',
    temperature: 0.5,
    folderId: null,
  } as never as Conversation;
  useConversationStore.setState({
    conversations: [conversation],
    selectedConversationId: 'conv-1',
  });
  return conversation;
}

describe('pending translation marker helpers', () => {
  it('round-trips format → parse', () => {
    expect(isDocumentTranslationPendingReference(PENDING)).toBe(true);
    expect(parsePendingTranslationReference(PENDING)).toMatchObject({
      filename: 'report_fr.pdf',
      languageCode: 'fr',
      jobId: JOB_ID,
      extension: 'pdf',
    });
  });

  it('does not match completed references', () => {
    expect(
      isDocumentTranslationPendingReference(
        `[Translation: report_fr.pdf | lang:fr | blob:${JOB_ID} | ext:pdf | expires:2026-07-16T10:00:00.000Z]`,
      ),
    ).toBe(false);
  });
});

describe('DocumentTranslationViewer (pending)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    seedConversation();
  });

  it('renders the in-progress card and polls the status endpoint', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ success: true, data: { status: 'Running' } }),
          { status: 200 },
        ),
    ) as never;

    render(<DocumentTranslationViewer content={PENDING} />);

    expect(screen.getByText('Translating report_fr.pdf…')).toBeInTheDocument();
    await waitFor(() =>
      expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
        `/api/document-translation/status/${JOB_ID}`,
      ),
    );
  });

  it('rewrites the conversation message to the FINAL reference on success', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: {
              status: 'Succeeded',
              reference: {
                translatedFilename: 'report_fr.pdf',
                targetLanguage: 'fr',
                jobId: JOB_ID,
                fileExtension: 'pdf',
                expiresAt: '2026-07-16T10:00:00.000Z',
              },
            },
          }),
          { status: 200 },
        ),
    ) as never;

    render(<DocumentTranslationViewer content={PENDING} />);

    await waitFor(() => {
      const entry = useConversationStore.getState().conversations[0]
        .messages[0] as never as {
        versions: Array<{ content: string }>;
      };
      expect(entry.versions[0].content).toBe(
        `[Translation: report_fr.pdf | lang:fr | blob:${JOB_ID} | ext:pdf | expires:2026-07-16T10:00:00.000Z]`,
      );
    });
  });

  it('rewrites to a plain failure line on terminal failure', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: { status: 'Failed', error: 'Document is password protected' },
          }),
          { status: 200 },
        ),
    ) as never;

    render(<DocumentTranslationViewer content={PENDING} />);

    await waitFor(() => {
      const entry = useConversationStore.getState().conversations[0]
        .messages[0] as never as {
        versions: Array<{ content: string }>;
      };
      expect(entry.versions[0].content).toBe(
        'Document translation failed: Document is password protected',
      );
    });
  });

  it('treats a 404 (expired job record) as terminal', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('{}', { status: 404 }),
    ) as never;

    render(<DocumentTranslationViewer content={PENDING} />);

    await waitFor(() => {
      const entry = useConversationStore.getState().conversations[0]
        .messages[0] as never as {
        versions: Array<{ content: string }>;
      };
      expect(entry.versions[0].content).toContain(
        'Document translation failed:',
      );
    });
  });
});

describe('DocumentTranslationContent wrapper (the path AssistantMessage renders)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    seedConversation();
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ success: true, data: { status: 'Running' } }),
          { status: 200 },
        ),
    ) as never;
  });

  it('renders the PENDING card — not the invalid-reference error', () => {
    render(<DocumentTranslationContent content={PENDING} />);

    // Regression: the wrapper used to validate only the COMPLETED format
    // and short-circuited pending markers to a yellow error card.
    expect(
      screen.queryByText('Invalid document translation reference'),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Translating report_fr.pdf…')).toBeInTheDocument();
  });

  it('still rejects genuinely malformed content', () => {
    render(<DocumentTranslationContent content="[Translation: broken" />);

    expect(
      screen.getByText('Invalid document translation reference'),
    ).toBeInTheDocument();
  });
});
