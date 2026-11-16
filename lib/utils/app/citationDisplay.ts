import { Citation, CitationOrigin } from '@/types/rag';

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
        // A web page never merges into a document's card (or the reverse),
        // even when the two share a title: their origins must stay apart.
        group[0].origin === citation.origin &&
        ((group[0].url && citation.url && group[0].url === citation.url) ||
          (group[0].title &&
            citation.title &&
            group[0].title === citation.title)),
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

/** Source cards of one origin; `origin` is undefined for unlabelled cards. */
export interface SourceCardGroup {
  origin: CitationOrigin | undefined;
  cards: SourceCard[];
}

/** Display order of the groups: the agent's documents before the web. */
const ORIGIN_ORDER: (CitationOrigin | undefined)[] = [
  'knowledge',
  'web',
  undefined,
];

/**
 * Splits source cards by where they came from, so the list can show an
 * agent's own documents and public web pages under separate headings.
 * Cards keep their order within a group; empty groups are dropped. Cards
 * without an origin (messages stored before origins were recorded) form a
 * last, unlabelled group.
 *
 * @param cards - Cards from {@link buildSourceCards}.
 * @returns Non-empty groups: documents, then web, then unlabelled.
 */
export function groupSourceCardsByOrigin(
  cards: SourceCard[],
): SourceCardGroup[] {
  return ORIGIN_ORDER.map((origin) => ({
    origin,
    cards: cards.filter((card) => card.origin === origin),
  })).filter((group) => group.cards.length > 0);
}
