import {
  MultiStepDeps,
  MultiStepParams,
  buildMultiStepDigest,
  buildOutcomeNote,
  focusExcerpt,
  focusTerms,
  isOffQuery,
  nameSources,
  phraseQueryFor,
  runMultiStepSearch,
  toPriorSearchState,
} from '@/lib/services/chat/tools/multiStepSearch';
import {
  AssessmentInput,
  SearchAssessment,
} from '@/lib/services/chat/tools/searchAssessor';
import { MULTI_STEP_DEFAULTS } from '@/lib/services/webSearch/config/types';

import { SearchHeadlineEntry } from '@/types/webSearch';

import { describe, expect, it, vi } from 'vitest';

const entry = (id: string, snippet = `snippet ${id}`): SearchHeadlineEntry => ({
  title: `Title ${id}`,
  url: `https://example.org/${id}`,
  date: '',
  sourceName: 'example.org',
  snippet,
});

const verdict = (
  partial: Partial<SearchAssessment> & Pick<SearchAssessment, 'verdict'>,
): SearchAssessment => ({
  reason: '',
  queries: [],
  recency: 'any',
  readSources: [],
  question: '',
  exploratory: false,
  useful: [],
  sourceQuality: [],
  caveat: '',
  ...partial,
});

const LONG_PAGE = 'Readable page body. '.repeat(30);

