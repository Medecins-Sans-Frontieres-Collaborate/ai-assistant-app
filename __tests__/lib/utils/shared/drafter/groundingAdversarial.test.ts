/**
 * Evasions a reviewer proved against the deterministic grounding checks.
 * Each of these once produced ZERO marks; every test pins one closed.
 */
import { emptyBrief } from '@/lib/utils/shared/drafter/core/brief';
import {
  BRIEF_ITSELF,
  canonicalNumber,
  findNames,
  findNumbers,
  findQuotedSpans,
  groundVersion,
  numbersSupported,
  ungroundedNames,
} from '@/lib/utils/shared/drafter/core/grounding';
import { numbersPreserved } from '@/lib/utils/shared/drafter/core/translation';
import { attributionNearExcerpt } from '@/lib/utils/shared/drafter/core/verify';

import { Brief, BriefItem, Segment } from '@/types/drafter';

import { describe, expect, it } from 'vitest';

function item(partial: Partial<BriefItem> & { id: string }): BriefItem {
  return {
    kind: 'quote',
    text: 'We walked for three days and nobody helped us at all.',
    provenance: [],
    verified: 'verbatim',
    decision: 'included',
    ...partial,
  };
}

function briefWith(items: BriefItem[], patch: Partial<Brief> = {}): Brief {
  return { ...emptyBrief(), language: 'English', items, ...patch };
}

function seg(id: string, text: string): Segment {
  return { id, text, usedItemIds: [] };
}

function inners(text: string): string[] {
  return findQuotedSpans(text).map((span) => span.inner);
}

function quoteMarks(text: string, brief: Brief): Array<string | undefined> {
  return groundVersion([seg('s1', text)], brief)
    .filter((mark) => mark.kind === 'quote')
    .map((mark) => mark.itemId);
}

function numberMarks(text: string, brief: Brief): Array<string | undefined> {
  return groundVersion([seg('s1', text)], brief)
    .filter((mark) => mark.kind === 'number')
    .map((mark) => mark.itemId);
}

describe('1. quotation styles', () => {
  it('finds single curly, German low single and single guillemets', () => {
    expect(inners('She said ‘nobody came to help’ again.')).toEqual([
      'nobody came to help',
    ]);
    expect(inners('Sie sagte: ‚Niemand kam zu uns‘ und ging.')).toEqual([
      'Niemand kam zu uns',
    ]);
    expect(inners('Elle a dit ‹ personne ne nous aide › hier.')).toEqual([
      ' personne ne nous aide ',
    ]);
    expect(inners('Sie sagte ›niemand kam zu uns‹ und ging.')).toEqual([
      'niemand kam zu uns',
    ]);
  });

  it('accepts any closer of the double family for a double opener', () => {
    expect(inners('He said "nobody came to help” yesterday.')).toEqual([
      'nobody came to help',
    ]);
    expect(inners('Er sagte „niemand kam zu uns" gestern.')).toEqual([
      'niemand kam zu uns',
    ]);
    expect(inners('Er sagte „niemand kam zu uns“ gestern.')).toEqual([
      'niemand kam zu uns',
    ]);
    expect(inners('Hon sa: ”Vi gick i tre dagar” och grät.')).toEqual([
      'Vi gick i tre dagar',
    ]);
  });

  it('reads ASCII apostrophe-quotes only where they cannot be apostrophes', () => {
    expect(inners("She said 'nobody came to help' again.")).toEqual([
      'nobody came to help',
    ]);
    // A contraction inside the quotation does not close it.
    expect(inners("She said 'we didn't get any help' again.")).toEqual([
      "we didn't get any help",
    ]);
    expect(
      inners("We don't know why MSF's team left the nurses' station empty."),
    ).toEqual([]);
    expect(inners('They didn’t reach the nurses’ station in time.')).toEqual(
      [],
    );
    expect(inners("It was rock 'n' roll all night long.")).toEqual([]);
  });

  it('keeps the minimum length for every style', () => {
    expect(inners('He called it ‘a disaster’ and ‹so sad›.')).toEqual([]);
  });

  it('flags a fabricated quotation in each newly covered style', () => {
    const brief = briefWith([item({ id: 'q1' })]);
    for (const text of [
      'She said ‘the doctors all ran away’.',
      'Sie sagte ‚the doctors all ran away‘.',
      'She said ‹the doctors all ran away›.',
      'She said "the doctors all ran away”.',
      'She said „the doctors all ran away".',
      "She said 'the doctors all ran away'.",
    ]) {
      expect(quoteMarks(text, brief), text).toEqual([undefined]);
    }
    expect(quoteMarks('She said ‘nobody helped us at all’.', brief)).toEqual([
      'q1',
    ]);
  });
});

