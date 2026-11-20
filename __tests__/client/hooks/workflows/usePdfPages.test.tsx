import { act, renderHook, waitFor } from '@testing-library/react';

import { usePdfPages } from '@/client/hooks/workflows/usePdfPages';

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

/** Documents pdf.js "opened", by the text of the file they came from. */
const opened: string[] = [];

vi.mock('pdfjs-dist/build/pdf.min.mjs', () => ({
  getDocument: ({ data }: { data: Uint8Array }) => {
    const name = new TextDecoder().decode(data);
    opened.push(name);
    return {
      promise: Promise.resolve({
        // 'old' differs from the rest, so a stale document shows itself.
        numPages: name === 'old' ? 9 : 3,
        name,
        getPage: async () => ({
          getViewport: ({ scale }: { scale: number }) => ({
            width: 100 * scale,
            height: 140 * scale,
          }),
          render: () => ({ promise: Promise.resolve() }),
        }),
        destroy: vi.fn(async () => undefined),
      }),
    };
  },
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs', () => ({}));

/** A file whose bytes are its name (jsdom's Blob cannot be read back). */
const blobOf = (name: string): Blob =>
  ({
    arrayBuffer: async () => new TextEncoder().encode(name).buffer,
  }) as unknown as Blob;
const file = (name: string) => () => Promise.resolve(blobOf(name));

beforeEach(() => {
  opened.length = 0;
  // jsdom has no canvas drawing; the page "image" names its size instead.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    {} as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(
    function (this: HTMLCanvasElement) {
      return `image ${this.width}`;
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('usePdfPages', () => {
  it('opens the document at once by default', async () => {
    const loadFile = vi.fn(file('report'));
    const { result } = renderHook(() => usePdfPages(loadFile, 'report'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.pageCount).toBe(3);
    expect(loadFile).toHaveBeenCalledTimes(1);
  });

  it('on demand, fetches nothing until a page is rendered, then opens it once', async () => {
    const loadFile = vi.fn(file('report'));
    const { result } = renderHook(() =>
      usePdfPages(loadFile, 'report', { onDemand: true }),
    );
    // Nothing is fetched while no page is wanted.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(loadFile).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');

    let first: string | null = null;
    let second: string | null = null;
    await act(async () => {
      [first, second] = await Promise.all([
        result.current.renderPage(1, 50),
        result.current.renderPage(2, 50),
      ]);
    });
    expect(first).toMatch(/^image /);
    expect(second).toMatch(/^image /);
    expect(result.current.status).toBe('ready');
    expect(loadFile).toHaveBeenCalledTimes(1);
    expect(opened).toEqual(['report']);
  });

  it('opens a document not loaded yet when on demand is turned off', async () => {
    const loadFile = vi.fn(file('report'));
    const { result, rerender } = renderHook(
      ({ onDemand }) => usePdfPages(loadFile, 'report', { onDemand }),
      { initialProps: { onDemand: true } },
    );
    expect(loadFile).not.toHaveBeenCalled();
    rerender({ onDemand: false });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(loadFile).toHaveBeenCalledTimes(1);
  });

  it('renders nothing for a page outside the document', async () => {
    const { result } = renderHook(() =>
      usePdfPages(file('report'), 'report', { onDemand: true }),
    );
    let image: string | null = 'unset';
    await act(async () => {
      image = await result.current.renderPage(4, 50);
    });
    expect(image).toBeNull();
  });

  it('opens the new document after the key changes, not the old one', async () => {
    let releaseOld!: () => void;
    const loads: Record<string, () => Promise<Blob>> = {
      old: () =>
        new Promise<Blob>((resolve) => {
          releaseOld = () => resolve(blobOf('old'));
        }),
      new: file('new'),
    };
    const { result, rerender } = renderHook(
      ({ key }) => usePdfPages(loads[key], key),
      { initialProps: { key: 'old' } },
    );
    // One tick before the key changes: two imports of the mocked pdf.js in
    // flight at once make Vitest load the real one (browsers share one
    // import). The old file is still loading either way, until released.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    rerender({ key: 'new' });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    // The old file arrives late; it must not replace the new document.
    await act(async () => {
      releaseOld();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(result.current.status).toBe('ready');
    expect(result.current.pageCount).toBe(3);
    expect(opened.at(-1)).toBe('old');
    expect(opened).toContain('new');
    let image: string | null = null;
    await act(async () => {
      image = await result.current.renderPage(1, 50);
    });
    expect(image).toMatch(/^image /);
  });
});