function setup(
  assessments: Array<SearchAssessment | null>,
  overrides: Partial<MultiStepParams> = {},
  depOverrides: Partial<MultiStepDeps> = {},
) {
  let clock = 1_000;
  const inputs: AssessmentInput[] = [];
  const deps: MultiStepDeps = {
    search: vi.fn(async (queries: string[]) => ({
      entries: queries.map((query) => entry(`found-${query}`)),
      answers: [],
    })),
    readPage: vi.fn(async () => LONG_PAGE),
    assess: vi.fn(async (input: AssessmentInput) => {
      inputs.push(input);
      return assessments.shift() ?? null;
    }),
    onActivity: vi.fn(),
    onStep: vi.fn(),
    onProgress: vi.fn(),
    now: () => clock,
    ...depOverrides,
  };
  const params: MultiStepParams = {
    question: 'where can I buy this rare book',
    recentContext: [],
    initialQueries: ['rare book'],
    initial: { entries: [entry('a'), entry('b'), entry('c')], answers: [] },
    resultCount: 8,
    config: { ...MULTI_STEP_DEFAULTS },
    deadline: 1_000 + 90_000,
    ...overrides,
  };
  return {
    deps,
    params,
    inputs,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('runMultiStepSearch', () => {
  it('stops after ONE assessment when the first results answer the question', async () => {
    const { deps, params } = setup([verdict({ verdict: 'answer' })]);
    const result = await runMultiStepSearch(params, deps);

    expect(result.outcome).toBe('answered');
    expect(result.stepsUsed).toBe(1);
    expect(deps.assess).toHaveBeenCalledTimes(1);
    expect(deps.search).not.toHaveBeenCalled();
    expect(deps.readPage).not.toHaveBeenCalled();
    expect(result.entries.map((e) => e.url)).toEqual([
      'https://example.org/a',
      'https://example.org/b',
      'https://example.org/c',
    ]);
    expect(buildOutcomeNote(result)).toBe('');
  });

  it('searches again with the assessor’s queries, then answers', async () => {
    const { deps, params, inputs } = setup([
      verdict({
        verdict: 'search',
        reason: 'no seller listed',
        queries: ['rare book antiquarian seller'],
        category: 'general',
      }),
      verdict({ verdict: 'answer', useful: [4, 1] }),
    ]);
    const result = await runMultiStepSearch(params, deps);

    expect(result.outcome).toBe('answered');
    expect(result.stepsUsed).toBe(2);
    expect(result.searchCount).toBe(2);
    expect(deps.search).toHaveBeenCalledWith(
      ['rare book antiquarian seller'],
      expect.objectContaining({ category: 'general', resultCount: 6 }),
    );
    // The second assessment sees the new source, numbered after the first 3.
    expect(inputs[1].sources).toHaveLength(4);
    expect(inputs[1].steps).toHaveLength(2);
    // The assessor's ranking leads the final list.
    expect(result.entries[0].url).toBe(
      'https://example.org/found-rare book antiquarian seller',
    );
    expect(result.entries[1].url).toBe('https://example.org/a');
    expect(deps.onStep).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'search',
        why: 'no seller listed',
        outcome: '1 new source found',
      }),
    );
    // Everything gathered so far, for the interim panel.
    expect(deps.onProgress).toHaveBeenCalledTimes(1);
    expect(
      (deps.onProgress as ReturnType<typeof vi.fn>).mock.calls[0][0],
    ).toHaveLength(4);
  });

  it('reads the pages the assessor picks and carries their text into the digest', async () => {
    const { deps, params, inputs } = setup([
      verdict({
        verdict: 'read',
        reason: 'policy text needed',
        readSources: [2],
      }),
      verdict({ verdict: 'answer', useful: [2] }),
    ]);
    const result = await runMultiStepSearch(params, deps);

    expect(deps.readPage).toHaveBeenCalledTimes(1);
    expect(deps.readPage).toHaveBeenCalledWith('https://example.org/b');
    expect(result.pagesRead).toBe(1);
    expect(inputs[1].sources[1].pageExcerpt).toContain('Readable page body');

    const digest = buildMultiStepDigest(result);
    expect(digest.citations[0]).toMatchObject({
      number: 1,
      url: 'https://example.org/b',
    });
    expect(digest.text).toContain('Text read from this page:');
    expect(digest.text).toContain('with text read from the page itself');
  });

  it('never exceeds the step cap: the last assessment must conclude', async () => {
    const { deps, params, inputs } = setup(
      [
        verdict({ verdict: 'search', queries: ['q two'], reason: 'missing x' }),
        verdict({
          verdict: 'search',
          queries: ['q three'],
          reason: 'missing x',
        }),
        // Told no steps remain, the assessor still asks for more.
        verdict({ verdict: 'search', queries: ['q four'], reason: 'still x' }),
      ],
      {
        config: { ...MULTI_STEP_DEFAULTS, maxSteps: 3, maxStepsExploratory: 3 },
      },
    );
    const result = await runMultiStepSearch(params, deps);

    expect(deps.search).toHaveBeenCalledTimes(2);
    expect(result.stepsUsed).toBe(3);
    expect(inputs.map((i) => i.stepsRemaining)).toEqual([2, 1, 0]);
    expect(result.outcome).toBe('limit');
    expect(buildOutcomeNote(result)).toContain('still missing: still x');
  });

  it('gives an exploratory hunt the higher cap', async () => {
    const hunt = (query: string) =>
      verdict({ verdict: 'search', queries: [query], exploratory: true });
    const { deps, params } = setup(
      [
        hunt('q2'),
        hunt('q3'),
        hunt('q4'),
        hunt('q5'),
        verdict({ verdict: 'answer' }),
      ],
      {
        config: { ...MULTI_STEP_DEFAULTS, maxSteps: 2, maxStepsExploratory: 5 },
      },
    );
    const result = await runMultiStepSearch(params, deps);

    expect(result.stepsUsed).toBe(5);
    expect(deps.search).toHaveBeenCalledTimes(4);
    expect(result.outcome).toBe('answered');
  });

  it('ends when the assessor only proposes queries that already ran', async () => {
    const { deps, params } = setup([
      verdict({
        verdict: 'search',
        queries: ['Rare  Book'],
        reason: 'nothing new',
      }),
    ]);
    const result = await runMultiStepSearch(params, deps);

    expect(deps.search).not.toHaveBeenCalled();
    expect(result.outcome).toBe('limit');
  });

  it('ends after two consecutive dead ends', async () => {
    const { deps, params } = setup(
      [
        verdict({ verdict: 'search', queries: ['q2'], strategy: 'terms' }),
        verdict({ verdict: 'search', queries: ['q3'], strategy: 'entity' }),
        verdict({ verdict: 'search', queries: ['q4'], strategy: 'venue' }),
      ],
      {
        config: { ...MULTI_STEP_DEFAULTS, maxSteps: 8, maxStepsExploratory: 8 },
      },
      { search: vi.fn(async () => ({ entries: [], answers: [] })) },
    );
    const result = await runMultiStepSearch(params, deps);

    expect(deps.search).toHaveBeenCalledTimes(2);
    expect(result.outcome).toBe('limit');
    expect(result.stopReason).toBe('dead_ends');
    expect(result.deadEndStrategies).toEqual(['terms', 'entity']);
  });

  it('refuses a strategy that already dead-ended, so the assessor must change approach', async () => {
    const { deps, params } = setup(
      [
        verdict({ verdict: 'search', queries: ['q2'], strategy: 'terms' }),
        verdict({ verdict: 'search', queries: ['q3'], strategy: 'terms' }),
      ],
      {
        config: { ...MULTI_STEP_DEFAULTS, maxSteps: 8, maxStepsExploratory: 8 },
      },
      { search: vi.fn(async () => ({ entries: [], answers: [] })) },
    );
    const result = await runMultiStepSearch(params, deps);

    expect(deps.search).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe('strategy');
  });

  it('does not re-read a page and marks unreadable ones for the assessor', async () => {
    const { deps, params, inputs } = setup(
      [
        verdict({ verdict: 'read', readSources: [1] }),
        verdict({ verdict: 'read', readSources: [1] }),
      ],
      {},
      { readPage: vi.fn(async () => null) },
    );
    const result = await runMultiStepSearch(params, deps);

    expect(deps.readPage).toHaveBeenCalledTimes(1);
    expect(inputs[1].sources[0].pageUnreadable).toBe(true);
    expect(result.outcome).toBe('limit');
    expect(result.pagesRead).toBe(0);
  });

  it('refuses a read step when page reads are disabled', async () => {
    const { deps, params, inputs } = setup(
      [verdict({ verdict: 'read', readSources: [1] })],
      { config: { ...MULTI_STEP_DEFAULTS, pageReads: false } },
    );
    const result = await runMultiStepSearch(params, deps);

    expect(inputs[0].canRead).toBe(false);
    expect(deps.readPage).not.toHaveBeenCalled();
    expect(result.outcome).toBe('limit');
  });

  it('carries the clarifying question out when the user must be asked', async () => {
    const { deps, params } = setup([
      verdict({ verdict: 'ask_user', question: 'Which edition do you mean?' }),
    ]);
    const result = await runMultiStepSearch(params, deps);

    expect(result.outcome).toBe('ask_user');
    expect(result.question).toBe('Which edition do you mean?');
    expect(buildOutcomeNote(result)).toContain('Which edition do you mean?');
  });

  it('reports a give-up with its reason', async () => {
    const { deps, params } = setup([
      verdict({ verdict: 'give_up', reason: 'no listing exists anywhere' }),
    ]);
    const result = await runMultiStepSearch(params, deps);

    expect(result.outcome).toBe('gave_up');
    expect(buildOutcomeNote(result)).toContain('no listing exists anywhere');
  });

  it('degrades to the plain first search when no assessor answers', async () => {
    const { deps, params } = setup([null]);
    const result = await runMultiStepSearch(params, deps);

    expect(result.outcome).toBe('unassessed');
    expect(result.entries).toHaveLength(3);
    expect(buildOutcomeNote(result)).toBe('');
  });

  it('starts no step once the deadline is too close, and no assessment past it', async () => {
    const harness = setup([
      verdict({ verdict: 'search', queries: ['q2'], reason: 'missing x' }),
    ]);
    // 10s left: enough to assess, not enough for a further step.
    harness.advance(80_000);
    const result = await runMultiStepSearch(harness.params, harness.deps);

    expect(harness.inputs[0].stepsRemaining).toBe(0);
    expect(harness.deps.search).not.toHaveBeenCalled();
    expect(result.outcome).toBe('limit');

    const late = setup([verdict({ verdict: 'answer' })]);
    late.advance(89_000);
    const lateResult = await runMultiStepSearch(late.params, late.deps);
    expect(late.deps.assess).not.toHaveBeenCalled();
    expect(lateResult.outcome).toBe('unassessed');
  });

  it('keeps what it gathered when the instance fails mid-search', async () => {
    const { deps, params } = setup(
      [verdict({ verdict: 'search', queries: ['q2'], reason: 'missing x' })],
      {},
      {
        search: vi.fn(async () => {
          throw new Error('SearXNG search failed');
        }),
      },
    );
    const result = await runMultiStepSearch(params, deps);

    expect(result.outcome).toBe('limit');
    expect(result.entries).toHaveLength(3);
    expect(deps.onStep).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Web search failed' }),
    );
  });

  it('stops immediately when the request is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { deps, params } = setup([verdict({ verdict: 'answer' })], {
      signal: controller.signal,
    });
    await runMultiStepSearch(params, deps);
    expect(deps.assess).not.toHaveBeenCalled();
  });

  it('drops sources the assessor left out, but never below three', async () => {
    const initial = {
      entries: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => entry(id)),
      answers: [],
    };
    const { deps, params } = setup(
      [verdict({ verdict: 'answer', useful: [7, 2] })],
      { initial },
    );
    const result = await runMultiStepSearch(params, deps);

    expect(result.entries.map((e) => e.title)).toEqual([
      'Title g',
      'Title b',
      'Title a',
    ]);
  });

  it('labels source quality and ignores it when the admin turned it off', async () => {
    const assessment = () =>
      verdict({
        verdict: 'answer',
        useful: [1, 2],
        sourceQuality: [
          { n: 1, tier: 'primary' },
          { n: 2, tier: 'secondary' },
        ],
        caveat: 'Only one outlet reports the figure',
      });

    const on = setup([assessment()]);
    const labelled = buildMultiStepDigest(
      await runMultiStepSearch(on.params, on.deps),
    );
    expect(labelled.text).toContain('source type: official or original source');
    expect(labelled.text).toContain(
      'Note on these sources: Only one outlet reports the figure',
    );

    const off = setup([assessment()], {
      config: { ...MULTI_STEP_DEFAULTS, sourceAssessment: false },
    });
    expect(off.inputs).toHaveLength(0);
    const plain = buildMultiStepDigest(
      await runMultiStepSearch(off.params, off.deps),
    );
    expect(off.inputs[0].assessSources).toBe(false);
    expect(plain.text).not.toContain('source type:');
    expect(plain.text).not.toContain('Note on these sources');
  });

  it('runs on an empty first search and can recover with a new query', async () => {
    const { deps, params, inputs } = setup(
      [
        verdict({ verdict: 'search', queries: ['alternative title'] }),
        verdict({ verdict: 'answer' }),
      ],
      { initial: { entries: [], answers: [] } },
    );
    const result = await runMultiStepSearch(params, deps);

    expect(inputs[0].sources).toHaveLength(0);
    expect(inputs[0].canRead).toBe(false);
    expect(result.entries).toHaveLength(1);
    expect(result.outcome).toBe('answered');
  });
});

