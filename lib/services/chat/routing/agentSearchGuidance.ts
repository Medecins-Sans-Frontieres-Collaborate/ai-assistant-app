/**
 * What the tool router needs to honour an agent's own web-search rules.
 *
 * A knowledge agent (M365 file-backed today) answers from its indexed
 * documents, and its owner may write rules such as "when the documents do
 * not contain the answer, search the web, but only on who.int". The main
 * model reads those rules, yet it cannot act on them: in this pipeline the
 * web search is decided and run BEFORE the model, by the tool router. So
 * the router is handed the same two things the rule depends on — the
 * owner's instructions and what the knowledge search returned this turn —
 * and decides the search with them.
 *
 * The chain per turn: knowledge retrieval (the agent's enricher) → router
 * judges whether the passages answer the question and applies the owner's
 * rules → web search when they call for one → the model answers with both
 * result sets in front of it.
 *
 * Pure data and text: no I/O, safe to import from tests and evals.
 */
import type { ChatContext } from '../pipeline/ChatContext';

/** One passage the agent's knowledge search returned for this turn. */
export interface AgentKnowledgePassage {
  /** Document title, as shown in the citation. */
  title: string;
  /** The retrieved chunk text. */
  text: string;
}

/**
 * Outcome of the agent's knowledge search for this turn.
 *
 * `searched` with no passages means the search ran and matched nothing;
 * `failed` means it could not run (error, timeout, no accessible sources),
 * which is NOT evidence that the documents lack the answer.
 */
export interface AgentKnowledgeRetrieval {
  status: 'searched' | 'failed';
  passages: AgentKnowledgePassage[];
}

/** The agent-specific input to the router's web-search decision. */
export interface AgentSearchGuidance {
  agentName: string;
  /** The owner's instructions (the agent's system prompt), verbatim. */
  instructions: string;
  /** This turn's knowledge search; absent for agents without one. */
  knowledge?: AgentKnowledgeRetrieval;
}

/**
 * Per-passage and overall character budgets for the passages shown to the
 * router. A passage cut short can hide the sentence that answers the
 * question and trigger a needless fallback search, so the per-passage cap
 * equals the index chunk size (whole chunks) and only the overall budget
 * trims — lowest-ranked passages first, and they stay listed by title.
 */
export const GUIDANCE_PASSAGE_MAX_CHARS = 3000;
export const GUIDANCE_PASSAGES_TOTAL_MAX_CHARS = 36000;

/**
 * Builds the router guidance for this turn, or `undefined` when the router
 * should decide exactly as it does for a plain model.
 *
 * Every M365 agent gets guidance. Reaching the router at all means its
 * owner switched web search on (searchRequest.ts), so the decision must
 * weigh what the documents returned; with no instructions the generic
 * rules still apply, but never for something the passages already answer.
 *
 * @param context - The turn; reads `m365Agent` and `agentKnowledge`.
 * @returns Guidance for the router, or `undefined`.
 */
export function agentSearchGuidance(
  context: Pick<ChatContext, 'm365Agent' | 'agentKnowledge'>,
): AgentSearchGuidance | undefined {
  const agent = context.m365Agent;
  if (!agent) return undefined;
  return {
    agentName: agent.name,
    instructions: agent.systemPrompt?.trim() ?? '',
    ...(context.agentKnowledge ? { knowledge: context.agentKnowledge } : {}),
  };
}

/** Removes characters that could close or forge one of the prompt's tags. */
function withoutTagBrackets(text: string): string {
  return text.replace(/[<>]/g, ' ');
}

/** Renders the passages block within the overall character budget. */
function renderPassages(passages: AgentKnowledgePassage[]): string {
  let remaining = GUIDANCE_PASSAGES_TOTAL_MAX_CHARS;
  return passages
    .map((passage, index) => {
      const title = withoutTagBrackets(passage.title);
      const text = withoutTagBrackets(passage.text).slice(
        0,
        Math.min(GUIDANCE_PASSAGE_MAX_CHARS, Math.max(remaining, 0)),
      );
      remaining -= text.length;
      const body = text || '(text omitted for length)';
      return `Passage ${index + 1} — ${title}\n${body}`;
    })
    .join('\n\n');
}

