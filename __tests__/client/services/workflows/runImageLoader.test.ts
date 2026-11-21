import {
  MAX_BACKGROUND_IMAGE_LOADS,
  MAX_CONCURRENT_IMAGE_LOADS,
  createRunImageLoader,
  prefetchOrder,
} from '@/client/services/workflows/runImageLoader';

import { describe, expect, it } from 'vitest';

/**
 * A fetcher whose loads finish only when the test says so, and which
 * records the order loads started in.
 */
function controlledFetcher() {
  const started: string[] = [];
  const open = new Map<
    string,
    { resolve: (image: string) => void; reject: (error: unknown) => void }
  >();
  const fetchImage = (url: string) =>
    new Promise<string>((resolve, reject) => {
      started.push(url);
      open.set(url, { resolve, reject });
    });
  /** Finishes a running load and lets the queue move on. */
  const finish = async (url: string, image = `image:${url}`) => {
    open.get(url)!.resolve(image);
    open.delete(url);
    await Promise.resolve();
    await Promise.resolve();
  };
  const fail = async (url: string) => {
    open.get(url)!.reject(new Error(`${url} failed`));
    open.delete(url);
    await Promise.resolve();
    await Promise.resolve();
  };
  return { fetchImage, started, running: () => [...open.keys()], finish, fail };
}

describe('runImageLoader', () => {
  it('keeps the limits in the relation the queue depends on', () => {
    // A background load must always leave a slot for the page on screen.
    expect(MAX_BACKGROUND_IMAGE_LOADS).toBeLessThan(MAX_CONCURRENT_IMAGE_LOADS);
  });

  it('fetches an image once, however often it is asked for', async () => {
    const fetcher = controlledFetcher();
    const loader = createRunImageLoader(fetcher.fetchImage);
    const first = loader.load('a', 'now');
    const second = loader.load('a', 'soon');
    expect(fetcher.started).toEqual(['a']);
    await fetcher.finish('a');
    expect(await first).toBe('image:a');
    expect(await second).toBe('image:a');
    expect(await loader.load('a', 'later')).toBe('image:a');
    expect(loader.peek('a')).toBe('image:a');
    expect(fetcher.started).toEqual(['a']);
  });

  it('runs only a few loads at once and starts the most urgent next', async () => {
    const fetcher = controlledFetcher();
    const loader = createRunImageLoader(fetcher.fetchImage, {
      concurrent: 2,
      background: 1,
    });
    void loader.load('s1', 'soon');
    void loader.load('s2', 'soon');
    void loader.load('s3', 'soon');
    void loader.load('page', 'now');
    expect(fetcher.running()).toEqual(['s1', 's2']);
    await fetcher.finish('s1');
    // The page on screen jumps the queue; equal priorities keep their order.
    expect(fetcher.running()).toEqual(['s2', 'page']);
    await fetcher.finish('page');
    expect(fetcher.running()).toEqual(['s2', 's3']);
  });

  it('keeps background loads out of the last slot', async () => {
    const fetcher = controlledFetcher();
    const loader = createRunImageLoader(fetcher.fetchImage, {
      concurrent: 3,
      background: 2,
    });
    for (const url of ['b1', 'b2', 'b3', 'b4']) void loader.load(url, 'later');
    expect(fetcher.running()).toEqual(['b1', 'b2']);
    // The free slot takes the page that is opened, at once.
    void loader.load('page', 'now');
    expect(fetcher.running()).toEqual(['b1', 'b2', 'page']);
    await fetcher.finish('b1');
    expect(fetcher.running()).toEqual(['b2', 'page', 'b3']);
  });

  it('raises a waiting image to a more urgent priority, never lowers it', async () => {
    const fetcher = controlledFetcher();
    const loader = createRunImageLoader(fetcher.fetchImage, {
      concurrent: 1,
      background: 1,
    });
    void loader.load('busy', 'now');
    void loader.load('x', 'later');
    void loader.load('y', 'soon');
    void loader.load('x', 'now');
    void loader.load('y', 'later');
    await fetcher.finish('busy');
    expect(fetcher.running()).toEqual(['x']);
    await fetcher.finish('x');
    expect(fetcher.running()).toEqual(['y']);
  });

  it('does not keep a failed image, so asking again tries again', async () => {
    const fetcher = controlledFetcher();
    const loader = createRunImageLoader(fetcher.fetchImage);
    const failing = loader.load('a', 'now');
    await fetcher.fail('a');
    await expect(failing).rejects.toThrow('a failed');
    expect(loader.peek('a')).toBeUndefined();
    const retry = loader.load('a', 'now');
    expect(fetcher.started).toEqual(['a', 'a']);
    await fetcher.finish('a');
    expect(await retry).toBe('image:a');
  });

  it('forgets the least recently used images beyond its capacity', async () => {
    const fetcher = controlledFetcher();
    const loader = createRunImageLoader(fetcher.fetchImage, { cached: 2 });
    for (const url of ['a', 'b']) {
      void loader.load(url, 'now');
      await fetcher.finish(url);
    }
    // Reading 'a' makes 'b' the least recently used.
    expect(loader.peek('a')).toBe('image:a');
    void loader.load('c', 'now');
    await fetcher.finish('c');
    expect(loader.peek('b')).toBeUndefined();
    expect(loader.peek('a')).toBe('image:a');
    expect(loader.peek('c')).toBe('image:c');
  });
});

describe('prefetchOrder', () => {
  const images = [1, 2, 3, 4, 7].map((page) => ({ page, url: `p${page}` }));

  it('puts the pages either side first, then the rest nearest first', () => {
    expect(prefetchOrder(images, 3)).toEqual({
      near: ['p2', 'p4'],
      rest: ['p1', 'p7'],
    });
  });

  it('leaves out the page on screen, and has no neighbour past an end', () => {
    expect(prefetchOrder(images, 1)).toEqual({
      near: ['p2'],
      rest: ['p3', 'p4', 'p7'],
    });
  });

  it('works from an untranslated page, which has no image of its own', () => {
    expect(prefetchOrder(images, 6)).toEqual({
      near: ['p7'],
      rest: ['p4', 'p3', 'p2', 'p1'],
    });
  });
});
