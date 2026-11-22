import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';

import { NextIntlClientProvider } from 'next-intl';

import {
  BrandBookConflictError,
  draftBrandBookFromGuide,
  listAdminBrandBooks,
  updateBrandBook,
  uploadBrandFile,
  uploadBrandGuide,
} from '@/client/services/brand/brandBookAdmin';

import {
  BrandBookBody,
  parseBrandBookBody,
} from '@/lib/utils/shared/brand/brandBook';

import { BrandBookAdminEditor } from '@/components/AgentAccess/BrandBooks/BrandBookAdminEditor';
import { BrandBooksSection } from '@/components/AgentAccess/BrandBooks/BrandBooksSection';

import messages from '@/messages/en.json';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The brand book editor against the real English messages (a missing key
 * throws): load, edit, save with the ETag it was read as, the conflict
 * banner, refused values, and a draft from a guide that keeps the
 * admin's files.
 */

// The real translator over the real messages: a missing key throws.
vi.unmock('next-intl');
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/client/services/brand/brandBookAdmin', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listAdminBrandBooks: vi.fn(),
  updateBrandBook: vi.fn(),
  uploadBrandFile: vi.fn(),
  uploadBrandGuide: vi.fn(),
  draftBrandBookFromGuide: vi.fn(),
  createBrandBook: vi.fn(),
  deleteBrandBook: vi.fn(),
}));

const ID = 'brand-abc123def456';
const LOGO = `admin:${ID}/${'d'.repeat(32)}.png`;

