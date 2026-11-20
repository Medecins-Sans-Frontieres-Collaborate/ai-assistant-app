import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

import { PageOverlay } from '@/components/Documents/DocumentPage';
import {
  DocumentViewer,
  ViewerSource,
} from '@/components/Documents/DocumentViewer';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The documents layer's viewer: pages of one or two versions of a
 * document, a page list, page turning by button and key, zoom, and boxes
 * over a page that can be chosen with the keyboard.
 */

vi.mock('next-intl', () => ({
  // Keys and values, so the words a test looks for are predictable.
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${JSON.stringify(values)}` : key,
}));

/** pdf.js stand-in: a document's page count is in its "file" name. */
vi.mock('pdfjs-dist/build/pdf.min.mjs', () => ({
  getDocument: ({ data }: { data: Uint8Array }) => {
    const name = new TextDecoder().decode(data);
    return {
      promise: Promise.resolve({
        numPages: Number(name.split(':')[1]),
        getPage: async (page: number) => ({
          getViewport: ({ scale }: { scale: number }) => ({
            width: 720 * scale,
            height: 540 * scale,
          }),
          render: () => ({ promise: Promise.resolve() }),
          page,
        }),
        destroy: vi.fn(async () => undefined),
      }),
    };
  },
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs', () => ({}));

const source = (key: string, pages: number, label = key): ViewerSource => ({
  key,
  label,
  load: async () =>
    ({
      arrayBuffer: async () =>
        new TextEncoder().encode(`${key}:${pages}`).buffer,
    }) as unknown as Blob,
});

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    {} as unknown as CanvasRenderingContext2D,
  );
  // jsdom lays nothing out; the viewer counts as shown (ownsKeyboard).
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([
    new DOMRect(0, 0, 800, 600),
  ] as unknown as DOMRectList);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
    'data:image/jpeg;base64,AAAA',
  );
});
afterEach(() => vi.restoreAllMocks());

const position = (page: number, count: number) =>
  `position ${JSON.stringify({ unit: 'slide', page, count })}`;

describe('DocumentViewer', () => {
  it('shows the first page, lists every page, and turns pages', async () => {
    render(<DocumentViewer sources={[source('deck', 3)]} unit="slide" />);
    expect(await screen.findByText(position(1, 3))).toBeTruthy();
    const list = screen.getByRole('navigation');
    expect(list.querySelectorAll('li')).toHaveLength(3);
    // The page itself, named as a slide.
    expect(
      await screen.findByRole('img', {
        name: `pageLabel ${JSON.stringify({ unit: 'slide', page: 1 })}`,
      }),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole('button', {
        name: `next ${JSON.stringify({ unit: 'slide' })}`,
      }),
    );
    expect(await screen.findByText(position(2, 3))).toBeTruthy();
    // PageDown and PageUp turn pages too, and stop at the ends.
    fireEvent.keyDown(window, { key: 'PageDown' });
    expect(await screen.findByText(position(3, 3))).toBeTruthy();
    fireEvent.keyDown(window, { key: 'PageDown' });
    expect(screen.getByText(position(3, 3))).toBeTruthy();
    fireEvent.keyDown(window, { key: 'PageUp' });
    expect(await screen.findByText(position(2, 3))).toBeTruthy();
  });

  it('moves through the page list with arrow keys, as one Tab stop', async () => {
    render(<DocumentViewer sources={[source('deck', 3)]} unit="page" />);
    await screen.findByText(
      `position ${JSON.stringify({ unit: 'page', page: 1, count: 3 })}`,
    );
    const items = screen
      .getByRole('navigation')
      .querySelectorAll<HTMLButtonElement>('button');
    expect([...items].map((item) => item.tabIndex)).toEqual([0, -1, -1]);
    items[0].focus();
    fireEvent.keyDown(items[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    expect(items[1].getAttribute('aria-current')).toBe('page');
  });

  it('switches between two versions on the same page', async () => {
    render(
      <DocumentViewer
        sources={[source('translated', 4), source('original', 4)]}
        unit="page"
      />,
    );
    const versions = screen.getAllByRole('radio');
    expect(versions.map((radio) => radio.textContent)).toEqual([
      'translated',
      'original',
    ]);
    expect(versions[0].getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(versions[0], { key: 'ArrowRight' });
    expect(versions[1].getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(versions[1]);
  });

  it('zooms with its buttons and with Ctrl and plus, not the browser', async () => {
    render(<DocumentViewer sources={[source('deck', 1)]} unit="page" />);
    await screen.findByText(
      `position ${JSON.stringify({ unit: 'page', page: 1, count: 1 })}`,
    );
    const level = () =>
      screen.getByText(/^zoomLevel/).textContent?.match(/\d+/)?.[0];
    expect(level()).toBe('100');
    fireEvent.click(screen.getByRole('button', { name: 'zoomIn' }));
    expect(level()).toBe('125');
    const event = new KeyboardEvent('keydown', {
      key: '=',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(level()).toBe('150');
  });

  it('draws boxes over the page that the keyboard moves between and chooses', async () => {
    const chosen = vi.fn();
    const overlays: PageOverlay[] = [
      { id: 'a', box: [10, 10, 100, 40], tone: 'error', label: 'Finding a' },
      { id: 'b', box: [10, 60, 100, 90], tone: 'warning', label: 'Finding b' },
    ];
    render(
      <DocumentViewer
        sources={[source('deck', 2)]}
        unit="slide"
        overlaysOf={(page) => (page === 1 ? overlays : [])}
        onSelectOverlay={chosen}
        pageBadge={(page) => (page === 1 ? <span>2 findings</span> : null)}
      />,
    );
    const first = await screen.findByRole('button', { name: 'Finding a' });
    const second = screen.getByRole('button', { name: 'Finding b' });
    // Placed from page points (a 720 x 540 page) as percentages.
    expect(first.style.left).toBe('1.111%');
    expect([first.tabIndex, second.tabIndex]).toEqual([0, -1]);
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(second);
    fireEvent.click(second);
    expect(chosen).toHaveBeenCalledWith('b');
    expect(screen.getByText('2 findings')).toBeTruthy();
  });

  it('says so when the document cannot be shown', async () => {
    render(
      <DocumentViewer
        sources={[
          {
            key: 'broken',
            label: 'x',
            load: () => Promise.reject(new Error('busy')),
          },
        ]}
        unit="page"
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('failed'),
    );
  });
});