describe('2. unbalanced quotation marks', () => {
  const brief = briefWith([item({ id: 'q1' })]);

  it('checks a quotation split across two posts, both halves', () => {
    const marks = groundVersion(
      [
        seg('s1', 'She told us: "We walked for three days'),
        seg('s2', 'and nobody helped us at all."'),
      ],
      brief,
    );
    expect(marks.map((m) => [m.segmentId, m.kind, m.itemId])).toEqual([
      ['s1', 'quote', 'q1'],
      ['s2', 'quote', 'q1'],
    ]);
  });

  it('flags a fabricated quotation split the same way', () => {
    const marks = groundVersion(
      [
        seg('s1', 'She told us: “The doctors all ran away'),
        seg('s2', 'and they took the medicine with them.”'),
      ],
      brief,
    );
    expect(marks.map((m) => [m.segmentId, m.kind, m.itemId])).toEqual([
      ['s1', 'quote', undefined],
      ['s2', 'quote', undefined],
    ]);
  });

  it('covers guillemets and the German low opener', () => {
    expect(findQuotedSpans('Elle a dit : « Personne ne nous aide')).toEqual([
      expect.objectContaining({
        inner: ' Personne ne nous aide',
        unbalanced: true,
      }),
    ]);
    expect(findQuotedSpans('et personne ne nous aide » a-t-elle dit.')).toEqual(
      [
        expect.objectContaining({
          inner: 'et personne ne nous aide ',
          unbalanced: true,
        }),
      ],
    );
    expect(inners('Sie sagte: „Niemand kam zu uns')).toEqual([
      'Niemand kam zu uns',
    ]);
  });

  it('starts a stray closer after the last closed quotation', () => {
    expect(inners('“We walked for days” she said, and nobody came.”')).toEqual([
      'We walked for days',
      'she said, and nobody came.',
    ]);
  });

  it('never reads apostrophes, inch marks or short tails as quotations', () => {
    expect(inners('We laid 5" pipe for three long days')).toEqual([]);
    expect(inners('We laid 5” pipe for three long days')).toEqual([]);
    expect(inners("The nurses' station was empty all day long")).toEqual([]);
    expect(inners('‘tis the season to be careful out there')).toEqual([]);
    expect(inners('He said “stop')).toEqual([]);
    expect(inners('At last.” Then the trucks came again')).toEqual([]);
  });
});