describe('source references in the assessor’s words', () => {
  const sources = [
    { ...entry('a'), sourceName: 'eeoc.gov' },
    { ...entry('b'), sourceName: 'lawfirm-blog.com' },
    { ...entry('c'), sourceName: undefined, url: 'https://www.ft.com/x' },
  ];

  it('become site names, which survive renumbering', () => {
    expect(
      nameSources('Source (1) is official; source 2 cites an order.', sources),
    ).toBe('eeoc.gov is official; lawfirm-blog.com cites an order.');
    expect(nameSources('Only sources 1 and 3 agree', sources)).toBe(
      'Only eeoc.gov, ft.com agree',
    );
    expect(nameSources('ignore the clickbait (source 2)', sources)).toBe(
      'ignore the clickbait (lawfirm-blog.com)',
    );
  });

  it('leave text alone when there is no such source or no reference', () => {
    expect(nameSources('source 9 is missing', sources)).toBe(
      'source 9 is missing',
    );
    expect(nameSources('No primary source and 2 blogs', sources)).toBe(
      'No primary source and 2 blogs',
    );
  });

  it('are rewritten before they reach the note for the answering model', async () => {
    const { deps, params } = setup([
      verdict({
        verdict: 'answer',
        useful: [3, 1],
        caveat: 'Only source 3 reports the figure',
      }),
    ]);
    const digest = buildMultiStepDigest(await runMultiStepSearch(params, deps));
    expect(digest.text).toContain(
      'Note on these sources: Only example.org reports the figure',
    );
  });
});

