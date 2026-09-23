import {
  RawExtractResponse,
  normalizeExtractResponse,
} from '@/lib/services/workflows/shared/drafter/extract';
import {
  buildGenerateUserPrompt,
  buildIntentBlock,
  buildLinksBlock,
  buildRepairPrompt,
  findingsFor,
  linkPolicyFor,
  normalizeGenerated,
  quoteTokens,
  substituteQuotes,
} from '@/lib/services/workflows/shared/drafter/generate';

import { getSpecAdapter } from '@/lib/utils/shared/drafter/adapters';

import { GenerateRequest } from '@/types/drafter';

import { describe, expect, it } from 'vitest';

const SOURCE = {
  id: 'src1',
  name: 'Field report',
  text:
    'Amina Yusuf, a nurse at the clinic, said: “We had no clean water for eleven days.” ' +
    'The clinic treated 1,200 patients in March. Trucks arrived on the twelfth day.',
};

function rawItem(
  partial: Partial<RawExtractResponse['items'][number]>,
): RawExtractResponse['items'][number] {
  return {
    kind: 'quote',
    text: 'We had no clean water for eleven days.',
    speakerName: 'Amina Yusuf',
    speakerRole: 'nurse',
    sourceId: 'src1',
    excerpt: 'We had no clean water for eleven days.',
    ...partial,
  };
}

function extract(items: RawExtractResponse['items']) {
  return normalizeExtractResponse(
    {
      keyMessage: 'Water is life',
      callToAction: null,
      language: 'English',
      items,
    },
    [SOURCE],
  );
}

describe('normalizeExtractResponse', () => {
  it('verifies a quote against the source and keeps a speaker named beside it', () => {
    const [item] = extract([rawItem({})]).items;
    expect(item.verified).toBe('verbatim');
    expect(item.attribution).toEqual({ name: 'Amina Yusuf', role: 'nurse' });
    expect(item.provenance).toEqual([
      { sourceId: 'src1', excerpt: 'We had no clean water for eleven days.' },
    ]);
  });

  it('marks a reworded quote as not found, whatever excerpt is claimed', () => {
    const [item] = extract([
      rawItem({ text: 'We went without clean water for eleven days.' }),
    ]).items;
    expect(item.verified).toBe('unverified');
    expect(item.provenance).toEqual([]);
    expect(item.attribution).toBeUndefined();
  });

  it('drops a speaker the source does not name near the words', () => {
    const [item] = extract([rawItem({ speakerName: 'Dr Jean Martin' })]).items;
    expect(item.verified).toBe('verbatim');
    expect(item.attribution).toBeUndefined();
  });

  it('rejects a statement whose number is not in its excerpt', () => {
    const excerpt = 'The clinic treated 1,200 patients in March.';
    const [good, bad] = extract([
      rawItem({
        kind: 'figure',
        text: 'The clinic treated 1 200 patients.',
        excerpt,
      }),
      rawItem({
        kind: 'figure',
        text: 'The clinic treated 2,100 patients.',
        excerpt,
      }),
    ]).items;
    expect(good.verified).toBe('verbatim');
    expect(bad.verified).toBe('unverified');
  });

  it('does not trust an unknown source id or an unknown kind', () => {
    const result = extract([
      rawItem({ sourceId: 'elsewhere' }),
      rawItem({ kind: 'rumour' }),
    ]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].verified).toBe('unverified');
  });

  it('stores quoted words bare', () => {
    const [item] = extract([
      rawItem({ text: '“We had no clean water for eleven days.”' }),
    ]).items;
    expect(item.text).toBe('We had no clean water for eleven days.');
    expect(item.verified).toBe('verbatim');
  });
});

const BRIEF: GenerateRequest['brief'] = {
  keyMessage: 'Water is life',
  links: [],
  language: 'English',
  items: [
    {
      id: 'i1',
      kind: 'quote',
      text: 'We had no clean water for eleven days.',
      attribution: { name: 'Amina Yusuf', role: 'nurse' },
      verified: 'verbatim',
    },
    {
      id: 'i2',
      kind: 'figure',
      text: 'The clinic treated 1,200 patients in March.',
      verified: 'verbatim',
    },
  ],
};

