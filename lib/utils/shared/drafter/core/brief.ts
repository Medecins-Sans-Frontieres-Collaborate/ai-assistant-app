/**
 * Brief transitions. The brief is reviewed once and every version is written
 * from it, so these are the only writes that can change what may be said.
 *
 * Pure functions over `Brief`. `rev` bumps on any change a version could
 * depend on; whether a given version is actually affected is decided by its
 * own digest (versions.ts), not by `rev`.
 */
import {
  hasMarkdownEscapes,
  markdownToProse,
} from '@/lib/utils/shared/markdown/markdownToProse';

import {
  Brief,
  BriefItem,
  BriefLink,
  BriefLinkRole,
  BriefVerification,
  DRAFTER_LIMITS,
  ExtractedItem,
} from '@/types/drafter';

export function emptyBrief(): Brief {
  return { rev: 0, keyMessage: '', items: [], links: [], language: '' };
}

function bump(brief: Brief, patch: Partial<Brief>): Brief {
  return { ...brief, ...patch, rev: brief.rev + 1 };
}

/** Quotes and testimony lead: the default is a human voice before numbers. */
const KIND_PRIORITY: Record<BriefItem['kind'], number> = {
  quote: 0,
  testimony: 1,
  fact: 2,
  context: 3,
  figure: 4,
};

function normalizedKey(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, ' ').trim();
}

/**
 * Adds extracted items after the existing ones, skipping repeats. New items
 * arrive undecided: what is said is an editorial choice even when it is
 * proven, so nothing is included on the model's behalf.
 */
export function addExtractedItems(
  brief: Brief,
  extracted: ExtractedItem[],
  ids: string[],
): Brief {
  const seen = new Set(brief.items.map((item) => normalizedKey(item.text)));
  const room = DRAFTER_LIMITS.MAX_BRIEF_ITEMS - brief.items.length;
  const fresh: BriefItem[] = [];
  for (const item of extracted) {
    if (fresh.length >= room) break;
    const text = item.text.trim().slice(0, DRAFTER_LIMITS.MAX_ITEM_CHARS);
    const key = normalizedKey(text);
    if (!text || seen.has(key)) continue;
    seen.add(key);
    fresh.push({ ...item, text, id: ids[fresh.length] ?? `i${seen.size}` });
  }
  if (fresh.length === 0) return brief;
  fresh.sort((a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind]);
  return bump(brief, { items: [...brief.items, ...fresh] });
}

/** An unverified item cannot be included until it is resolved. */
export function canInclude(item: BriefItem): boolean {
  return item.verified !== 'unverified';
}

export function setItemDecision(
  brief: Brief,
  itemId: string,
  decision: BriefItem['decision'],
): Brief {
  const item = brief.items.find((entry) => entry.id === itemId);
  if (!item || item.decision === decision) return brief;
  if (decision === 'included' && !canInclude(item)) return brief;
  return bump(brief, {
    items: brief.items.map((entry) =>
      entry.id === itemId ? { ...entry, decision } : entry,
    ),
  });
}

/** Includes every undecided item that was found in a source. Never touches
 * "Not found" rows, vouched rows or anything the user excluded. */
export function includeAllVerified(brief: Brief): Brief {
  const targets = brief.items.filter(
    (item) => item.verified === 'verbatim' && item.decision === undefined,
  );
  if (targets.length === 0) return brief;
  const ids = new Set(targets.map((item) => item.id));
  return bump(brief, {
    items: brief.items.map((item) =>
      ids.has(item.id) ? { ...item, decision: 'included' as const } : item,
    ),
  });
}

export function countIncludable(brief: Brief): number {
  return brief.items.filter(
    (item) => item.verified === 'verbatim' && item.decision === undefined,
  ).length;
}

/** "I vouch for this": an explicit, badged choice that follows the item. */
export function vouchForItem(brief: Brief, itemId: string): Brief {
  const item = brief.items.find((entry) => entry.id === itemId);
  if (!item || item.verified !== 'unverified') return brief;
  return bump(brief, {
    items: brief.items.map((entry) =>
      entry.id === itemId
        ? { ...entry, verified: 'user-asserted' as const, provenance: [] }
        : entry,
    ),
  });
}