const health = (webCoverage: boolean | null, throttled = false) => ({
  answered: {},
  unresponsive: throttled ? [{ engine: 'bing', reason: 'CAPTCHA' }] : [],
  webCoverage,
  throttled,
});

describe('off-query results and the phrase fallback', () => {
  it('flags results that share at most one term with the query', () => {
    const junk = [
      entry('w1', 'Winter is the coldest season of the year.'),
      {
        ...entry('w2'),
        title: 'Winter (singer) - Wikipedia',
        snippet: 'Kim Min-jeong, known as Winter.',
      },
    ];
    expect(isOffQuery(junk, ['Winter Soldier 1972 documentary'])).toBe(true);
    const good = [
      {
        ...entry('f'),
        title: 'Winter Soldier (1972) - IMDb',
        snippet: 'Documentary about Vietnam veterans testimony.',
      },
    ];
    expect(isOffQuery(good, ['Winter Soldier 1972 documentary'])).toBe(false);
    // Too short a query to judge; an empty batch is empty, not off-query.
    expect(isOffQuery(junk, ['winter'])).toBe(false);
    expect(isOffQuery([], ['Winter Soldier 1972 documentary'])).toBe(false);
  });

  it('builds a quoted-title query from the question, with its disambiguators', () => {
    expect(
      phraseQueryFor(
        "There's a documentary called Winter Soldier about vietnam vets. Is this documentary available to buy or stream online?",
      ),
    ).toBe('"Winter Soldier" documentary vietnam available');
    expect(
      phraseQueryFor(
        'Can you find the 1621 first edition of The Anatomy of Melancholy for sale?',
      ),
    ).toBe('"The Anatomy of Melancholy" 1621 first edition');
    // No capitalised multi-word name: nothing to quote.
    expect(phraseQueryFor('what is happening in India')).toBeNull();
  });

  it('runs the quoted title itself when the first results are about something else, before asking the assessor', async () => {
    const junk = {
      entries: [
        entry('w1', 'Winter is the coldest season.'),
        entry('w2', 'KNMI winter outlook.'),
      ],
      answers: [],
    };
    const { deps, params, inputs } = setup(
      [verdict({ verdict: 'answer', useful: [3] })],
      {
        question:
          'Is the documentary Winter Soldier about Vietnam vets available to stream?',
        initialQueries: ['Winter Soldier documentary stream'],
        initial: junk,
      },
      {
        search: vi.fn(async () => ({
          entries: [
            {
              ...entry('imdb'),
              title: 'Winter Soldier (1972) - IMDb',
              snippet: 'Documentary, Vietnam veterans.',
            },
          ],
          answers: [],
        })),
      },
    );
    const result = await runMultiStepSearch(params, deps);

    expect(deps.search).toHaveBeenCalledTimes(1);
    expect(deps.search).toHaveBeenCalledWith(
      ['"Winter Soldier" documentary vietnam available'],
      expect.objectContaining({ narrow: true }),
    );
    expect(deps.onStep).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: 'phrase' }),
    );
    // The assessor saw both batches, the first marked as off-query.
    expect(inputs[0].steps[0].outcome).toContain('none matched the query');
    expect(inputs[0].sources).toHaveLength(3);
    expect(inputs[0].strategiesTried).toEqual([
      { strategy: 'phrase', deadEnd: false },
    ]);
    expect(result.strategies).toEqual(['phrase']);
    expect(result.entries[0].url).toBe('https://example.org/imdb');
  });
});

