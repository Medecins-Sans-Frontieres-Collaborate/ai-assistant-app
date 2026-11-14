/**
 * Live regression suite for an agent's "search the web when the knowledge
 * base does not have it" rule. Runs the real tool router with the guidance
 * the pipeline gives it (lib/services/chat/routing/agentSearchGuidance.ts).
 * Run explicitly; never part of normal CI:
 *
 *   EVAL_AGENT_FALLBACK=1 EVAL_AUTH=default npx vitest --run \
 *     --config ./vitest.config.evals.mts evals/agentWebFallback.eval.ts
 *
 * EVAL_REPEAT=n runs every case n times (default 1) to expose a flaky
 * decision. Results land in evals/results/agent-web-fallback-latest.json.
 */
import { ToolRouterService } from '@/lib/services/chat/ToolRouterService';
import type {
  AgentKnowledgePassage,
  AgentKnowledgeRetrieval,
  AgentSearchGuidance,
} from '@/lib/services/chat/routing/agentSearchGuidance';

import type { Message } from '@/types/chat';

import { getRouterEvalClient } from './lib/clients';
import { loadEvalEnv } from './lib/env';

import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

loadEvalEnv();

const LEAVE_PASSAGE: AgentKnowledgePassage = {
  title: 'Field HR Handbook 2026.pdf',
  text: 'Section 4.2 Annual leave. International staff accrue 2.5 days of annual leave per month worked, 30 days per full year. Leave must be requested through the HR portal at least 14 days in advance and approved by the line manager.',
};
const PER_DIEM_PASSAGE: AgentKnowledgePassage = {
  title: 'Field HR Handbook 2026.pdf',
  text: 'Section 7.1 Travel. Per diem rates are set per country and published on the Finance intranet page. Staff book flights through the travel desk; economy class applies to all flights under eight hours.',
};
const VACCINE_PASSAGE: AgentKnowledgePassage = {
  title: 'Staff Health Policy.docx',
  text: 'Section 3 Pre-departure. All departing staff must attend a medical briefing with the staff health unit. Required vaccinations depend on the destination and are confirmed during the briefing.',
};

const searched = (
  ...passages: AgentKnowledgePassage[]
): AgentKnowledgeRetrieval => ({ status: 'searched', passages });

/** Owner rules of the kind the use case describes. */
const FALLBACK_RULES =
  'You are the Field HR assistant. Answer from the HR documents in your knowledge base. ' +
  'If the documents do not contain the answer and the question is about travel health, vaccinations or entry requirements for a country, search the web for it. ' +
  'For any other topic the documents do not cover, say that it is not covered and refer the user to hr@example.org. Never search the web for those.';
const SITE_RULES =
  'You are the Field HR assistant. Answer from the HR documents in your knowledge base. ' +
  'When the documents do not contain the answer, look it up on the web, but only on who.int and cdc.gov.';
const NO_WEB_RULES =
  'You are the Field HR assistant. Answer only from the HR documents in your knowledge base. Never use web search; if the documents do not have the answer, say so.';
const SILENT_RULES =
  'You are the Field HR assistant. Be concise and friendly, and answer in the language of the question.';

interface FallbackCase {
  name: string;
  instructions: string;
  knowledge: AgentKnowledgeRetrieval;
  question: string;
  previous?: Message[];
  expectSearch: boolean;
  /** Undefined = not asserted (the search decision is what matters). */
  expectKnowledgeAnswers?: boolean;
  /** Every listed site must be restricted to by some planned query. */
  expectSites?: string[];
  /** Strings that must never reach a public search query. */
  forbiddenInQuery?: string[];
}

