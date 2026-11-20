import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';

import { NextIntlClientProvider } from 'next-intl';

import { uploadBrandFile } from '@/client/services/brand/brandBookAdmin';
import {
  BrandReviewReading,
  listUsableBrandBooks,
  readBrandReview,
  startBrandReview,
} from '@/client/services/brand/brandReview';
import type { BrandReviewState } from '@/lib/services/brand/brandReviewJob';

import { BrandReviewWorkspace } from '@/components/Workflows/BrandReview/BrandReviewWorkspace';

import { useConversationStore } from '@/client/stores/conversationStore';
import messages from '@/messages/en.json';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Brand review workspace against the real English messages: setting
 * a review up, reading its findings beside the page, and the report.
 */

vi.unmock('next-intl');
vi.mock('@/client/services/brand/brandBookAdmin', () => ({
  uploadBrandFile: vi.fn(),
}));
vi.mock('@/client/services/brand/brandReview', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listUsableBrandBooks: vi.fn(),
  startBrandReview: vi.fn(),
  readBrandReview: vi.fn(),
  stopBrandReview: vi.fn(),
  removeBrandReview: vi.fn(),
}));
vi.mock('@/client/services/documents/documentPdf', () => ({
  fetchDocumentPdf: vi.fn(),
}));
// The viewer draws PDFs; here it shows the page it is given, its overlays
// and its aside.
vi.mock('@/components/Documents/DocumentViewer', () => ({
  DocumentViewer: ({
    page,
    overlaysOf,
    aside,
  }: {
    page: number;
    overlaysOf: (
      page: number,
      key: string,
    ) => Array<{ id: string; label: string }>;
    aside: ReactNode;
  }) => (
    <div>
      <p data-testid="viewer-page">{page}</p>
      <ul data-testid="overlays">
        {overlaysOf(page, 'k').map((overlay) => (
          <li key={overlay.id}>{overlay.label}</li>
        ))}
      </ul>
      {aside}
    </div>
  ),
}));

const CONVERSATION = 'conv-brand';
const FILE = `/api/file/${'a'.repeat(64)}.pdf`;

function seed(workflowState: Record<string, unknown>) {
  useConversationStore.setState({
    conversations: [
      {
        id: CONVERSATION,
        name: 'Brand review',
        messages: [],
        conversationType: 'brand-review',
        workflowState: {
          kind: 'brand-review',
          modelReview: true,
          updatedAt: '2026-11-20T00:00:00.000Z',
          ...workflowState,
        },
      },
    ],
  } as never);
}

function reviewState(
  changes: Partial<BrandReviewState> = {},
): BrandReviewState {
  return {
    version: 1,
    jobId: 'j',
    status: 'done',
    startedAt: Date.parse('2026-11-20T10:00:00Z'),
    heartbeatAt: 0,
    resumes: 0,
    request: {
      book: {
        id: 'brand-aaaaaaaaaaaa',
        name: 'Northwind',
        updatedAt: 'x',
        body: {} as never,
      },
      file: FILE,
      name: 'Annual review.pdf',
      type: 'pdf',
      modelReview: true,
    },
    phase: 'reviewing',
    scheme: 1,
    pageCount: 2,
    pages: [],
    reviewedPages: [1, 2],
    skippedPages: [],
    findings: [
      {
        id: 'font:u1:comic sans ms',
        rule: 'font',
        severity: 'error',
        page: 1,
        unitId: 'u1',
        imageId: null,
        box: [10, 10, 100, 20],
        found: 'Comic Sans MS',
        expected: ['Montserrat'],
        source: 'check',
      },
      {
        id: 'preferred-term:u2:clients',
        rule: 'preferred-term',
        severity: 'warning',
        page: 2,
        unitId: 'u2',
        imageId: null,
        box: [10, 40, 100, 50],
        found: 'clients',
        expected: ['families'],
        source: 'check',
      },
      {
        id: 'tone:2:u2',
        rule: 'tone',
        severity: 'info',
        page: 2,
        unitId: 'u2',
        imageId: null,
        box: [10, 40, 100, 50],
        found: 'Act now!',
        expected: [],
        source: 'model',
        note: 'Calmer, please.',
      },
    ],
    ...changes,
  };
}