describe('backend health', () => {
  it('ends as degraded, without searching again, when the web engines did not answer', async () => {
    const { deps, params, inputs } = setup(
      [verdict({ verdict: 'search', queries: ['q2'], strategy: 'entity' })],
      {
        initial: {
          entries: [entry('ref')],
          answers: [],
          health: health(false),
        },
      },
    );
    const result = await runMultiStepSearch(params, deps);

    expect(inputs[0].searchHealth).toContain('did not answer');
    expect(deps.search).not.toHaveBeenCalled();
    expect(result.outcome).toBe('degraded');
    expect(result.stopReason).toBe('no_web_coverage');
    expect(result.webCoverageLost).toBe(true);
    expect(buildOutcomeNote(result)).toContain('did not answer');
  });

  it('a degraded batch is not a dead end of the subject', async () => {
    const { deps, params } = setup(
      [
        verdict({ verdict: 'read', readSources: [1] }),
        verdict({ verdict: 'answer' }),
      ],
      {
        initial: {
          entries: [entry('ref')],
          answers: [],
          health: health(false),
        },
      },
    );
    const result = await runMultiStepSearch(params, deps);
    expect(result.outcome).toBe('answered');
  });

  it('holds follow-up searches while the instance is throttled', async () => {
    const { deps, params } = setup(
      [verdict({ verdict: 'search', queries: ['q2'], strategy: 'entity' })],
      {},
      { searchAllowed: () => false },
    );
    const result = await runMultiStepSearch(params, deps);
    expect(deps.search).not.toHaveBeenCalled();
    expect(result.outcome).toBe('limit');
    expect(result.stopReason).toBe('throttled');
  });
});