describe('3. numbers', () => {
  it('folds a magnitude into the number, so a single digit counts', () => {
    const brief = briefWith([
      item({ id: 'f1', kind: 'figure', text: '8 million people need aid' }),
    ]);
    expect(numberMarks('3 million people fled', brief)).toEqual([undefined]);
    expect(numberMarks('8 million people fled', brief)).toEqual(['f1']);
    expect(numberMarks('8 billion people fled', brief)).toEqual([undefined]);
    expect(numberMarks('8,000,000 people fled', brief)).toEqual(['f1']);
    expect(numberMarks('8m people fled', brief)).toEqual(['f1']);
    // Still prose without a magnitude.
    expect(numberMarks('3 things happened', brief)).toEqual([]);
  });

  it('does not let "1.5 million" prove "1.5 billion"', () => {
    expect(
      numbersSupported('1.5 billion children', '1.5 million children'),
    ).toBe(false);
    expect(numbersSupported('8 million', '8 billion')).toBe(false);
    expect(numbersSupported('8 billion', '8 million')).toBe(false);
    expect(numbersSupported('1.5 million', '1,500,000 children')).toBe(true);
    expect(numbersSupported('3 bn', '3 billion')).toBe(true);
    expect(numbersSupported('2.5k', '2,500 tents')).toBe(true);
  });

  it('reads every way of writing percent as the same thing', () => {
    expect(canonicalNumber('50 percent')).toBe('50%');
    expect(canonicalNumber('50 per cent')).toBe('50%');
    expect(canonicalNumber('50 %')).toBe('50%');
    expect(numbersSupported('50% of children', '50 percent of children')).toBe(
      true,
    );
    expect(numbersSupported('5 por ciento', '5%')).toBe(true);
    expect(numbersSupported('5 Prozent', '5 pour cent')).toBe(true);
    expect(numbersSupported('50%', '50 children')).toBe(false);
    // "percentage points" is not a percent sign; the bare digit stays prose.
    expect(findNumbers('up 5 percentage points')).toEqual([]);
  });

  it('agrees on magnitudes across the languages a brief is translated to', () => {
    const original = '8 million people and 3 billion dollars';
    for (const translated of [
      '8 millions de personnes et 3 milliards de dollars',
      '8 millones de personas y 3 mil millones de dólares',
      '8 millones de personas y 3.000 millones de dólares',
      '8 Millionen Menschen und 3 Milliarden Dollar',
      '8 milhões de pessoas e 3 bilhões de dólares',
      '8 milioni di persone e 3 miliardi di dollari',
    ]) {
      expect(numbersPreserved(original, translated), translated).toBe(true);
    }
    expect(numbersPreserved(original, '8 milliards de personnes')).toBe(false);
    expect(numbersPreserved('2 thousand', '2 mille')).toBe(true);
    expect(numbersPreserved('2 thousand', '2 mil')).toBe(true);
    expect(numbersPreserved('2 thousand', '2 Tausend')).toBe(true);
    expect(numbersPreserved('2 thousand', '2 mila')).toBe(true);
    expect(numbersPreserved('1 million', '1 millón')).toBe(true);
    expect(numbersPreserved('1 million', '1 milhão')).toBe(true);
    expect(numbersPreserved('1 million', '1 milione')).toBe(true);
  });

  it('does not take a unit of length or a longer word for a magnitude', () => {
    expect(findNumbers('a 5 m wall').map((n) => n.canonical)).toEqual([]);
    expect(findNumbers('ran 5km').map((n) => n.canonical)).toEqual([]);
    expect(findNumbers('12 millionaires').map((n) => n.canonical)).toEqual([
      '12',
    ]);
  });

  it('folds any Unicode decimal digit to ASCII', () => {
    expect(canonicalNumber('١٢٠٠')).toBe('1200');
    expect(canonicalNumber('۱۲۰۰')).toBe('1200');
    expect(canonicalNumber('१२००')).toBe('1200');
    expect(canonicalNumber('١٬٢٠٠')).toBe('1200');
    expect(canonicalNumber('١٫٥')).toBe('1.5');
    expect(canonicalNumber('٤٠٪')).toBe('40%');
    expect(numbersPreserved('treated 1,200 patients', 'عالج ١٢٠٠ مريض')).toBe(
      true,
    );
    expect(numbersPreserved('treated 1,200 patients', 'عالج ١٣٠٠ مريض')).toBe(
      false,
    );
    const brief = briefWith([
      item({ id: 'f1', kind: 'figure', text: 'عالجت العيادة ١٢٠٠ مريض' }),
    ]);
    expect(numberMarks('1,200 patients treated', brief)).toEqual(['f1']);
  });

  it('separates numbers that only stand next to each other', () => {
    expect(findNumbers('In 2024, 500 came').map((n) => n.canonical)).toEqual([
      '2024',
      '500',
    ]);
    expect(
      findNumbers('Opened in 2024. 12 clinics now').map((n) => n.canonical),
    ).toEqual(['2024', '12']);
    expect(findNumbers('In 2024 500 came').map((n) => n.canonical)).toEqual([
      '2024',
      '500',
    ]);
    expect(findNumbers('On May 5, 200 came').map((n) => n.canonical)).toEqual([
      '200',
    ]);
  });

  it('still groups thousands and reads decimals in every notation', () => {
    const canon = (text: string): string[] =>
      findNumbers(text).map((n) => n.canonical);
    expect(canon('1,200 and 1 200 and 1.200 and 1\u00A0200')).toEqual([
      '1200',
      '1200',
      '1200',
      '1200',
    ]);
    expect(canon('1,200,000 or 1.200.000,5 or 12,34,567')).toEqual([
      '1200000',
      '1200000.5',
      '1234567',
    ]);
    expect(canon('1.5 and 1,5 and 12.75')).toEqual(['1.5', '1.5', '12.75']);
  });

  it('marks the magnitude as part of the number', () => {
    const text = 'About 8 million people.';
    const [found] = findNumbers(text);
    expect(text.slice(found.start, found.end)).toBe('8 million');
  });

  it('grounds a number in the key message as the brief itself', () => {
    const brief = briefWith([], { keyMessage: '3 million people need help' });
    expect(numberMarks('3 million are waiting', brief)).toEqual([BRIEF_ITSELF]);
    expect(numberMarks('4 million are waiting', brief)).toEqual([undefined]);
  });
});

