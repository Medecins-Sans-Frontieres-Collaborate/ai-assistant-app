import {
  RawExtractResponse,
  normalizeExtractResponse,
} from '@/lib/services/workflows/shared/drafter/extract';
import {
  TOKEN_PATTERN,
  buildGenerateSystemPrompt,
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
import { emptyBrief } from '@/lib/utils/shared/drafter/core/brief';
import { groundSegment } from '@/lib/utils/shared/drafter/core/grounding';

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
      'token {{q1}} (costs 40 characters in full; shorten it with {{q1|first words … last words}})',
    );
    expect(prompt).toContain('id i2 [figure]');
  });

  it('teaches the shortened form and keeps the hard rules', () => {
    const prompt = buildGenerateSystemPrompt(
      'Channel: X.',
      undefined,
      'English',
    );
    expect(prompt).not.toContain('You may not shorten');
    expect(prompt).toContain('{{q1|first words … last words}}');
    expect(prompt).toContain('never write brackets');
    expect(prompt).toContain('never type a quotation yourself');
    expect(prompt).toContain('Never put any other text inside quotation marks');
  });

  it('puts the exact words back and never double-quotes them', () => {
    expect(substituteQuotes('A nurse said "{{q1}}" today.', tokens)).toEqual({
      text: 'A nurse said “We had no clean water for eleven days.” today.',
      usedItemIds: ['i1'],
      unverifiedForms: [],
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

  describe('[tokens] shortened forms', () => {
    const full = '“We had no clean water for eleven days.”';

    it("renders a verbatim elision from the item's own characters, in its casing", () => {
      const result = substituteQuotes(
        'She said {{q1|WE HAD NO CLEAN WATER … eleven days}} to us.',
        tokens,
      );
      expect(result).toEqual({
        text: 'She said “We had no clean water … eleven days” to us.',
        usedItemIds: ['i1'],
        unverifiedForms: [],
      });
    });

    it('drops quotation marks the model put around a shortened form', () => {
      expect(
        substituteQuotes('"{{q1|We had no clean water … eleven days}}"', tokens)
          .text,
      ).toBe('“We had no clean water … eleven days”');
    });

    it('emits the full quote for a contiguous form that names all the words', () => {
      const result = substituteQuotes(
        '{{q1|We had no clean water for eleven days.}}',
        tokens,
      );
      expect(result.text).toBe(full);
      expect(result.unverifiedForms).toEqual([]);
    });

    it('inserts the full quote and reports a form that is not a verbatim elision', () => {
      const result = substituteQuotes('{{q1|we had plenty of water}}', tokens);
      expect(result.text).toBe(full);
      expect(result.usedItemIds).toEqual(['i1']);
      expect(result.unverifiedForms).toEqual(['{{q1|we had plenty of water}}']);
    });

    it('refuses a shortening that no longer reads as a sentence, and says why', () => {
      const long: GenerateRequest['brief'] = {
        ...BRIEF,
        items: [
          {
            id: 'i1',
            kind: 'quote',
            text: 'The new deal Gilead announced with PAHO this week comes after the company first blocked people across Latin America and the Caribbean from accessing affordable generic versions of lenacapavir.',
            verified: 'verbatim',
          },
        ],
      };
      const tokens = quoteTokens(long.items);
      const { text, unverifiedForms } = substituteQuotes(
        '{{q1|The new deal … affordable generic versions of lenacapavir.}}',
        tokens,
      );
      expect(text).toBe(`“${long.items[0].text}”`);
      expect(unverifiedForms).toHaveLength(1);
      const prompt = buildRepairPrompt(
        ['{{q1|The new deal … affordable generic versions of lenacapavir.}}'],
        [
          {
            checkId: 'length',
            severity: 'block',
            targetId: 'g0',
            messageKey: 'overLimit',
            values: { count: 30, post: 1 },
          },
        ],
        {
          tokens,
          cost: (t) => t.length,
          linkCost: () => 0,
        },
      );
      expect(prompt).toContain('kept less than half of the quotation');
      // A readable shortening (an aside left out) is accepted.
      const aside: GenerateRequest['brief'] = {
        ...BRIEF,
        items: [
          {
            id: 'i1',
            kind: 'quote',
            text: 'We had no clean water, with the wells full of mud, for eleven days.',
            verified: 'verbatim',
          },
        ],
      };
      const good = substituteQuotes(
        '{{q1|We had no clean water … for eleven days.}}',
        quoteTokens(aside.items),
      );
      expect(good.unverifiedForms).toHaveLength(0);
      expect(good.text).toBe('“We had no clean water … for eleven days.”');
    });

    it('refuses a form that drops a negation', () => {
      const negated = quoteTokens([
        {
          ...BRIEF.items[0],
          text: 'We did not have enough water for the children.',
        },
      ]);
      const dropped = substituteQuotes(
        '{{q1|We did … enough water for the children.}}',
        negated,
      );
      expect(dropped.text).toBe(
        '“We did not have enough water for the children.”',
      );
      expect(dropped.unverifiedForms).toEqual([
        '{{q1|We did … enough water for the children.}}',
      ]);
      // A one-word run is not evidence either.
      const short = substituteQuotes('{{q1|we … enough water}}', negated);
      expect(short.unverifiedForms).toHaveLength(1);
    });

    it('refuses brackets from the model', () => {
      const result = substituteQuotes(
        '{{q1|We had no clean water [in the camp] for eleven days.}}',
        tokens,
      );
      expect(result.text).toBe(full);
      expect(result.usedItemIds).toEqual(['i1']);
      expect(result.unverifiedForms).toHaveLength(1);
    });

    it('keeps a trailing ellipsis so a shortened end is visible (EQ-5)', () => {
      const result = substituteQuotes('{{q1|We had no clean water …}}', tokens);
      expect(result.text).toBe('“We had no clean water …”');
      expect(result.unverifiedForms).toEqual([]);
    });

    it('keeps a leading ellipsis so a shortened start is visible (EQ-5)', () => {
      const clinic = quoteTokens([
        {
          ...BRIEF.items[0],
          text: 'The clinic treated forty children in the first week.',
        },
      ]);
      const result = substituteQuotes(
        '{{q1|… forty children in the first week.}}',
        clinic,
      );
      expect(result.text).toBe('“… forty children in the first week.”');
      expect(result.unverifiedForms).toEqual([]);
      // The words dropped before "for eleven days" carry the negation.
      const negated = substituteQuotes('{{q1|… for eleven days}}', tokens);
      expect(negated.text).toBe(full);
      expect(negated.unverifiedForms).toEqual(['{{q1|… for eleven days}}']);
    });

    it('adds the ellipsis a plain sub-span left out and holds it to the gap rules (EQ-5)', () => {
      const clinic = quoteTokens([
        {
          ...BRIEF.items[0],
          text: 'The clinic treated forty children in the first week.',
        },
      ]);
      const inner = substituteQuotes(
        '{{q1|The clinic treated forty children}}',
        clinic,
      );
      expect(inner.text).toBe('“The clinic treated forty children …”');
      expect(inner.unverifiedForms).toEqual([]);
      // Dropping ", but we could not" turns the meaning: refused, goes in whole.
      const turn = quoteTokens([
        { ...BRIEF.items[0], text: 'We wanted to leave, but we could not.' },
      ]);
      const cut = substituteQuotes('{{q1|We wanted to leave}}', turn);
      expect(cut.text).toBe('“We wanted to leave, but we could not.”');
      expect(cut.unverifiedForms).toEqual(['{{q1|We wanted to leave}}']);
    });

    it('emits edge ellipses the grounding check accepts as an elision (EQ-5)', () => {
      const item = {
        ...BRIEF.items[0],
        text: 'The clinic treated forty children in the first week.',
      };
      const rendered = substituteQuotes(
        'She said {{q1|The clinic treated forty children}} today.',
        quoteTokens([item]),
      );
      const marks = groundSegment(
        { id: 's1', text: rendered.text, usedItemIds: ['i1'] },
        {
          ...emptyBrief(),
          language: 'English',
          items: [{ ...item, provenance: [], decision: 'included' }],
        },
      );
      const quote = marks.find((mark) => mark.kind === 'quote');
      expect(quote).toMatchObject({ itemId: 'i1', elided: true });
      expect(marks.every((mark) => mark.itemId !== undefined)).toBe(true);
    });

    it('never publishes an empty or over-long form raw (EQ-7)', () => {
      const empty = substituteQuotes('Said: {{q1|}} end.', tokens);
      expect(empty.text).toBe(`Said: ${full} end.`);
      expect(empty.usedItemIds).toEqual(['i1']);
      expect(empty.unverifiedForms).toEqual(['{{q1|}}']);
      const blank = substituteQuotes('{{q1|   }}', tokens);
      expect(blank.text).toBe(full);
      expect(blank.unverifiedForms).toEqual(['{{q1|   }}']);
      const long = `{{q1|${'word '.repeat(130).trim()}}}`;
      const over = substituteQuotes(long, tokens);
      expect(over.text).toBe(full);
      expect(over.unverifiedForms).toEqual([long]);
    });

    it('removes a shortened token that names no item', () => {
      expect(substituteQuotes('Before {{q9|a … b}} after', tokens).text).toBe(
        'Before after',
      );
    });

    it('never crosses a line or a brace inside a form', () => {
      TOKEN_PATTERN.lastIndex = 0;
      expect('{{q1|a\nb}}'.match(TOKEN_PATTERN)).toBeNull();
      expect('{{q1|a {b}}'.match(TOKEN_PATTERN)).toBeNull();
    });
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
    expect(prompt).toContain('shortened as {{q1|first words … last words}}');
    expect(prompt).toContain('a number that is not in the brief');
    expect(prompt).toContain('characters over the limit');
    expect(prompt).toContain('[1] raw answer');
  });
});