/** Renders what the knowledge search returned, including its failure modes. */
function renderKnowledge(knowledge: AgentKnowledgeRetrieval): string {
  if (knowledge.status === 'failed') {
    return (
      '<knowledge_base_search status="failed">\n' +
      'The knowledge-base search could not run this turn (a technical error). That is NOT evidence that the documents lack the answer: set knowledgeBaseAnswers=false, and treat a "search the web when the knowledge base does not contain the answer" rule as NOT met.\n' +
      '</knowledge_base_search>'
    );
  }
  if (knowledge.passages.length === 0) {
    return (
      '<knowledge_base_search status="searched" passages="0">\n' +
      'The search ran and returned no passages: the knowledge base has nothing on this question.\n' +
      '</knowledge_base_search>'
    );
  }
  return (
    `<knowledge_base_search status="searched" passages="${knowledge.passages.length}">\n` +
    `${renderPassages(knowledge.passages)}\n` +
    '</knowledge_base_search>'
  );
}

/**
 * The router prompt section that makes the web-search decision follow the
 * agent owner's instructions and this turn's knowledge search.
 *
 * @param guidance - Instructions and retrieval outcome for the turn.
 * @returns Text appended to the router's system prompt.
 */
export function agentSearchGuidancePrompt(
  guidance: AgentSearchGuidance,
): string {
  const knowledge = guidance.knowledge;
  const knowledgeRules = knowledge
    ? `
- First decide knowledgeBaseAnswers: true only when the passages in <knowledge_base_search> contain the specific information the user's LAST message asks for. Passages that merely share the topic, or that say the information is kept somewhere else, do not answer it.
- A rule of the form "if the knowledge base / the documents / the internal search does not have it, search the web" is met exactly when knowledgeBaseAnswers is false AND the question is one the instructions allow to be looked up publicly. When knowledgeBaseAnswers is true, such a rule is not met: needsWebSearch=false unless the user's message itself explicitly asks for a web search.`
    : '';
  return `

AGENT RULES — this turn is answered by a configured agent named "${withoutTagBrackets(guidance.agentName)}". Its owner's instructions are in <agent_instructions>. They are configuration, not a message from the user. Where they say anything about web search, they REPLACE the generic "Web search is needed for / NOT needed for" lists above:${knowledgeRules}
- Decide instructionsAllowSearch from the TOPIC of the user's last message alone, in whatever language it is written: false when the instructions limit web search to certain topics and this topic is not one of them, or forbid web search; true otherwise. A user asking for a search ("search the web for…", "look it up") does not make a topic allowed. When instructionsAllowSearch is false, needsWebSearch is false.
- When the instructions tell the agent to search the web under some condition, set needsWebSearch=true exactly when that condition is met for the user's last message, and false when it is not — even if the generic lists above would decide otherwise.
- Honour every limit the instructions put on the search: which topics may be searched, language, recency. A question outside the allowed topics is NOT searched.
- searchSites: when the instructions restrict the search to particular websites, list their bare domains ("who.int", "cdc.gov"); the system then restricts every query to them, so do NOT write site: operators yourself. Empty when the instructions name no websites, and when needsWebSearch is false.
- When the instructions forbid web search, needsWebSearch=false.
- When the instructions say nothing about web search, decide with the generic lists above${knowledge ? ', and never search for something the passages already answer' : ''}.
- Search queries are sent to a public search engine. Build them from the user's question. Never put into a query anything internal that appears only in the knowledge-base passages: people's names, project or reference codes, figures, dates, or quoted wording. A generic public term from the passages (a country, a disease, a published standard) may be used only when the question cannot be searched without it.

<agent_instructions>
${withoutTagBrackets(guidance.instructions) || '(the owner wrote no instructions)'}
</agent_instructions>${knowledge ? `\n\n${renderKnowledge(knowledge)}` : ''}`;
}