describe('4. names', () => {
  it('checks a multi-word name at the start of a post', () => {
    expect(
      findNames('Robert Mugabe, our coordinator, said it was calm.').map(
        (n) => n.name,
      ),
    ).toEqual(['Robert Mugabe']);
    const brief = briefWith([
      item({ id: 'q1', attribution: { name: 'Amina Yusuf', role: 'nurse' } }),
    ]);
    const hits = ungroundedNames(
      [
        seg('s1', 'Robert Mugabe, our coordinator, said it was calm.'),
        seg('s2', 'Amina Yusuf was there too.'),
      ],
      brief,
    );
    expect(hits.map((h) => [h.segmentId, h.name])).toEqual([
      ['s1', 'Robert Mugabe'],
    ]);
  });

  it('still drops a word that only starts the sentence', () => {
    expect(
      findNames('The Clinic reopened. Yesterday Amina Yusuf spoke.').map(
        (n) => n.name,
      ),
    ).toEqual(['Amina Yusuf']);
    expect(findNames('Aid arrived. Nurses left.')).toEqual([]);
    // An ordinary first word does not make a known name unknown.
    const brief = briefWith([
      item({ id: 'q1', attribution: { name: 'Amina Yusuf' } }),
    ]);
    expect(
      ungroundedNames([seg('s1', 'Nurse Amina Yusuf spoke to us.')], brief),
    ).toEqual([]);
    expect(
      ungroundedNames([seg('s1', 'Nurse Jean Martin spoke to us.')], brief).map(
        (h) => h.name,
      ),
    ).toEqual(['Nurse Jean Martin']);
  });

  it('requires the words of a name to meet in one place in the brief', () => {
    const brief = briefWith(
      [
        item({ id: 'q1', attribution: { name: 'Amina Yusuf', role: 'nurse' } }),
        item({
          id: 'q2',
          text: 'The road was closed for a week',
          attribution: { name: 'John Smith' },
        }),
      ],
      { keyMessage: 'Aid must reach South Sudan now' },
    );
    const names = (text: string): string[] =>
      ungroundedNames([seg('s1', text)], brief).map((h) => h.name);
    expect(names('We heard from Amina Smith today.')).toEqual(['Amina Smith']);
    expect(names('We heard from John Yusuf today.')).toEqual(['John Yusuf']);
    expect(names('We heard from Amina Yusuf and John Smith.')).toEqual([]);
    expect(names('We work in South Sudan today.')).toEqual([]);
    expect(names('We work in South Yusuf today.')).toEqual(['South Yusuf']);
  });

  it('does not wave through a name made only of short words', () => {
    const brief = briefWith([item({ id: 'q1' })]);
    expect(
      ungroundedNames([seg('s1', 'We heard from Li Na today.')], brief).map(
        (h) => h.name,
      ),
    ).toEqual(['Li Na']);
  });
});