function renderWorkspace() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider
        locale="en"
        messages={messages}
        onError={(error) => {
          throw error;
        }}
      >
        <BrandReviewWorkspace conversationId={CONVERSATION} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe('BrandReviewWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listUsableBrandBooks).mockResolvedValue([
      {
        id: 'brand-aaaaaaaaaaaa',
        name: 'Northwind',
        description: 'Our brand',
        colors: ['#0f7c80'],
        updatedAt: 'x',
      },
    ]);
  });

  it('says where brand books come from when there are none', async () => {
    vi.mocked(listUsableBrandBooks).mockResolvedValue([]);
    seed({});
    renderWorkspace();
    expect(
      await screen.findByText(/No brand books are available/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start review' })).toBeDisabled();
  });

  it('starts once a book and a document are chosen', async () => {
    seed({});
    vi.mocked(uploadBrandFile).mockResolvedValue(FILE);
    vi.mocked(startBrandReview).mockResolvedValue({
      reviewId: 'review-aaaaaaaaaaaa',
      state: reviewState({ status: 'running', phase: 'reading', findings: [] }),
    });
    vi.mocked(readBrandReview).mockImplementation(
      async (): Promise<BrandReviewReading> => ({
        reviewId: 'review-aaaaaaaaaaaa',
        state: reviewState(),
      }),
    );
    const { container } = renderWorkspace();
    fireEvent.click(await screen.findByRole('radio', { name: /Northwind/ }));
    const input =
      container.querySelector<HTMLInputElement>('input[type=file]')!;
    await act(async () => {
      fireEvent.change(input, {
        target: {
          files: [
            new File(['%PDF'], 'Annual review.pdf', {
              type: 'application/pdf',
            }),
          ],
        },
      });
    });
    expect(screen.getByText('Annual review.pdf')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start review' }));

    expect(
      await screen.findByRole('heading', { name: 'Annual review.pdf' }),
    ).toBeInTheDocument();
    expect(startBrandReview).toHaveBeenCalledWith({
      bookId: 'brand-aaaaaaaaaaaa',
      file: FILE,
      name: 'Annual review.pdf',
      modelReview: true,
    });
    expect(
      useConversationStore.getState().conversations[0].workflowState,
    ).toMatchObject({ reviewId: 'review-aaaaaaaaaaaa' });
    // The new review is followed until it ends (it once was not: the
    // first reading came from the start and nothing read it again).
    expect(await screen.findByText('1 error, 1 warning')).toBeInTheDocument();
    expect(readBrandReview).toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('lists findings in words, filters them, and shows a chosen one on its page', async () => {
    seed({ reviewId: 'review-aaaaaaaaaaaa' });
    vi.mocked(readBrandReview).mockResolvedValue({
      reviewId: 'review-aaaaaaaaaaaa',
      state: reviewState(),
    });
    renderWorkspace();
    expect(
      await screen.findByText(
        "Set in Comic Sans MS; the brand's typefaces are Montserrat.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('1 error, 1 warning')).toBeInTheDocument();
    // The model's finding is in its own words, marked as the model's.
    expect(screen.getByText('Calmer, please.')).toBeInTheDocument();
    expect(
      screen.getByText('Found by the model; check it.'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Warnings 1' }));
    const list = screen.getByRole('region', { name: 'Findings' });
    expect(within(list).queryByText(/Comic Sans/)).not.toBeInTheDocument();
    const preferred = within(list).getByRole('button', {
      name: /Write "families"/,
    });
    fireEvent.click(preferred);
    expect(preferred).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('viewer-page')).toHaveTextContent('2');
    expect(
      within(screen.getByTestId('overlays')).getByText(
        /Preferred word: Write "families"/,
      ),
    ).toBeInTheDocument();
  });

  it('downloads a report in the reader’s words', async () => {
    seed({ reviewId: 'review-aaaaaaaaaaaa' });
    vi.mocked(readBrandReview).mockResolvedValue({
      reviewId: 'review-aaaaaaaaaaaa',
      state: reviewState(),
    });
    let report: Blob | null = null;
    URL.createObjectURL = vi.fn((blob: Blob) => {
      report = blob;
      return 'blob:report';
    });
    URL.revokeObjectURL = vi.fn();
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    renderWorkspace();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Download report' }),
    );
    expect(click).toHaveBeenCalled();
    // jsdom's Blob has no text(); FileReader reads it.
    const html = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(report!);
    });
    expect(html).toContain('Brand review: Annual review.pdf');
    expect(html).toContain(
      'Set in Comic Sans MS; the brand&#39;s typefaces are Montserrat.',
    );
    expect(html).toContain('1 error');
  });
});