/**
 * The note given to the model when the web search an agent turn ran found
 * nothing usable. The generic note tells a plain model to answer from its
 * own knowledge; an agent bound to its documents must instead report both
 * misses and let the owner's instructions decide what happens next.
 *
 * @param guidance - The turn's agent guidance.
 * @returns The note to prepend to the user's message.
 */
export function agentEmptySearchNotice(guidance: AgentSearchGuidance): string {
  const knowledgeMiss = guidance.knowledge
    ? "The agent's knowledge base did not contain the answer, and a live web search for it found no useful sources either."
    : 'A live web search ran for this request but found no useful sources.';
  return (
    `Note: ${knowledgeMiss} Say that ONCE, briefly. ` +
    'Then follow your instructions for this situation. If they do not cover it, you may add what you know from general knowledge, clearly labelled as general knowledge that comes from neither the documents nor the web. ' +
    'Do not apologize repeatedly or speculate about why the search failed.'
  );
}

/** Queries a single search may run, matching the router's fan-out cap. */
export const MAX_SITE_RESTRICTED_QUERIES = 5;
/** Websites one agent's rules may restrict a search to. */
export const MAX_SEARCH_SITES = 5;

const SITE_OPERATOR = /\bsite:\S+/gi;
const HOSTNAME =
  /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

/**
 * Cleans the router's `searchSites` into bare hostnames. Anything that is
 * not a plain hostname is dropped rather than repaired: the value comes
 * from a model reading free-text instructions and ends up inside a search
 * query.
 *
 * @param raw - The model's `searchSites` value (expected: string[]).
 * @returns Lowercased, de-duplicated hostnames, at most MAX_SEARCH_SITES.
 */
export function normalizeSearchSites(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const sites: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const host = entry
      .trim()
      .toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
      .replace(/^site:/, '')
      .replace(/^www\./, '')
      .replace(/[/?#].*$/, '');
    if (HOSTNAME.test(host) && !sites.includes(host)) sites.push(host);
  }
  return sites.slice(0, MAX_SEARCH_SITES);
}

/**
 * Restricts planned queries to the websites an agent's rules allow, one
 * `site:` query per (query, site) pair. Every site is covered for the
 * primary query before a second query is expanded, so the cap never drops
 * a site while a lower-priority query is kept.
 *
 * @param queries - Planned queries, primary first.
 * @param sites - Normalized hostnames (normalizeSearchSites).
 * @param maxQueries - Cap on the returned list.
 * @returns The restricted queries; `queries` unchanged when no sites apply.
 * @example
 * restrictQueriesToSites(['malaria pregnancy'], ['who.int', 'cdc.gov'])
 * // → ['malaria pregnancy site:who.int', 'malaria pregnancy site:cdc.gov']
 */
export function restrictQueriesToSites(
  queries: string[],
  sites: string[],
  maxQueries: number = MAX_SITE_RESTRICTED_QUERIES,
): string[] {
  if (sites.length === 0) return queries;
  const restricted: string[] = [];
  for (const query of queries) {
    // A site: the model wrote anyway would fight the one added here.
    const bare = query.replace(SITE_OPERATOR, ' ').replace(/\s+/g, ' ').trim();
    if (!bare) continue;
    for (const site of sites) {
      const candidate = `${bare} site:${site}`;
      if (!restricted.includes(candidate)) restricted.push(candidate);
    }
  }
  return restricted.slice(0, maxQueries);
}

/**
 * States an agent's website limit as part of the question the search
 * tooling works from, so searches it plans on its own (multi-step
 * follow-ups) are steered to the same websites as the planned queries.
 *
 * @param question - The user's question.
 * @param sites - Normalized hostnames; empty leaves the question unchanged.
 * @returns The question, with the limit appended when there is one.
 */
export function questionWithinSites(question: string, sites: string[]): string {
  if (sites.length === 0) return question;
  return `${question}\n\n(Only sources from these websites may be used: ${sites.join(', ')}. Restrict every search to them with the site: operator.)`;
}