describe('5. partial quotations', () => {
  const brief = briefWith([
    item({ id: 'q1', text: 'We did not have enough water' }),
    item({ id: 'q2', text: "They didn't give us any food at all" }),
    item({ id: 'q3', text: 'Nous n’avons pas reçu assez de nourriture' }),
  ]);

  it('rejects a fragment cut inside a word', () => {
    expect(quoteMarks('“id not have enough wat”', brief)).toEqual([undefined]);
    expect(quoteMarks('“We did not have enough wat”', brief)).toEqual([
      undefined,
    ]);
    // Cutting "didn't" at the apostrophe drops the negation.
    expect(quoteMarks('“They didn”', brief)).toEqual([]);
    expect(quoteMarks('“t give us any food”', brief)).toEqual([undefined]);
  });

  it('rejects a part that starts right after a negation', () => {
    expect(quoteMarks('“have enough water”', brief)).toEqual([undefined]);
    expect(quoteMarks('“give us any food at all”', brief)).toEqual([undefined]);
    expect(quoteMarks('« reçu assez de nourriture »', brief)).toEqual([
      undefined,
    ]);
  });

  it('still grounds the whole quotation and an honest part of it', () => {
    expect(quoteMarks('“We did not have enough water”', brief)).toEqual(['q1']);
    expect(quoteMarks('“We did not have enough water.”', brief)).toEqual([
      'q1',
    ]);
    expect(quoteMarks('“did not have enough water”', brief)).toEqual(['q1']);
    expect(quoteMarks('“not have enough water”', brief)).toEqual(['q1']);
    expect(quoteMarks("“They didn't give us any food”", brief)).toEqual(['q2']);
  });

  it('does not carry a negation across a sentence end', () => {
    const two = briefWith([
      item({ id: 'q1', text: 'Did they help? No. We walked for three days' }),
    ]);
    expect(quoteMarks('“We walked for three days”', two)).toEqual(['q1']);
  });

  it('grounds a second, un-negated occurrence', () => {
    const twice = briefWith([
      item({
        id: 'q1',
        text: 'We did not have enough water. Now we have enough water',
      }),
    ]);
    expect(quoteMarks('“have enough water”', twice)).toEqual(['q1']);
  });

  it('matches quotations only against words somebody said', () => {
    const facts = briefWith([
      item({
        id: 'f1',
        kind: 'fact',
        text: 'The clinic was closed for eleven days in March',
      }),
      item({
        id: 'f2',
        kind: 'fact',
        text: 'The UN called it “the worst crisis in decades” last week',
      }),
    ]);
    // A fact's own wording was never said by anyone.
    expect(
      quoteMarks('“The clinic was closed for eleven days”', facts),
    ).toEqual([undefined]);
    // A quotation the reviewed fact itself carries in quotation marks is.
    expect(quoteMarks('“the worst crisis in decades”', facts)).toEqual(['f2']);
    expect(quoteMarks('“called it the worst crisis”', facts)).toEqual([
      undefined,
    ]);
    const testimony = briefWith([
      item({ id: 't1', kind: 'testimony', text: 'We slept in the open air' }),
    ]);
    expect(quoteMarks('“We slept in the open air”', testimony)).toEqual(['t1']);
  });
});