describe('quote tokens', () => {
  const tokens = quoteTokens(BRIEF.items);

  it('gives tokens to spoken items only, and tells the model their length', () => {
    expect([...tokens.keys()]).toEqual(['{{q1}}']);
    const prompt = buildGenerateUserPrompt(BRIEF, tokens);
    expect(prompt).toContain(
      'token {{q1}} (costs 40 characters when inserted)',
    );
    expect(prompt).toContain('id i2 [figure]');
  });

  it('puts the exact words back and never double-quotes them', () => {
    expect(substituteQuotes('A nurse said "{{q1}}" today.', tokens)).toEqual({
      text: 'A nurse said “We had no clean water for eleven days.” today.',
      usedItemIds: ['i1'],
    });
  });

  it('keeps the spaces around a token the model did not quote', () => {
    expect(substituteQuotes('A nurse said {{q1}} today.', tokens).text).toBe(
      'A nurse said “We had no clean water for eleven days.” today.',
    );
  });

  it('removes a token that names no item instead of publishing it', () => {
    expect(substituteQuotes('Before {{q9}} after', tokens).text).toBe(
      'Before after',
    );
  });

  it('merges reported and substituted item ids and drops unknown ones', () => {
    const adapter = getSpecAdapter('channel')!;
    const spec = adapter.resolveSpec('x')!;
    const generated = normalizeGenerated(
      {
        segments: [
          { text: '{{q1}} Amina Yusuf, nurse.', usedItemIds: ['i2', 'ghost'] },
          { text: '   ', usedItemIds: [] },
        ],
      },
      spec,
      BRIEF,
      tokens,
    );
    expect(generated.segments).toHaveLength(1);
    expect(generated.segments[0].usedItemIds.sort()).toEqual(['i1', 'i2']);
  });
});

describe('links and intent', () => {
  const adapter = getSpecAdapter('channel')!;
  const x = adapter.resolveSpec('x')!;
  const instagram = adapter.resolveSpec('instagram')!;
  const article = {
    role: 'article' as const,
    label: 'Statement on the water crisis',
    url: 'https://example.org/statements/water-crisis',
  };
  const donate = {
    role: 'donation' as const,
    label: 'Donate',
    url: 'https://example.org/donate',
  };

  it('tells the model not to ask for money unless a donation link is given', () => {
    expect(buildIntentBlock(BRIEF)).toContain('Do NOT ask for donations');
    const asking = buildIntentBlock({ ...BRIEF, links: [donate] });
    expect(asking).toContain('invite people to donate');
    expect(asking).not.toContain('Do NOT ask');
  });

  it('an article link alone does not turn the posts into an appeal', () => {
    const block = buildIntentBlock({ ...BRIEF, links: [article] });
    expect(block).toContain('Do NOT ask for donations');
    expect(block).toContain('point readers to the full piece');
  });

  it('budgets the link the way the channel counts it, and never shows the URL', () => {
    const brief = { ...BRIEF, links: [article] };
    const block = buildLinksBlock(brief, linkPolicyFor(adapter, x));
    expect(block).toContain('the last post');
    expect(block).toContain('25 characters');
    expect(block).not.toContain(article.url);
    expect(
      buildGenerateUserPrompt(brief, quoteTokens(brief.items)),
    ).not.toContain(article.url);
  });

  it('says links are not clickable where they are not', () => {
    const block = buildLinksBlock(
      { ...BRIEF, links: [article] },
      linkPolicyFor(adapter, instagram),
    );
    expect(block).toContain('not clickable');
  });

  it('appends links to the last post and drops a URL the model typed', () => {
    const brief = { ...BRIEF, links: [article, donate] };
    const generated = normalizeGenerated(
      {
        segments: [
          { text: `Opening. ${article.url}`, usedItemIds: [] },
          { text: 'Closing line:', usedItemIds: [] },
        ],
      },
      x,
      brief,
      quoteTokens(brief.items),
      linkPolicyFor(adapter, x),
    );
    expect(generated.segments.map((s) => s.text)).toEqual([
      'Opening.',
      `Closing line:\n\n${article.url}\n\n${donate.url}`,
    ]);
  });

  it('strips links from the current text shown to the model on Update', () => {
    const brief = { ...BRIEF, links: [article] };
    const prompt = buildGenerateUserPrompt(brief, quoteTokens(brief.items), [
      `Old text.\n\n${article.url}`,
    ]);
    expect(prompt).toContain('[1] Old text.');
    expect(prompt).not.toContain(article.url);
  });
});

describe('repair round', () => {
  const adapter = getSpecAdapter('channel')!;
  const spec = adapter.resolveSpec('x')!;

  it('is skipped when nothing blocking was found', () => {
    const generated = {
      specId: 'x',
      segments: [
        {
          text: '“We had no clean water for eleven days.” 1,200 patients treated.',
          usedItemIds: ['i1', 'i2'],
        },
      ],
    };
    expect(
      buildRepairPrompt(
        ['{{q1}} 1,200'],
        findingsFor(adapter, spec, generated, BRIEF),
      ),
    ).toBeNull();
  });

  it('names an invented quote, an unknown number and an over-long post', () => {
    const generated = {
      specId: 'x',
      segments: [
        {
          text: `“Nobody came to help us” and 9,999 waited. ${'a'.repeat(280)}`,
          usedItemIds: [],
        },
      ],
    };
    const prompt = buildRepairPrompt(
      ['raw answer'],
      findingsFor(adapter, spec, generated, BRIEF),
    );
    expect(prompt).toContain('You typed a quotation yourself');
    expect(prompt).toContain('a number that is not in the brief');
    expect(prompt).toContain('characters over the limit');
    expect(prompt).toContain('[1] raw answer');
  });
});
