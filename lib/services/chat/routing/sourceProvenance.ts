/**
 * Where a turn's sources came from, and how the reader is told.
 *
 * A turn can carry two kinds of sources at once: passages retrieved from an
 * agent's own documents, and public pages a web search found. Readers must
 * always be able to tell them apart — on the source cards (the `origin`
 * stamped here) and in the answer's own wording (the note built here).
 *
 * Pure data and text: no I/O, safe to import from tests.
 */
import type { Citation, CitationOrigin } from '@/types/rag';

/**
 * Stamps every citation with where it came from.
 *
 * @param citations - Citations of a single origin.
 * @param origin - 'knowledge' (an agent's documents) or 'web'.
 * @returns Copies of the citations carrying `origin`.
 */
export function withOrigin<T extends object>(
  citations: T[],
  origin: CitationOrigin,
): (T & { origin: CitationOrigin })[] {
  return citations.map((citation) => ({ ...citation, origin }));
}

/**
 * Appends web-search citations after the citations a turn already has
 * (knowledge passages first, then web), numbering them on from the last
 * existing one and stamping them as web sources.
 *
 * @param existing - Citations already on the turn, numbered 1..n.
 * @param web - The web search's citations, in result order.
 * @returns One list: `existing` unchanged, then `web` numbered n+1...
 */
export function mergeWebCitations<T extends object>(
  existing: Citation[],
  web: T[],
): (Citation | (T & { number: number; origin: CitationOrigin }))[] {
  return [
    ...existing,
    ...web.map((citation, index) => ({
      ...citation,
      number: existing.length + index + 1,
      origin: 'web' as const,
    })),
  ];
}

/** "[3]" for one number, "[1]–[10]" for a run, "[1], [4], [7]" otherwise. */
function citationSpan(numbers: number[]): string {
  if (numbers.length === 0) return '';
  const sorted = [...numbers].sort((a, b) => a - b);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === last) return `[${first}]`;
  const contiguous = last - first + 1 === sorted.length;
  return contiguous
    ? `[${first}]–[${last}]`
    : sorted.map((n) => `[${n}]`).join(', ');
}

/** What the knowledge search did this turn, as far as attribution goes. */
export type KnowledgeSearchOutcome = 'none' | 'searched' | 'failed';

/** Input to {@link sourceProvenanceNote}. */
export interface SourceProvenance {
  /** Citations already on the turn before the web search (any origin). */
  existing: Citation[];
  /** How many web citations are being added after them. */
  webCount: number;
  /**
   * 'none' when the turn has no knowledge search of its own (plain chat, a
   * persona without documents); otherwise whether that search ran or failed.
   */
  knowledgeSearch: KnowledgeSearchOutcome;
}

/**
 * The instruction that makes an answer say where each part comes from when
 * a web search ran on a turn that also has a knowledge base. Empty for
 * turns without one — a plain web-search answer has a single origin and
 * its source cards already show it.
 *
 * It asks for the KIND of source in the wording ("the agent's documents",
 * "a public web search"), which does not conflict with the standing rule
 * to keep URLs, titles and dates out of the answer text.
 *
 * @param provenance - The turn's existing citations and the web additions.
 * @returns Text to append to the web-results block, or ''.
 */
export function sourceProvenanceNote(provenance: SourceProvenance): string {
  const { existing, webCount, knowledgeSearch } = provenance;
  if (webCount <= 0) return '';
  const knowledgeNumbers = existing
    .filter((citation) => citation.origin === 'knowledge')
    .map((citation) => citation.number);
  if (knowledgeNumbers.length === 0 && knowledgeSearch === 'none') return '';

  const webNumbers = Array.from(
    { length: webCount },
    (_unused, index) => existing.length + index + 1,
  );
  const webSpan = citationSpan(webNumbers);
  const rule =
    'Never present a web finding as if it came from the documents, or the reverse.';

  if (knowledgeNumbers.length > 0) {
    return (
      `SOURCE ORIGIN: sources ${citationSpan(knowledgeNumbers)} are passages from this agent's own documents; sources ${webSpan} are public web pages found by a live web search. ` +
      'The reader must be able to tell the two apart from your wording: say which statements come from the documents and which come from the public web search. ' +
      'If the documents did not contain what was asked, say so plainly before giving what the web search found. ' +
      rule
    );
  }
  const miss =
    knowledgeSearch === 'failed'
      ? "the search of this agent's own documents could not run for this message"
      : "the search of this agent's own documents returned nothing for this message";
  return (
    `SOURCE ORIGIN: ${miss}; sources ${webSpan} are all public web pages found by a live web search. ` +
    "Say plainly that the answer comes from a public web search and not from the agent's documents. " +
    rule
  );
}

/**
 * The note placed next to the user's message on an agent turn that runs no
 * web search. Earlier turns of the same conversation may show web results
 * and their citation numbers; without this, a model imitates them and
 * cites pages nobody opened this turn.
 *
 * @param existing - The turn's citations (the agent's document passages).
 * @returns The note to prepend to the user's message.
 */
export function noWebSearchReminder(existing: Citation[]): string {
  const numbers = existing
    .filter((citation) => citation.origin === 'knowledge')
    .map((citation) => citation.number);
  const sources =
    numbers.length > 0
      ? `The only sources for this message are ${citationSpan(numbers)}, passages from this agent's own documents; cite no other number.`
      : 'There are no sources for this message; cite none.';
  return (
    `Note: NO web search was run for this message, whatever earlier messages in this conversation show. ${sources} ` +
    'Do not name or link any website or outside organisation as the source of a statement, and do not present anything as looked up online. ' +
    'If you add something from general knowledge, label it plainly as general knowledge that was not checked against any source and may be out of date.'
  );
}

/** Input to {@link agentWebSearchReason}. */
export interface AgentWebSearchTrigger {
  agentName: string;
  knowledgeSearch: KnowledgeSearchOutcome;
  /** The router's judgement of the retrieved passages, when it made one. */
  knowledgeBaseAnswers?: boolean;
  /** Websites the agent's instructions limit the search to. */
  sites: string[];
}

/**
 * States, for the reader of a turn's tool record, why an agent's turn went
 * to the public web and within which limits — the "how it was found" half
 * of source attribution.
 *
 * @param trigger - What decided the search.
 * @returns One or two plain sentences.
 */
export function agentWebSearchReason(trigger: AgentWebSearchTrigger): string {
  const { agentName, knowledgeSearch, sites } = trigger;
  let reason: string;
  if (
    knowledgeSearch === 'searched' &&
    trigger.knowledgeBaseAnswers === false
  ) {
    reason = `The documents of "${agentName}" did not contain the answer, and the agent's instructions allow a public web search for this question.`;
  } else if (knowledgeSearch === 'failed') {
    reason = `The documents of "${agentName}" could not be searched; a public web search ran under the agent's instructions.`;
  } else {
    reason = `A public web search ran for this question in addition to the documents of "${agentName}".`;
  }
  return sites.length > 0
    ? `${reason} Limited to: ${sites.join(', ')}.`
    : reason;
}
