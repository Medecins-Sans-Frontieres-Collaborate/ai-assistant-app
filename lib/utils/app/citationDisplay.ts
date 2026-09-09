import { Citation } from '@/types/rag';

/**
 * Source-card assembly for the citations dropdown. Several citations of the
 * same document (chunk-level entries) collapse into ONE card; when we know
 * which citation numbers the message text actually cited, the card carries
 * an EVIDENCE list — each cited number's own quote paired with its own page
 * locator — instead of the misleading legacy merge (first chunk's quote next
 * to every chunk's pages).
 */

export interface SourceCardEvidence {
  number: number;
  quote: string;
  locator?: string;
}

export interface SourceCard extends Citation {
  /** Per-cited-citation quotes; when present, card-level quote/locator are unset. */
  evidence?: SourceCardEvidence[];
}

export function buildSourceCards(
  citations: Citation[],
  citedNumbers?: number[],
): SourceCard[] {
  const citedSet = new Set(citedNumbers ?? []);
  // Same duplicate predicate the legacy reduce used: two citations are the
  // same source when their url OR title matches.
  const groups: Citation[][] = [];
  for (const citation of citations) {
    if (!citation.url) continue;
    const existing = groups.find(
      (group) =>
        (group[0].url && citation.url && group[0].url === citation.url) ||
        (group[0].title && citation.title && group[0].title === citation.title),
    );
    if (existing) {
      existing.push(citation);
    } else {
      groups.push([citation]);
    }
  }

  return groups.map((members) => {
    const kept = members[0];

    const citedWithQuotes =
      citedSet.size > 0
        ? members.filter((c) => !!c.quote && citedSet.has(c.number))
        : [];

    if (citedWithQuotes.length > 0) {
      const seenQuotes = new Set<string>();
      const evidence: SourceCardEvidence[] = [];
      for (const c of [...citedWithQuotes].sort(
        (a, b) => a.number - b.number,
      )) {
        if (seenQuotes.has(c.quote!)) continue;
        seenQuotes.add(c.quote!);
        evidence.push({
          number: c.number,
          quote: c.quote!,
          ...(c.locator ? { locator: c.locator } : {}),
        });
      }
      // Evidence rows own the quotes and locators; card-level copies would
      // reintroduce the one-quote-next-to-every-page confusion.
      const { quote: _q, locator: _l, ...rest } = kept;
      return { ...rest, evidence };
    }

    // Legacy merge (non-document citations, or nothing cited/quoted):
    // first member's quote, union of member locators.
    const locators: string[] = [];
    for (const c of members) {
      if (c.locator && !locators.includes(c.locator)) locators.push(c.locator);
    }
    return {
      ...kept,
      ...(locators.length > 0 ? { locator: locators.join(', ') } : {}),
    };
  });
}