describe('continuation', () => {
  const prior = {
    question: 'Is the Winter Soldier documentary available to stream?',
    queries: ['Winter Soldier documentary stream', 'Winter Soldier 1972 DVD'],
    strategies: ['terms' as const],
    deadEndStrategies: ['terms' as const],
    pagesTried: ['https://example.org/old'],
    outcome: 'limit' as const,
    reason: 'no listing found',
    steps: [
      {
        kind: 'search' as const,
        detail: '"Winter Soldier documentary stream"',
        outcome: '4 results',
      },
    ],
  };

  it('starts at the assessor with the earlier turn’s history and a fresh step budget', async () => {
    const { deps, params, inputs } = setup(
      [
        verdict({
          verdict: 'search',
          queries: ['site:justwatch.com Winter Soldier 1972'],
          strategy: 'venue',
        }),
        verdict({ verdict: 'answer', useful: [1] }),
      ],
      {
        question: 'keep looking please',
        initialQueries: [],
        initial: null,
        prior,
      },
    );
    const result = await runMultiStepSearch(params, deps);

    // The original question, not "keep looking"; the old steps as history.
    expect(inputs[0].question).toBe(prior.question);
    expect(inputs[0].continuation).toBe(true);
    expect(inputs[0].steps).toEqual(prior.steps);
    expect(inputs[0].stepsRemaining).toBe(MULTI_STEP_DEFAULTS.maxSteps);
    expect(inputs[0].strategiesTried).toEqual([
      { strategy: 'terms', deadEnd: true },
    ]);
    expect(deps.search).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('answered');
    expect(result.searchCount).toBe(1);

    const state = toPriorSearchState(result, 'keep looking please', prior);
    expect(state.question).toBe(prior.question);
    expect(state.queries).toEqual([
      ...prior.queries,
      'site:justwatch.com Winter Soldier 1972',
    ]);
    // Every strategy tried across turns, so the next continuation knows too.
    expect(state.strategies).toEqual(['terms', 'venue']);
    expect(state.deadEndStrategies).toEqual(['terms']);
    expect(state.outcome).toBe('answered');
  });

  it('refuses a query or strategy the earlier turn already tried', async () => {
    const { deps, params } = setup(
      [
        verdict({
          verdict: 'search',
          queries: ['Winter Soldier 1972 DVD'],
          strategy: 'venue',
        }),
      ],
      { initialQueries: [], initial: null, prior },
    );
    const result = await runMultiStepSearch(params, deps);
    expect(deps.search).not.toHaveBeenCalled();
    expect(result.stopReason).toBe('repeat');

    const again = setup(
      [
        verdict({
          verdict: 'search',
          queries: ['brand new query'],
          strategy: 'terms',
        }),
      ],
      { initialQueries: [], initial: null, prior },
    );
    expect(
      (await runMultiStepSearch(again.params, again.deps)).stopReason,
    ).toBe('strategy');
  });
});