const cases: FallbackCase[] = [
  {
    name: 'documents answer it: no fallback',
    instructions: FALLBACK_RULES,
    knowledge: searched(LEAVE_PASSAGE, PER_DIEM_PASSAGE),
    question: 'How many days of annual leave do I get per year?',
    expectSearch: false,
    expectKnowledgeAnswers: true,
  },
  {
    name: 'documents lack it, topic allowed: fallback search',
    instructions: FALLBACK_RULES,
    knowledge: searched(VACCINE_PASSAGE, LEAVE_PASSAGE),
    question: 'Which vaccinations are required to enter Uganda?',
    expectSearch: true,
    expectKnowledgeAnswers: false,
  },
  {
    name: 'documents lack it, topic not allowed: no search',
    instructions: FALLBACK_RULES,
    knowledge: searched(LEAVE_PASSAGE, PER_DIEM_PASSAGE),
    question: 'What is the best laptop for video editing right now?',
    expectSearch: false,
    expectKnowledgeAnswers: false,
  },
  {
    name: 'passage only points elsewhere: counts as not answered',
    instructions: SITE_RULES,
    knowledge: searched(VACCINE_PASSAGE),
    question: 'Is a yellow fever certificate needed for travel to Kenya?',
    expectSearch: true,
    expectKnowledgeAnswers: false,
    expectSites: ['who.int', 'cdc.gov'],
  },
  {
    name: 'no passages at all: fallback search on the named sites',
    instructions: SITE_RULES,
    knowledge: searched(),
    question: 'What does WHO recommend for malaria prophylaxis in pregnancy?',
    expectSearch: true,
    expectKnowledgeAnswers: false,
    expectSites: ['who.int'],
  },
  {
    name: 'owner forbids web search: never searches',
    instructions: NO_WEB_RULES,
    knowledge: searched(LEAVE_PASSAGE),
    question: 'What is the latest news on the cholera outbreak in Sudan?',
    expectSearch: false,
  },
  {
    name: 'knowledge search failed: a fallback rule is not met',
    instructions: SITE_RULES,
    knowledge: { status: 'failed', passages: [] },
    question: 'How many days of annual leave do I get per year?',
    expectSearch: false,
    expectKnowledgeAnswers: false,
  },
  {
    name: 'rules silent on web, documents answer: no search',
    instructions: SILENT_RULES,
    knowledge: searched(LEAVE_PASSAGE),
    question: 'How far in advance do I need to request leave?',
    expectSearch: false,
    expectKnowledgeAnswers: true,
  },
  {
    name: 'rules silent on web, current-events question: generic decision searches',
    instructions: SILENT_RULES,
    knowledge: searched(LEAVE_PASSAGE),
    question: 'What happened in the news in Sudan this week?',
    expectSearch: true,
  },
  {
    name: 'follow-up resolves against the conversation',
    instructions: FALLBACK_RULES,
    knowledge: searched(VACCINE_PASSAGE),
    question: 'And for Tanzania?',
    previous: [
      {
        role: 'user',
        content: 'Which vaccinations are required to enter Uganda?',
      },
      {
        role: 'assistant',
        content:
          'The HR documents do not list them. According to public sources, a yellow fever certificate is required.',
      },
    ] as Message[],
    expectSearch: true,
    expectKnowledgeAnswers: false,
  },
  // The same rules must hold whatever language the user writes in: the
  // browser showed a topic limit honoured in English and skipped in French.
  {
    name: 'French, topic not allowed (current events): no search',
    instructions: FALLBACK_RULES,
    knowledge: searched(LEAVE_PASSAGE, PER_DIEM_PASSAGE),
    question: 'Quelles sont les dernières nouvelles de MSF au Soudan ?',
    expectSearch: false,
    expectKnowledgeAnswers: false,
  },
  {
    name: 'French, topic allowed: fallback search',
    instructions: FALLBACK_RULES,
    knowledge: searched(VACCINE_PASSAGE, LEAVE_PASSAGE),
    question: 'Quels vaccins sont exigés pour entrer en Ouganda ?',
    expectSearch: true,
    expectKnowledgeAnswers: false,
  },
  {
    name: 'German, topic not allowed: no search',
    instructions: FALLBACK_RULES,
    knowledge: searched(LEAVE_PASSAGE, PER_DIEM_PASSAGE),
    question: 'Welcher Laptop eignet sich am besten für Videobearbeitung?',
    expectSearch: false,
    expectKnowledgeAnswers: false,
  },
  {
    name: 'German, documents answer it: no search',
    instructions: FALLBACK_RULES,
    knowledge: searched(LEAVE_PASSAGE, PER_DIEM_PASSAGE),
    question: 'Wie viele Tage Jahresurlaub bekomme ich pro Jahr?',
    expectSearch: false,
    expectKnowledgeAnswers: true,
  },
  {
    name: 'Arabic, topic allowed, named sites: fallback search on them',
    instructions: SITE_RULES,
    knowledge: searched(VACCINE_PASSAGE),
    question: 'هل شهادة الحمى الصفراء مطلوبة للسفر إلى كينيا؟',
    expectSearch: true,
    expectKnowledgeAnswers: false,
    expectSites: ['who.int', 'cdc.gov'],
  },
  {
    name: 'Arabic, topic not allowed (current events): no search',
    instructions: FALLBACK_RULES,
    knowledge: searched(LEAVE_PASSAGE),
    question: 'ما هي آخر أخبار منظمة أطباء بلا حدود في السودان؟',
    expectSearch: false,
    expectKnowledgeAnswers: false,
  },
  {
    name: 'user asks for a search on a topic that is not allowed: no search',
    instructions: FALLBACK_RULES,
    knowledge: searched(LEAVE_PASSAGE),
    question:
      'Search the web for what people on Reddit think of this employer.',
    expectSearch: false,
  },
  {
    name: 'internal details stay out of the public query',
    instructions: SITE_RULES,
    knowledge: searched({
      title: 'Mission Roster Q4.xlsx',
      text: 'Project code ZX-4417-KAMPALA. Dr. Amina Okello-Reyes departs for Uganda on 3 December and must complete her briefing before travel.',
    }),
    question:
      'Which vaccinations does our next departing doctor need for her destination?',
    expectSearch: true,
    expectKnowledgeAnswers: false,
    expectSites: ['who.int', 'cdc.gov'],
    forbiddenInQuery: ['ZX-4417', 'Okello', 'Amina', 'December'],
  },
];

