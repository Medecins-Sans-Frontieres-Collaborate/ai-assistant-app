import {
  MultiStepDeps,
  MultiStepParams,
  buildMultiStepDigest,
  buildOutcomeNote,
  focusExcerpt,
  focusTerms,
  nameSources,
  runMultiStepSearch,
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
        verdict({ verdict: 'search', queries: ['q2'] }),
        verdict({ verdict: 'search', queries: ['q3'] }),
        verdict({ verdict: 'search', queries: ['q4'] }),
      ],
      {
        config: { ...MULTI_STEP_DEFAULTS, maxSteps: 8, maxStepsExploratory: 8 },
      },
      { search: vi.fn(async () => ({ entries: [], answers: [] })) },
    );
    const result = await runMultiStepSearch(params, deps);

    expect(deps.search).toHaveBeenCalledTimes(2);
    expect(result.outcome).toBe('limit');
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

describe('buildMultiStepDigest', () => {
  it('returns nothing to cite for an empty result', async () => {
    const { deps, params } = setup([verdict({ verdict: 'give_up' })], {
      initial: { entries: [], answers: [] },
    });
    const result = await runMultiStepSearch(params, deps);
    expect(buildMultiStepDigest(result)).toEqual({ text: '', citations: [] });
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