function body(changes: Record<string, unknown> = {}): BrandBookBody {
  const parsed = parseBrandBookBody({
    name: 'Northwind',
    palette: [{ name: 'Teal', hex: '#0f7c80', roles: ['primary'] }],
    fonts: [{ role: 'heading', family: 'Montserrat' }],
    logos: [{ id: 'main', name: 'Main logo', file: LOGO }],
    ...changes,
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.body;
}

function listing(book: BrandBookBody, etag = '"e1"') {
  return {
    books: [
      {
        canonicalKey: `brand-book::${ID}`,
        etag,
        record: {
          version: 1 as const,
          id: ID,
          book,
          createdBy: 'a@example.org',
          createdAt: '2026-11-01T00:00:00.000Z',
          updatedBy: 'a@example.org',
          updatedAt: '2026-11-01T00:00:00.000Z',
        },
      },
    ],
  };
}

function renderWithApp(node: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider
        locale="en"
        messages={messages}
        onError={(error) => {
          throw error;
        }}
      >
        {node}
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

async function openEditor() {
  const view = renderWithApp(<BrandBookAdminEditor bookId={ID} />);
  await screen.findByRole('heading', { level: 1, name: 'Northwind' });
  return view;
}

describe('BrandBookAdminEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listAdminBrandBooks).mockResolvedValue(listing(body()));
    vi.mocked(updateBrandBook).mockImplementation(async (_id, book) => ({
      record: { ...listing(book).books[0].record },
      etag: '"e2"',
      canonicalKey: `brand-book::${ID}`,
    }));
  });

  it('saves an edit over the version it read, then is clean again', async () => {
    await openEditor();
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    // The book's own name is the first "Name" on the page.
    fireEvent.change(screen.getAllByLabelText('Name')[0], {
      target: { value: 'Northwind Health' },
    });
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    fireEvent.click(save);

    await waitFor(() => expect(updateBrandBook).toHaveBeenCalledTimes(1));
    const [id, saved, etag] = vi.mocked(updateBrandBook).mock.calls[0];
    expect(id).toBe(ID);
    expect(etag).toBe('"e1"');
    expect(saved.name).toBe('Northwind Health');
    expect(saved.logos[0].file).toBe(LOGO);
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('saves on Ctrl+S, and does nothing when there is nothing to save', async () => {
    await openEditor();
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(updateBrandBook).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Add colour' }));
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await waitFor(() => expect(updateBrandBook).toHaveBeenCalledTimes(1));
    expect(vi.mocked(updateBrandBook).mock.calls[0][1].palette).toHaveLength(2);
  });

  it('keeps a hex that is not one in the box, marked, and uncommitted', async () => {
    await openEditor();
    // The text box, not the swatch picker beside it.
    const hex = () => screen.getByLabelText('Hex');
    fireEvent.change(hex(), { target: { value: '#0f7' } });
    fireEvent.blur(hex());
    // A short hex is one: committed in its long form.
    expect(hex()).toHaveValue('#00ff77');
    expect(hex()).toHaveAttribute('aria-invalid', 'false');

    fireEvent.change(hex(), { target: { value: 'teal' } });
    fireEvent.blur(hex());
    expect(hex()).toHaveValue('teal');
    expect(hex()).toHaveAttribute('aria-invalid', 'true');
    // The labelled picker still shows the last colour committed.
    expect(screen.getByLabelText('Pick a colour for Teal')).toHaveValue(
      '#00ff77',
    );
  });

  it('refuses a book the schema refuses, naming where, without a request', async () => {
    await openEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Add colour' }));
    const names = screen.getAllByDisplayValue(/Teal|Colour 2/);
    fireEvent.change(names[1], { target: { value: 'teal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'palette.1: "teal" appears twice',
    );
    expect(updateBrandBook).not.toHaveBeenCalled();
  });

  it('shows the conflict banner on a 409, and reloads the other version', async () => {
    vi.mocked(updateBrandBook).mockRejectedValue(new BrandBookConflictError());
    await openEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Add colour' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('Another admin saved');
    vi.mocked(listAdminBrandBooks).mockResolvedValue(
      listing(body({ name: 'Theirs' }), '"e9"'),
    );
    fireEvent.click(within(banner).getByRole('button', { name: 'Reload' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Theirs' }),
    ).toBeInTheDocument();
  });

  it('applies a guide draft but keeps the logos, and can undo it', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:guide');
    URL.revokeObjectURL = vi.fn();
    vi.mocked(uploadBrandGuide).mockResolvedValue(
      `/api/file/${'a'.repeat(64)}.pdf`,
    );
    vi.mocked(draftBrandBookFromGuide).mockResolvedValue({
      book: body({
        name: 'Northwind',
        palette: [
          { name: 'Ink', hex: '#1b2a41' },
          { name: 'Sand', hex: '#f2e8d5' },
        ],
        language: {
          preferred: [{ term: 'families', alternatives: ['clients'] }],
        },
        logos: [],
        source: { file: `/api/file/${'a'.repeat(64)}.pdf`, name: 'Guide.pdf' },
      }),
      evidence: {
        fonts: [{ family: 'Montserrat', share: 0.6 }],
        colors: [{ hex: '#1b2a41', share: 0.7 }],
        smallestTextPt: 9,
        pageCount: 12,
      },
      // One colour the guide states and one it does not; a word it states
      // whose replaced word it does not.
      grounding: {
        colors: { '#1b2a41': 7, '#f2e8d5': null },
        fonts: {},
        terms: { families: 3, clients: null },
      },
      logoMinWidthPt: 90,
      dropped: 2,
    });
    const { container } = await openEditor();
    const input = container.querySelector<HTMLInputElement>(
      'input[type=file][accept=".pdf"]',
    )!;
    await act(async () => {
      fireEvent.change(input, {
        target: {
          files: [new File(['%PDF'], 'Guide.pdf', { type: 'application/pdf' })],
        },
      });
    });

    expect(
      await screen.findByText(/Drafted from a guide of 12 pages/),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue('Ink')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Main logo')).toBeInTheDocument();
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    // What the guide's text backs, in total and value by value.
    expect(
      screen.getByText(/1 of 2 colours, 0 of 0 typefaces, 1 of 2 words/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Guide, page 7' })).toHaveAttribute(
      'href',
      'blob:guide#page=7',
    );
    expect(
      screen.getByText("Not found in the guide's text."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Not found in the guide's text: clients"),
    ).toBeInTheDocument();
    expect(screen.getByText(/2 entries could not be used/)).toBeInTheDocument();
    // The guide's smallest logo width fills in the logo that had none.
    expect(screen.getByLabelText('Smallest width (pt)')).toHaveValue(90);

    fireEvent.click(screen.getByRole('button', { name: 'Undo the draft' }));
    expect(screen.getByDisplayValue('Teal')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Ink')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('says so when the book does not exist or is not the admin’s', async () => {
    vi.mocked(listAdminBrandBooks).mockResolvedValue({ books: [] });
    renderWithApp(<BrandBookAdminEditor bookId={ID} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'does not exist',
    );
  });
});

describe('BrandBooksSection', () => {
  it('lists each book with its palette and counts', async () => {
    vi.mocked(listAdminBrandBooks).mockResolvedValue(listing(body()));
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true, data: { rules: [] } })),
      ),
    );
    renderWithApp(<BrandBooksSection />);
    expect(await screen.findByText('Northwind')).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: '1 brand colour' }),
    ).toBeInTheDocument();
    expect(screen.getByText('1 typeface, 1 logo')).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});