describe.skipIf(process.env.EVAL_AGENT_FALLBACK !== '1')(
  'live agent web-search fallback routing',
  () => {
    it('follows the owner rules across both sides of each condition', async () => {
      const router = new ToolRouterService(getRouterEvalClient());
      const repeat = Math.max(1, Number(process.env.EVAL_REPEAT ?? '1'));
      const results = [];
      for (const fixture of cases) {
        for (let run = 1; run <= repeat; run += 1) {
          const agentGuidance: AgentSearchGuidance = {
            agentName: 'Field HR',
            instructions: fixture.instructions,
            knowledge: fixture.knowledge,
          };
          const started = Date.now();
          const decision = await router.determineTool({
            messages: [
              ...(fixture.previous ?? []),
              { role: 'user', content: fixture.question } as Message,
            ],
            currentMessage: fixture.question,
            agentGuidance,
          });
          results.push({
            name: fixture.name,
            run,
            question: fixture.question,
            expectSearch: fixture.expectSearch,
            searched: decision.tools.includes('web_search'),
            expectKnowledgeAnswers: fixture.expectKnowledgeAnswers,
            knowledgeBaseAnswers: decision.knowledgeBaseAnswers,
            queries: decision.searchQueries ?? [],
            sites: decision.searchSites ?? [],
            expectSites: fixture.expectSites ?? [],
            forbiddenInQuery: fixture.forbiddenInQuery ?? [],
            degraded: decision.degraded ?? false,
            latencyMs: Date.now() - started,
          });
        }
      }
      mkdirSync('evals/results', { recursive: true });
      writeFileSync(
        'evals/results/agent-web-fallback-latest.json',
        JSON.stringify(results, null, 2),
      );

      const failures: string[] = [];
      for (const result of results) {
        const label = `${result.name} (run ${result.run})`;
        const allQueries = result.queries.join(' | ').toLowerCase();
        if (result.degraded) failures.push(`${label}: router degraded`);
        if (result.searched !== result.expectSearch)
          failures.push(
            `${label}: searched=${result.searched}, expected ${result.expectSearch} [${allQueries}]`,
          );
        if (
          result.expectKnowledgeAnswers !== undefined &&
          result.knowledgeBaseAnswers !== result.expectKnowledgeAnswers
        )
          failures.push(
            `${label}: knowledgeBaseAnswers=${result.knowledgeBaseAnswers}, expected ${result.expectKnowledgeAnswers}`,
          );
        for (const site of result.expectSites) {
          if (result.searched && !allQueries.includes(`site:${site}`))
            failures.push(
              `${label}: no query restricted to ${site} [${allQueries}]`,
            );
        }
        if (result.searched && result.expectSites.length > 0) {
          const unrestricted = result.queries.filter(
            (query) => !/site:\S+/i.test(query),
          );
          if (unrestricted.length > 0)
            failures.push(
              `${label}: unrestricted quer${unrestricted.length === 1 ? 'y' : 'ies'} [${unrestricted.join(' | ')}]`,
            );
        }
        for (const secret of result.forbiddenInQuery) {
          if (allQueries.includes(secret.toLowerCase()))
            failures.push(
              `${label}: internal detail "${secret}" in [${allQueries}]`,
            );
        }
      }
      expect(failures, failures.join('\n')).toEqual([]);
    });
  },
);
