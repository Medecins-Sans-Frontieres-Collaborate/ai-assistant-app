/**
 * Unified citation numbering for Foundry agent streams.
 *
 * Two event kinds reference sources:
 *  - inline `【n:m†…】` markers in the text (rewritten to `[N]`), which in
 *    their SHORT form (`【3:0†source】`) carry a label but NO URL
 *  - `url_citation` annotations, which carry the real title + URL and are
 *    emitted immediately after the marker they describe
 *
 * The registry's job is to give both a single shared number. The critical
 * case is the short marker: it must NOT get its own number next to its
 * annotation's — that produced paired duplicates (text citing [1][3][5]
 * while the real sources sat on [2][4][6], with URL-less phantoms breaking
 * the client's source list).
 */
export interface CitationEntry {
  number: number;
  title: string;
  url: string;
  date: string;
}

export class CitationRegistry {
  /** Live entries, in assignment order. Numbers are 1-based and stable. */
  readonly entries: CitationEntry[] = [];

  private nextNumber = 1;
  private numbersByKey = new Map<string, number>();

  /**
   * Registers an inline text marker and returns the `[N]` number for it.
   * Long-form markers carry a URL and key by it; short-form markers key by
   * their raw text so identical markers still dedupe. A short-form entry
   * is created URL-less and expects the following annotation to claim it.
   */
  registerMarker(key: string, title: string, url: string): number {
    const existing = this.numbersByKey.get(key);
    if (existing !== undefined) {
      const entry = this.entries.find((c) => c.number === existing);
      if (entry) {
        if (url && !entry.url) entry.url = url;
        if (title && entry.title === `Source ${existing}`) {
          entry.title = title;
        }
      }
      return existing;
    }

    const number = this.nextNumber++;
    this.numbersByKey.set(key, number);
    this.entries.push({
      number,
      title: title || `Source ${number}`,
      url,
      date: '',
    });
    return number;
  }

  /**
   * Registers a `url_citation` annotation. Reuses the URL's number when the
   * source is already known; otherwise CLAIMS the earliest URL-less marker
   * entry (Foundry emits a marker's annotation right after the marker, so
   * pending URL-less entries pair with arriving annotations in order) and
   * backfills its title/url. Only when no URL-less entry is pending does it
   * mint a fresh number (annotation-only source).
   */
  registerAnnotation(url: string, title: string): number {
    const existing = this.numbersByKey.get(url);
    if (existing !== undefined) {
      const entry = this.entries.find((c) => c.number === existing);
      if (entry && title && entry.title.startsWith('Source ')) {
        entry.title = title;
      }
      return existing;
    }

    const pending = this.entries.find((c) => !c.url);
    if (pending) {
      pending.url = url;
      // The short-form marker label ("source", "Source N") is a
      // placeholder — the annotation's title is the real one.
      if (title) pending.title = title;
      this.numbersByKey.set(url, pending.number);
      return pending.number;
    }

    return this.registerMarker(url, title, url);
  }
}