describe('6. attribution near the excerpt', () => {
  const range = { start: 0, end: 10 };

  it('does not confirm a speaker from inside another word', () => {
    expect(
      attributionNearExcerpt(
        'The quality of care fell, a nurse said.',
        range,
        'Sara Ali',
      ),
    ).toBe(false);
    expect(
      attributionNearExcerpt('It was said earlier today.', range, 'Wei Li'),
    ).toBe(false);
    expect(
      attributionNearExcerpt('The Martinez family left.', range, 'Jean Martin'),
    ).toBe(false);
  });

  it('confirms the full name, or the surname as a whole word', () => {
    expect(
      attributionNearExcerpt('“No water,” said Sara Ali.', range, 'Sara Ali'),
    ).toBe(true);
    expect(
      attributionNearExcerpt('“No water,” Dr Ali said.', range, 'Sara Ali'),
    ).toBe(true);
    expect(
      attributionNearExcerpt('In Ali’s words: no water.', range, 'Sara Ali'),
    ).toBe(true);
    // Accented names: `\b` would split "Peña" at the "ñ".
    expect(
      attributionNearExcerpt('“Sin agua”, dijo Peña.', range, 'María Peña'),
    ).toBe(true);
    expect(
      attributionNearExcerpt('“Sin agua”, dijo Peñalosa.', range, 'María Peña'),
    ).toBe(false);
    // A two-letter surname alone proves nothing; the full name still does.
    expect(attributionNearExcerpt('Li said so.', range, 'Wei Li')).toBe(false);
    expect(attributionNearExcerpt('Wei Li said so.', range, 'Wei Li')).toBe(
      true,
    );
  });
});

describe('hostile input stays fast', () => {
  const LIMIT = 6_000;
  const BUDGET_MS = 300;

  function fill(unit: string): string {
    return unit.repeat(Math.ceil(LIMIT / unit.length)).slice(0, LIMIT);
  }

  function timed(run: () => void): number {
    const started = performance.now();
    run();
    return performance.now() - started;
  }

  const hostile: Record<string, string> = {
    openers: fill('“'),
    asciiQuotes: fill('"'),
    apostrophes: fill("'a "),
    lowOpeners: fill('„a b c '),
    strayClosers: fill('a b c ” '),
    mixedMarks: fill('«‹‘“„"\'›»”’ x '),
    digits: fill('7'),
    groupedDigits: fill('1 234,'),
    separators: fill('1,'),
    magnitudes: fill('8 mil '),
    arabicDigits: fill('١٢٣ '),
    capitalised: fill('Aa '),
    particles: `A ${fill('de ')}`.slice(0, LIMIT),
    capitalThenSpaces: fill(`A${' '.repeat(40)}`),
    sentenceStarts: fill('. Aa Bb'),
  };

  for (const [name, text] of Object.entries(hostile)) {
    it(`findQuotedSpans, findNumbers and findNames on ${name}`, () => {
      expect(text.length).toBe(LIMIT);
      expect(timed(() => findQuotedSpans(text))).toBeLessThan(BUDGET_MS);
      expect(timed(() => findNumbers(text))).toBeLessThan(BUDGET_MS);
      expect(timed(() => findNames(text))).toBeLessThan(BUDGET_MS);
    });
  }

  it('grounds a hostile version against a full brief', () => {
    const brief = briefWith(
      Array.from({ length: 40 }, (_, index) =>
        item({
          id: `q${index}`,
          text: fill('a a a a not a a ').slice(0, 1_200),
          attribution: { name: 'Amina Yusuf' },
        }),
      ),
    );
    const segments = [
      seg('s1', fill('“a a a” ')),
      seg('s2', fill('Aa Bb 8 million “a a a a” ')),
    ];
    expect(timed(() => groundVersion(segments, brief))).toBeLessThan(2_000);
    expect(timed(() => ungroundedNames(segments, brief))).toBeLessThan(
      BUDGET_MS,
    );
  });

  it('checks an attribution in a hostile source', () => {
    const source = fill('alialiali ');
    expect(
      timed(() =>
        attributionNearExcerpt(
          source,
          { start: 3_000, end: 3_010 },
          'Sara Ali',
          LIMIT,
        ),
      ),
    ).toBeLessThan(BUDGET_MS);
  });
});