/**
 * Edits an item's text. The include is cleared, so nothing the user signed
 * off is silently different from what they saw, and the caller passes the
 * verification the new text earns (re-checked against the source).
 */
export function editItemText(
  brief: Brief,
  itemId: string,
  text: string,
  verified: BriefVerification,
): Brief {
  const item = brief.items.find((entry) => entry.id === itemId);
  const next = text.slice(0, DRAFTER_LIMITS.MAX_ITEM_CHARS);
  if (!item || (item.text === next && item.verified === verified)) return brief;
  return bump(brief, {
    items: brief.items.map((entry) =>
      entry.id === itemId
        ? {
            ...entry,
            text: next,
            verified,
            decision:
              entry.decision === 'included' ? undefined : entry.decision,
            provenance: verified === 'verbatim' ? entry.provenance : [],
          }
        : entry,
    ),
  });
}

export function setItemAttribution(
  brief: Brief,
  itemId: string,
  attribution: BriefItem['attribution'],
): Brief {
  if (!brief.items.some((entry) => entry.id === itemId)) return brief;
  return bump(brief, {
    items: brief.items.map((entry) =>
      entry.id === itemId ? { ...entry, attribution } : entry,
    ),
  });
}

/**
 * An item made by selecting text in a source. Verbatim by construction, and
 * included at once: the user chose the words themselves.
 */
export function addItemFromSelection(
  brief: Brief,
  id: string,
  sourceId: string,
  selection: string,
  kind: BriefItem['kind'] = 'quote',
): Brief {
  const text = selection.trim().slice(0, DRAFTER_LIMITS.MAX_ITEM_CHARS);
  if (!text || brief.items.length >= DRAFTER_LIMITS.MAX_BRIEF_ITEMS) {
    return brief;
  }
  const item: BriefItem = {
    id,
    kind,
    text,
    provenance: [{ sourceId, excerpt: text }],
    verified: 'verbatim',
    decision: 'included',
  };
  return bump(brief, { items: [...brief.items, item] });
}

/**
 * Resolves a "Not found" item by pointing at its passage. Spoken words
 * become exactly the selection, so they are verbatim by construction. A
 * statement keeps its wording and takes the selection as evidence, which
 * only counts if every number the statement carries is written in it
 * (`supported`, decided by the caller with `numbersSupported`).
 */
export function resolveItemFromSelection(
  brief: Brief,
  itemId: string,
  sourceId: string,
  selection: string,
  supported: boolean,
): Brief {
  const item = brief.items.find((entry) => entry.id === itemId);
  const excerpt = selection.trim().slice(0, DRAFTER_LIMITS.MAX_ITEM_CHARS);
  if (!item || !excerpt) return brief;
  const spoken = item.kind === 'quote' || item.kind === 'testimony';
  if (!spoken && !supported) return brief;
  return bump(brief, {
    items: brief.items.map((entry) =>
      entry.id === itemId
        ? {
            ...entry,
            text: spoken ? excerpt : entry.text,
            verified: 'verbatim' as const,
            provenance: [{ sourceId, excerpt }],
            // The words may have changed, so the include is asked again.
            decision: spoken ? undefined : entry.decision,
          }
        : entry,
    ),
  });
}

/** A statement the user types themselves; vouched, since no source backs it. */
export function addOwnItem(
  brief: Brief,
  id: string,
  text: string,
  kind: BriefItem['kind'] = 'fact',
): Brief {
  const trimmed = text.trim().slice(0, DRAFTER_LIMITS.MAX_ITEM_CHARS);
  if (!trimmed || brief.items.length >= DRAFTER_LIMITS.MAX_BRIEF_ITEMS) {
    return brief;
  }
  return bump(brief, {
    items: [
      ...brief.items,
      {
        id,
        kind,
        text: trimmed,
        provenance: [],
        verified: 'user-asserted',
        decision: 'included',
      },
    ],
  });
}

export function removeItem(brief: Brief, itemId: string): Brief {
  if (!brief.items.some((entry) => entry.id === itemId)) return brief;
  return bump(brief, {
    items: brief.items.filter((entry) => entry.id !== itemId),
  });
}

/** Order is priority, so moving a row changes what the generator leads with. */
export function moveItem(brief: Brief, itemId: string, delta: -1 | 1): Brief {
  const from = brief.items.findIndex((entry) => entry.id === itemId);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= brief.items.length) return brief;
  const items = [...brief.items];
  [items[from], items[to]] = [items[to], items[from]];
  return bump(brief, { items });
}

