/**
 * PAGE IMAGES of a formatted translation run, loaded once and in the order
 * they are needed.
 *
 * A run's page images are stored files named by their content, so an image
 * at a URL never changes: each URL is fetched at most once per session and
 * kept, and a component that stops wanting an image does not abort its
 * load (the next one to want it gets it at once).
 *
 * Loads are queued by priority (see {@link RunImagePriority}) and only a
 * few run at once. Every image of a long document requested together
 * would make the page on screen wait behind all the others; background
 * loads are also kept out of one of the slots, so a page that is opened
 * starts loading as soon as it is asked for.
 */

/**
 * How soon an image is needed:
 *  - `now`: on screen (the page being looked at).
 *  - `soon`: likely next (the pages either side, thumbnails near view).
 *  - `later`: everything else, loaded in the background.
 */
export type RunImagePriority = 'now' | 'soon' | 'later';

const PRIORITY_RANK: Record<RunImagePriority, number> = {
  now: 0,
  soon: 1,
  later: 2,
};

/** Images loading at once. */
export const MAX_CONCURRENT_IMAGE_LOADS = 3;
/** Of those, how many background (`later`) loads may take. */
export const MAX_BACKGROUND_IMAGE_LOADS = 2;
/**
 * Images kept in memory. A page image is a few hundred kilobytes as a data
 * URL, so this holds several long documents; the least recently used go
 * first beyond it.
 */
export const MAX_CACHED_IMAGES = 120;

/**
 * The order to load the other pages' images in, for a person looking at
 * `page`: the pages either side are likely next; the rest follow by how far
 * they are, nearer first.
 *
 * @param images - Image URLs of the run's translated pages.
 * @param page - The page on screen; its own image is left out.
 * @returns `near` (the pages either side) and `rest`, as URLs.
 * @example prefetchOrder([{page: 1, url: 'a'}, {page: 2, url: 'b'},
 *   {page: 5, url: 'e'}], 1) // { near: ['b'], rest: ['e'] }
 */
export function prefetchOrder(
  images: ReadonlyArray<{ page: number; url: string }>,
  page: number,
): { near: string[]; rest: string[] } {
  const others = images
    .filter((image) => image.page !== page)
    .sort(
      (a, b) =>
        Math.abs(a.page - page) - Math.abs(b.page - page) || a.page - b.page,
    );
  const isNear = (image: { page: number }) => Math.abs(image.page - page) === 1;
  return {
    near: others.filter(isNear).map((image) => image.url),
    rest: others.filter((image) => !isNear(image)).map((image) => image.url),
  };
}

/** Fetches one image and answers it as something an `<img>` can show. */
export type RunImageFetcher = (url: string) => Promise<string>;

interface QueuedLoad {
  url: string;
  priority: RunImagePriority;
  /** Order of the first request, to keep equal priorities first-come. */
  order: number;
  promise: Promise<string>;
  resolve: (image: string) => void;
  reject: (error: unknown) => void;
}

export interface RunImageLoader {
  /** The image at `url` when it is already loaded, else undefined. */
  peek: (url: string) => string | undefined;
  /**
   * The image at `url`: at once when loaded, else queued at `priority`.
   * Asking again for an image that is still waiting raises its priority
   * when the new one is more urgent; it never lowers it.
   *
   * @throws What the fetcher threw. A failed image is not kept, so a later
   *   request tries again.
   */
  load: (url: string, priority: RunImagePriority) => Promise<string>;
}

/**
 * Creates a loader around a fetcher (see PAGE IMAGES above). The app uses
 * the one {@link runImageLoader}; tests create their own.
 *
 * @param fetchImage - Fetches one image.
 * @param limits - Overrides of the concurrency and cache limits.
 */
export function createRunImageLoader(
  fetchImage: RunImageFetcher,
  limits: {
    concurrent?: number;
    background?: number;
    cached?: number;
  } = {},
): RunImageLoader {
  const concurrent = limits.concurrent ?? MAX_CONCURRENT_IMAGE_LOADS;
  const background = limits.background ?? MAX_BACKGROUND_IMAGE_LOADS;
  const capacity = limits.cached ?? MAX_CACHED_IMAGES;
  // Insertion order is recency: a read moves an entry to the end.
  const loaded = new Map<string, string>();
  const waiting = new Map<string, QueuedLoad>();
  const running = new Map<string, QueuedLoad>();
  let nextOrder = 0;

  const remember = (url: string, image: string) => {
    loaded.delete(url);
    loaded.set(url, image);
    while (loaded.size > capacity) {
      const oldest = loaded.keys().next().value;
      if (oldest === undefined) break;
      loaded.delete(oldest);
    }
  };

  const backgroundRunning = (): number =>
    [...running.values()].filter((load) => load.priority === 'later').length;

  /** The most urgent waiting load that may start now, if any. */
  const nextStartable = (): QueuedLoad | undefined => {
    let best: QueuedLoad | undefined;
    for (const load of waiting.values()) {
      if (load.priority === 'later' && backgroundRunning() >= background) {
        continue;
      }
      if (
        !best ||
        PRIORITY_RANK[load.priority] < PRIORITY_RANK[best.priority] ||
        (load.priority === best.priority && load.order < best.order)
      ) {
        best = load;
      }
    }
    return best;
  };

  const pump = () => {
    while (running.size < concurrent) {
      const load = nextStartable();
      if (!load) return;
      waiting.delete(load.url);
      running.set(load.url, load);
      fetchImage(load.url).then(
        (image) => {
          running.delete(load.url);
          remember(load.url, image);
          load.resolve(image);
          pump();
        },
        (error: unknown) => {
          running.delete(load.url);
          load.reject(error);
          pump();
        },
      );
    }
  };

  return {
    peek(url) {
      const image = loaded.get(url);
      if (image !== undefined) remember(url, image);
      return image;
    },
    load(url, priority) {
      const image = loaded.get(url);
      if (image !== undefined) {
        remember(url, image);
        return Promise.resolve(image);
      }
      const inFlight = running.get(url);
      if (inFlight) return inFlight.promise;
      const queued = waiting.get(url);
      if (queued) {
        if (PRIORITY_RANK[priority] < PRIORITY_RANK[queued.priority]) {
          queued.priority = priority;
          pump();
        }
        return queued.promise;
      }
      let resolve!: (image: string) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<string>((onLoad, onFail) => {
        resolve = onLoad;
        reject = onFail;
      });
      waiting.set(url, {
        url,
        priority,
        order: nextOrder++,
        promise,
        resolve,
        reject,
      });
      pump();
      return promise;
    },
  };
}