describe('buildMultiStepDigest', () => {
  it('cites nothing when the search ended short and nothing was judged useful', async () => {
    const { deps, params } = setup([
      verdict({
        verdict: 'search',
        queries: ['q2'],
        strategy: 'entity',
        reason: 'wrong subject',
      }),
      verdict({ verdict: 'give_up', reason: 'only namesakes found' }),
    ]);
    const result = await runMultiStepSearch(params, deps);
    const digest = buildMultiStepDigest(result);

    expect(result.usefulCount).toBe(0);
    expect(digest.citations).toEqual([]);
    expect(digest.text).toContain('judged NOT to be about the subject');
    expect(digest.text).toContain('- Title a (example.org)');
    expect(digest.text).not.toMatch(/\[\d+\]/);
  });

  it('returns nothing to cite for an empty result', async () => {
    const { deps, params } = setup([verdict({ verdict: 'give_up' })], {
      initial: { entries: [], answers: [] },
    });
    const result = await runMultiStepSearch(params, deps);
    const digest = buildMultiStepDigest(result);
    expect(digest.citations).toEqual([]);
    expect(digest.text).toContain('Search note:');
  });

  it('numbers sources from 1 at line starts and lists every query', async () => {
    const { deps, params } = setup([
      verdict({ verdict: 'search', queries: ['second query'] }),
      verdict({ verdict: 'answer' }),
    ]);
    const digest = buildMultiStepDigest(await runMultiStepSearch(params, deps));

    expect(digest.text).toContain('"rare book"; "second query"');
    expect(digest.text).toMatch(/^\[1\] Title a/m);
    expect(digest.citations.map((c) => c.number)).toEqual([1, 2, 3, 4]);
    // Nothing but source markers may look like a citation.
    const markers = digest.text.match(/\[\d+\]/g) ?? [];
    expect(markers).toEqual(['[1]', '[2]', '[3]', '[4]']);
  });
});

describe('focusExcerpt', () => {
  it('returns short pages whole, minus bracketed numbers and marker delimiters', () => {
    expect(focusExcerpt('A claim.[12] <<<X>>> More.', [], 500)).toBe(
      'A claim. X More.',
    );
  });

  it('keeps the opening plus the passages that mention the question’s terms', () => {
    const filler = Array.from(
      { length: 40 },
      (_, i) =>
        `Paragraph ${i} about unrelated navigation and boilerplate text.`,
    );
    filler[30] =
      'The employment equality directive requires employers to report pay gaps.';
    const excerpt = focusExcerpt(
      filler.join('\n'),
      focusTerms(['employment equality policy']),
      900,
    );

    expect(excerpt.startsWith('Paragraph 0')).toBe(true);
    expect(excerpt).toContain('employment equality directive');
    expect(excerpt).toContain('[…]');
    expect(excerpt.length).toBeLessThanOrEqual(940);
  });

  it('falls back to the opening when nothing matches', () => {
    const text = Array.from({ length: 60 }, (_, i) => `Line number ${i}.`).join(
      '\n',
    );
    const excerpt = focusExcerpt(text, ['zzzz'], 300);
    expect(excerpt.startsWith('Line number 0.')).toBe(true);
    expect(excerpt.length).toBeLessThanOrEqual(340);
  });
});