export function setKeyMessage(brief: Brief, keyMessage: string): Brief {
  return brief.keyMessage === keyMessage ? brief : bump(brief, { keyMessage });
}

export function setCallToAction(brief: Brief, callToAction: string): Brief {
  const next = callToAction || undefined;
  return brief.callToAction === next
    ? brief
    : bump(brief, { callToAction: next });
}

/** Article first, the ask last: the final line is the primary call. */
const LINK_ORDER: Record<BriefLinkRole, number> = { article: 0, donation: 1 };

/** Longest address a brief link may carry, in its normalised form. */
export const MAX_LINK_URL_CHARS = 500;

/** Whitespace or a control character anywhere inside the address. */
// eslint-disable-next-line no-control-regex
const URL_UNSAFE = /[\s\u0000-\u001f\u007f-\u009f]/u;

/**
 * The address as the URL parser understood it, or null when it is not ONE
 * web address. The parsed form is what must be stored: the parser silently
 * drops an embedded newline or tab, so "https://a.org/x\nhttps://evil" is
 * valid to it while the raw string publishes as two links.
 */
export function normalizeHttpUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || URL_UNSAFE.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }
    const normalized = parsed.toString();
    return normalized.length <= MAX_LINK_URL_CHARS ? normalized : null;
  } catch {
    return null;
  }
}

export function isHttpUrl(value: string): boolean {
  return normalizeHttpUrl(value) !== null;
}

/** True when both are web addresses that normalise to the same one. */
export function sameHttpUrl(a: string, b: string): boolean {
  const left = normalizeHttpUrl(a);
  return left !== null && left === normalizeHttpUrl(b);
}

/**
 * Includes, replaces or (with `null`) removes the link of one role. An
 * address that is not a web URL is refused rather than published.
 */
export function setBriefLink(
  brief: Brief,
  role: BriefLinkRole,
  link: Omit<BriefLink, 'role'> | null,
): Brief {
  const current = brief.links.find((entry) => entry.role === role);
  if (!link) {
    return current
      ? bump(brief, { links: brief.links.filter((e) => e.role !== role) })
      : brief;
  }
  // Stored normalised, never as typed: see normalizeHttpUrl.
  const url = normalizeHttpUrl(link.url);
  if (!url) return brief;
  const label = link.label.trim().slice(0, 120);
  if (current && current.url === url && current.label === label) return brief;
  const links = [
    ...brief.links.filter((entry) => entry.role !== role),
    { role, label, url },
  ].sort((a, b) => LINK_ORDER[a.role] - LINK_ORDER[b.role]);
  return bump(brief, { links });
}

export function briefLink(
  brief: Pick<Brief, 'links'>,
  role: BriefLinkRole,
): BriefLink | undefined {
  return brief.links.find((entry) => entry.role === role);
}

export function includedItems(brief: Brief): BriefItem[] {
  return brief.items.filter((item) => item.decision === 'included');
}

export interface BriefCounts {
  included: number;
  /** Rows the user still has to look at: undecided, or "Not found". */
  needsYou: number;
}

export function briefCounts(brief: Brief): BriefCounts {
  return {
    included: includedItems(brief).length,
    needsYou: brief.items.filter((item) => item.decision === undefined).length,
  };
}

/**
 * Repairs a brief whose items were extracted from Markdown before pages
 * were converted to prose: "\[province\]" in an item or its excerpt was
 * never on the page. Returns the same brief when there is nothing to do.
 */
export function unescapeMarkdownInBrief(brief: Brief): Brief {
  let changed = false;
  const items = brief.items.map((item) => {
    const text = hasMarkdownEscapes(item.text)
      ? markdownToProse(item.text)
      : item.text;
    const provenance = item.provenance.map((entry) =>
      hasMarkdownEscapes(entry.excerpt)
        ? { ...entry, excerpt: markdownToProse(entry.excerpt) }
        : entry,
    );
    const touched =
      text !== item.text ||
      provenance.some((entry, i) => entry !== item.provenance[i]);
    if (!touched) return item;
    changed = true;
    return { ...item, text, provenance };
  });
  return changed ? { ...brief, items } : brief;
}
