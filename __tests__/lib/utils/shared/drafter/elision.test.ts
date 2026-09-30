import { normalizeForQuoteMatch } from '@/lib/utils/app/citationQuotes';
import {
  MAX_ELISION_GAP_CHARS,
  MAX_MATCH_ATTEMPTS,
  matchQuotation,
  negatedBefore,
  parseQuotation,
} from '@/lib/utils/shared/drafter/core/elision';

import { describe, expect, it } from 'vitest';

const NONE = (): boolean => false;

/** Matches a quotation's inner text against an item as the brief holds it. */
function match(
  item: string,
  inner: string,
  allowed: (word: string) => boolean = NONE,
) {
  return matchQuotation(normalizeForQuoteMatch(item), inner, allowed);
}

/** The matched runs as the item's own words. */
function piecesOf(item: string, inner: string, allowed = NONE): string[] {
  const hay = normalizeForQuoteMatch(item);
  const found = match(item, inner, allowed);
  return found ? found.pieces.map((p) => hay.slice(p.start, p.end)) : [];
}

const ITEM = 'We had no clean water for eleven days';

describe('parseQuotation', () => {
  it('reads every way of writing an ellipsis as a gap', () => {
    for (const gap of ['…', '...', '. . .', '[…]', '[...]', '(…)', '(...)']) {
      const parsed = parseQuotation(`We had no clean water ${gap} eleven days`);
      expect(parsed, gap).not.toBeNull();
      expect(parsed?.plain, gap).toBe(false);
      expect(
        parsed?.fragments.map((f) => f.text),
        gap,
      ).toEqual(['we had no clean water', 'eleven days']);
      expect(parsed?.insertions, gap).toEqual([]);
    }
  });

  it('reads [word] runs as insertions with raw offsets', () => {
    const inner = '[The team] had no clean water … [for] eleven long days';
    const parsed = parseQuotation(inner);
    expect(parsed?.plain).toBe(false);
    const at = (text: string) => inner.indexOf(text);
    expect(parsed?.insertions).toEqual([
      { start: 0, end: '[The team]'.length, words: ['the', 'team'] },
      { start: at('[for]'), end: at('[for]') + '[for]'.length, words: ['for'] },
    ]);
    expect(parsed?.fragments.map((f) => f.text)).toEqual([
      'had no clean water',
      'eleven long days',
    ]);
  });

  it('gives fragments raw offsets that exclude the whitespace at their edges', () => {
    const inner = 'We had no clean water … for eleven days.';
    const parsed = parseQuotation(inner);
    const raws = parsed?.fragments.map((f) =>
      inner.slice(f.raw.start, f.raw.end),
    );
    expect(raws).toEqual(['We had no clean water', 'for eleven days.']);
    expect(parsed?.fragments[1].bare).toBe('for eleven days');
    expect(parsed?.fragments[0].bare).toBeUndefined();
  });

  it('refuses a nested bracket', () => {
    expect(
      parseQuotation('We had [no [clean] water] for eleven days'),
    ).toBeNull();
  });

  it('refuses an insertion of six words', () => {
    expect(
      parseQuotation('[The team on the ground here] had no clean water'),
    ).toBeNull();
    expect(
      parseQuotation('[The team on the ground] had no clean water'),
    ).not.toBeNull();
  });

  it('refuses an insertion holding a digit', () => {
    expect(parseQuotation('We had no clean water for [11] days')).toBeNull();
    expect(parseQuotation('We had no clean water for [١١] days')).toBeNull();
  });

  it('refuses an insertion holding a polarity word', () => {
    for (const word of ['not', 'only', 'almost', 'jamais', "n'avons"]) {
      expect(
        parseQuotation(`We had [${word}] clean water for eleven days`),
        word,
      ).toBeNull();
    }
  });

  it('drops a leading and a trailing gap, but keeps the quotation elided', () => {
    const parsed = parseQuotation('… had no clean water for eleven days …');
    expect(parsed?.fragments.map((f) => f.text)).toEqual([
      'had no clean water for eleven days',
    ]);
    expect(parsed?.plain).toBe(false);
  });

  it('refuses a fragment of one word', () => {
    expect(parseQuotation('We had no clean water … days')).toBeNull();
    expect(parseQuotation('We … had no clean water')).toBeNull();
  });

  it('refuses fewer than three verbatim words in all', () => {
    expect(parseQuotation('We had … no water')).not.toBeNull();
    expect(parseQuotation('We had …')).toBeNull();
    expect(parseQuotation('no water')).toBeNull();
    expect(parseQuotation('')).toBeNull();
    expect(parseQuotation('…')).toBeNull();
  });

  it('marks a whole quotation as plain', () => {
    const parsed = parseQuotation('We had no clean water for eleven days.');
    expect(parsed?.plain).toBe(true);
    expect(parsed?.fragments).toHaveLength(1);
    expect(parsed?.fragments[0].bare).toBe(
      'we had no clean water for eleven days',
    );
  });

  it('treats an unclosed bracket as a character of the quotation', () => {
    const parsed = parseQuotation('We had no clean water [sic for eleven days');
    expect(parsed?.plain).toBe(true);
    expect(parsed?.fragments[0].text).toBe(
      'we had no clean water [sic for eleven days',
    );
  });
});

describe('matchQuotation: elisions', () => {
  it('grounds an ellipsis inside one item, with the pieces in order', () => {
    const found = match(ITEM, 'We had no clean water … eleven days');
    expect(found).not.toBeNull();
    expect(found?.elided).toBe(true);
    expect(piecesOf(ITEM, 'We had no clean water … eleven days')).toEqual([
      'we had no clean water',
      'eleven days',
    ]);
    expect(found?.verbatim).toEqual([
      { start: 0, end: 21 },
      { start: 24, end: 35 },
    ]);
    expect(found?.insertions).toEqual([]);
  });

  it('is not shortened when the ellipsis left nothing out [R4]', () => {
    const found = match(ITEM, 'We had no clean water … for eleven days');
    expect(found).not.toBeNull();
    expect(found?.elided).toBe(false);
    expect(piecesOf(ITEM, 'We had no clean water … for eleven days')).toEqual([
      'we had no clean water',
      'for eleven days',
    ]);
  });

  it('tolerates a full stop after the last fragment', () => {
    expect(piecesOf(ITEM, 'We had no clean water … eleven days.')).toEqual([
      'we had no clean water',
      'eleven days',
    ]);
  });

  it('admits an insertion only when the item carries the word', () => {
    const inner = '[The team] had no clean water … eleven days';
    expect(match(ITEM, inner)).toBeNull();
    const allowed = (word: string): boolean => word === 'team';
    const found = match(ITEM, inner, allowed);
    expect(found?.elided).toBe(true);
    expect(found?.insertions).toEqual([{ start: 0, end: 10 }]);
    expect(piecesOf(ITEM, inner, allowed)).toEqual([
      'had no clean water',
      'eleven days',
    ]);
  });

  it('refuses an insertion the item never mentions', () => {
    const item = 'They bombed the hospital twice and we fled';
    expect(match(item, '[The army] bombed the hospital twice')).toBeNull();
    expect(
      match(item, '[The army] bombed the hospital twice', (w) => w === 'army'),
    ).not.toBeNull();
  });

  it('always allows grammar words and verbs of saying in an insertion', () => {
    expect(
      match(ITEM, 'We had no clean water [for] eleven days'),
    ).not.toBeNull();
    expect(
      match(ITEM, 'We had no clean water [she said] for eleven days'),
    ).not.toBeNull();
  });

  it('refuses a gap that hides a negation', () => {
    expect(
      match('we did not have enough water', 'We had … enough water'),
    ).toBeNull();
    expect(
      match('we did not have enough water', 'We did … enough water'),
    ).toBeNull();
  });

  it('refuses a fragment that ends in a negator before a gap', () => {
    expect(
      match('We could not go, but we could stay.', 'We could not … stay'),
    ).toBeNull();
    expect(
      match('We could not go, but we could stay.', 'We could not … could stay'),
    ).toBeNull();
  });

  it('refuses a gap that hides a contrast', () => {
    expect(
      match(
        'Access was denied on Monday but granted on Friday',
        'Access was … granted on Friday',
      ),
    ).toBeNull();
  });

  it('refuses a gap that hides a scope word', () => {
    const item = 'We almost lost the whole ward that night';
    expect(match(item, 'We … lost the whole ward that night')).toBeNull();
    const team = 'The team almost lost the whole ward that night';
    expect(match(team, 'The team … lost the whole ward that night')).toBeNull();
    expect(
      match('The team nearly lost the whole ward', 'The team … the whole ward'),
    ).toBeNull();
  });

  it('refuses a gap longer than the limit', () => {
    const filler = 'and the days went by slowly '.repeat(
      Math.ceil(MAX_ELISION_GAP_CHARS / 28) + 1,
    );
    const item = `We had no clean water ${filler}for eleven days`;
    expect(match(item, 'We had no clean water … for eleven days')).toBeNull();
    const short = 'We had no clean water and the days went by for eleven days';
    expect(
      match(short, 'We had no clean water … for eleven days'),
    ).not.toBeNull();
  });

  it('refuses fragments out of order', () => {
    expect(match(ITEM, 'eleven days … clean water')).toBeNull();
  });

  it('refuses a fragment the item does not carry', () => {
    expect(match(ITEM, 'We had no clean water … twelve days')).toBeNull();
    expect(match(ITEM, 'We had no dirty water … eleven days')).toBeNull();
  });

  it('gives up after the attempt limit on a hostile item', () => {
    const unit = 'we walked far. ';
    const tail = 'we walked far and then home';
    const hostile = unit.repeat(MAX_MATCH_ATTEMPTS + 20) + tail;
    expect(match(hostile, 'we walked far … then home')).toBeNull();
    const tame = unit.repeat(MAX_MATCH_ATTEMPTS - 20) + tail;
    expect(match(tame, 'we walked far … then home')).not.toBeNull();
  });

  it('skips a first occurrence whose continuation fails', () => {
    const item =
      'We had no clean water and no food. We had no clean water for eleven days';
    expect(piecesOf(item, 'We had no clean water … eleven days')).toEqual([
      'we had no clean water',
      'eleven days',
    ]);
    const found = match(item, 'We had no clean water … eleven days');
    expect(found?.pieces[0].start).toBe(35);
  });

  it('refuses a French elision that drops "plus" after n\'avons', () => {
    const item = 'Nous n’avons plus de médicaments depuis mars';
    expect(match(item, 'Nous n’avons … de médicaments')).toBeNull();
    expect(match(item, 'avons plus de médicaments')).toBeNull();
    expect(match(item, 'Nous n’avons plus de médicaments')).not.toBeNull();
  });
});

describe("matchQuotation: the plain path keeps today's behaviour", () => {
  const q1 = 'We did not have enough water';
  const q2 = "They didn't give us any food at all";
  const q3 = 'Nous n’avons pas reçu assez de nourriture';

  it('returns elided:false with the whole quotation as verbatim', () => {
    const found = match(q1, 'We did not have enough water.');
    expect(found).toEqual({
      pieces: [{ start: 0, end: q1.length }],
      elided: false,
      verbatim: [{ start: 0, end: 'We did not have enough water.'.length }],
      insertions: [],
    });
  });

  it('rejects a fragment cut inside a word', () => {
    expect(match(q1, 'id not have enough wat')).toBeNull();
    expect(match(q1, 'We did not have enough wat')).toBeNull();
    expect(match(q2, 't give us any food')).toBeNull();
  });

  it('rejects a part that starts right after a negation', () => {
    expect(match(q1, 'have enough water')).toBeNull();
    expect(match(q2, 'give us any food at all')).toBeNull();
    expect(match(q3, 'reçu assez de nourriture')).toBeNull();
  });

  it('still grounds the whole quotation and an honest part of it', () => {
    expect(match(q1, 'We did not have enough water')).not.toBeNull();
    expect(match(q1, 'We did not have enough water.')).not.toBeNull();
    expect(match(q1, 'did not have enough water')).not.toBeNull();
    expect(match(q1, 'not have enough water')).not.toBeNull();
    expect(match(q2, "They didn't give us any food")).not.toBeNull();
  });

  it('does not carry a negation across a sentence end', () => {
    expect(
      match(
        'Did they help? No. We walked for three days',
        'We walked for three days',
      ),
    ).not.toBeNull();
  });

  it('grounds a second, un-negated occurrence', () => {
    const twice = 'We did not have enough water. Now we have enough water';
    const found = match(twice, 'have enough water');
    expect(found?.pieces).toEqual([{ start: 37, end: 54 }]);
  });

  it('never matches an empty or too-short quotation', () => {
    expect(match(q1, '')).toBeNull();
    expect(match(q1, 'enough water')).toBeNull();
  });
});

describe("the speaker's own ellipsis [R1]", () => {
  const cases: Array<[string, string]> = [
    [
      'No... we had nothing left to drink',
      'No... we had nothing left to drink',
    ],
    [
      'We had nothing... nothing at all for the children',
      'We had nothing... nothing at all for the children',
    ],
    [
      'We could not... we could not stay in the village',
      'We could not... we could not stay in the village',
    ],
    [
      'I thought… I thought we would all die there',
      'I thought… I thought we would all die there',
    ],
  ];

  it('grounds a quotation that repeats the item, dots and all, as whole', () => {
    for (const [item, inner] of cases) {
      const found = match(item, inner);
      expect(found, inner).not.toBeNull();
      expect(found?.elided, inner).toBe(false);
      expect(found?.pieces, inner).toEqual([
        { start: 0, end: normalizeForQuoteMatch(item).length },
      ]);
      // The whole inner text is the speaker's, ellipsis included.
      expect(found?.verbatim, inner).toEqual([{ start: 0, end: inner.length }]);
    }
  });

  it('matches either spelling of the ellipsis and a trailing full stop', () => {
    expect(
      match('No... we had nothing left', 'No… we had nothing left'),
    ).not.toBeNull();
    expect(
      match('No… we had nothing left', 'No... we had nothing left.'),
    ).not.toBeNull();
    expect(
      match(
        'I thought… I thought we would die',
        'I thought . . . I thought we would die',
      ),
    ).not.toBeNull();
  });

  it('still reads an ellipsis the item lacks as a gap', () => {
    // The item has a comma there: "No" is then a one-word run, refused.
    expect(
      match(
        'No, we had nothing left to drink',
        'No... we had nothing left to drink',
      ),
    ).toBeNull();
    // A gap over nothing severs nothing: whole, and not shortened.
    const pause = match(
      'We could not stay in the village',
      'We could not... stay in the village',
    );
    expect(pause).not.toBeNull();
    expect(pause?.elided).toBe(false);
  });
});

describe('gaps at the edges [EQ-3, EQ-8]', () => {
  it('refuses a trailing gap after a negator or a scope word', () => {
    const item = 'We could not have asked for better care from the team';
    expect(match(item, 'We could not …')).toBeNull();
    expect(match(item, 'We could not ...')).toBeNull();
    expect(match('We only wanted to leave the camp', 'We only …')).toBeNull();
    expect(match(item, 'We could not have asked …')).not.toBeNull();
  });

  it('refuses a trailing gap that drops a contrast in the same sentence', () => {
    const item = 'We wanted to leave, but we could not';
    expect(match(item, 'We wanted to leave …')).toBeNull();
    expect(
      match('We wanted to leave. But we stayed', 'We wanted to leave …'),
    ).not.toBeNull();
  });

  it('marks an honest trailing gap as shortened', () => {
    const found = match(ITEM, 'We had no clean water …');
    expect(found?.elided).toBe(true);
    expect(piecesOf(ITEM, 'We had no clean water …')).toEqual([
      'we had no clean water',
    ]);
    // Nothing after the run: the ellipsis is the speaker's, or trails off.
    expect(
      match('We had no clean water…', 'We had no clean water…')?.elided,
    ).toBe(false);
  });

  it('holds a leading gap to the same rule as an inner gap', () => {
    const item = 'we almost lost the clinic that night';
    expect(match(item, '… lost the clinic')).toBeNull();
    expect(match(item, '... lost the clinic that night')).toBeNull();
    expect(
      match('we did not lose the clinic that night', '… the clinic that night'),
    ).toBeNull();
    const honest = match('That night we lost the clinic', '… lost the clinic');
    expect(honest?.elided).toBe(true);
    // The previous sentence is not part of the gap.
    expect(
      match('We only had bread. We lost the clinic', '… we lost the clinic'),
    ).not.toBeNull();
  });
});

describe('an ellipsis followed by punctuation [EQ-4]', () => {
  it('parses “…,” “….” “…!” and a spaced dotted gap', () => {
    for (const inner of [
      'We had no clean water…,',
      'We had no clean water….',
      'We had no clean water…!',
      'We had no clean water ...,',
      'We had no clean water .  .  . eleven days',
    ]) {
      const found = match(ITEM, inner);
      expect(found, inner).not.toBeNull();
      expect(found?.elided, inner).toBe(true);
    }
    expect(piecesOf(ITEM, 'We had no clean water .  .  . eleven days')).toEqual(
      ['we had no clean water', 'eleven days'],
    );
  });

  it('keeps refusing a gap that only skips one word to a one-word run', () => {
    expect(match(ITEM, 'We had no clean water…, days')).toBeNull();
  });
});

describe('insertions with quantities [EQ-2]', () => {
  const item =
    'We treated 1,200 patients in March. The region has 3 million people and twelve clinics.';
  const allowed = (word: string): boolean =>
    ['milli', 'million', 'twelve', 'clinic', 'clinics', 'region'].includes(
      word,
    );

  it('refuses a magnitude word, a spelled-out number and a bare symbol', () => {
    for (const inner of [
      'We treated 1,200 [million] patients in March',
      'We treated 1,200 [%] patients in March',
      'We treated [twelve] patients in March',
      'We treated 1,200 [thousand] patients in March',
      'We treated [half] the patients in March',
      'We treated 1,200 [+] patients in March',
    ]) {
      expect(parseQuotation(inner), inner).toBeNull();
      expect(match(item, inner, allowed), inner).toBeNull();
    }
  });

  it('still admits an insertion of ordinary words the item carries', () => {
    expect(
      match(
        item,
        'We treated 1,200 patients [in the region] in March',
        allowed,
      ),
    ).not.toBeNull();
  });
});

describe('a negation earlier in the clause [F4]', () => {
  const item = 'We did not have enough clean water for eleven days';

  it('refuses a run that starts after the negated verb, with or without an insertion', () => {
    expect(
      match(item, '[We had] enough clean water for eleven days'),
    ).toBeNull();
    expect(match(item, 'enough clean water for eleven days')).toBeNull();
    expect(match(item, 'clean water for eleven days')).toBeNull();
  });

  it('keeps the negation inside the quotation and stops at a clause break', () => {
    expect(match(item, 'did not have enough clean water')).not.toBeNull();
    expect(
      match(item, 'not have enough clean water for eleven days'),
    ).not.toBeNull();
    const clauses = 'We did not have enough water, and the children fell ill';
    expect(match(clauses, 'the children fell ill')).not.toBeNull();
    const joined = 'We did not have enough water and the children fell ill';
    expect(match(joined, 'the children fell ill')).not.toBeNull();
  });

  it('refuses the French ne…plus family and a leading "seul" [F9]', () => {
    const fq = 'Nous n’avions plus d’eau potable depuis onze jours';
    expect(match(fq, 'd’eau potable depuis onze jours')).toBeNull();
    expect(match(fq, 'Nous n’avions plus d’eau potable')).not.toBeNull();
    expect(
      match('Il n’y avait personne pour nous aider', 'pour nous aider ici'),
    ).toBeNull();
    expect(
      match(
        'Seuls les enfants ont été nourris ce jour',
        'les enfants ont été nourris ce jour',
      ),
    ).not.toBeNull();
    expect(
      match(
        'Seuls les enfants ont été nourris ce jour',
        '… les enfants ont été nourris ce jour',
      ),
    ).toBeNull();
  });
});

describe('Arabic negators with an attached prefix [EQ-1]', () => {
  it('refuses a gap that drops ولم / ولا', () => {
    expect(
      match('وجدنا ماء ولم نجد طعاما في المخيم', 'وجدنا ماء … طعاما في المخيم'),
    ).toBeNull();
    expect(
      match('وجدنا ماء ولا طعام في المخيم', 'وجدنا ماء … في المخيم'),
    ).toBeNull();
    expect(
      match('وجدنا ماء فلم نجد طعاما في المخيم', 'وجدنا ماء … طعاما في المخيم'),
    ).toBeNull();
  });

  it('refuses a run that starts right after ولم', () => {
    expect(
      match('وجدنا ماء ولم نجد طعاما في المخيم', 'نجد طعاما في المخيم'),
    ).toBeNull();
    expect(
      match('وجدنا ماء ولم نجد طعاما في المخيم', 'ولم نجد طعاما في المخيم'),
    ).not.toBeNull();
  });

  it('refuses a run ending in فلا before a gap and an insertion of ولا', () => {
    expect(
      match('قالوا فلا تخرجوا من البيت أبدا', 'قالوا فلا … من البيت أبدا'),
    ).toBeNull();
    expect(parseQuotation('وجدنا ماء [ولا] طعاما في المخيم')).toBeNull();
  });
});

describe('negatedBefore', () => {
  it('finds a negator, a contraction or an elided ne before the word', () => {
    expect(negatedBefore('we did not have water', 11)).toBe(true);
    expect(negatedBefore("they didn't give us food", 12)).toBe(true);
    expect(negatedBefore("nous n'avons plus de pain", 13)).toBe(true);
    expect(negatedBefore('nobody helped us at all', 7)).toBe(true);
  });

  it('looks back over the whole clause, bounded by the floor', () => {
    const text = 'we did not have enough clean water';
    expect(negatedBefore(text, 16)).toBe(true);
    expect(negatedBefore(text, 22)).toBe(true);
    // Words before the floor are already part of the quotation.
    expect(negatedBefore(text, 22, 16)).toBe(false);
    expect(negatedBefore('we did not go, but we could stay', 24)).toBe(false);
    expect(negatedBefore('we did not go and we could stay', 22)).toBe(false);
    expect(negatedBefore('وجدنا ماء ولم نجد طعاما في المخيم', 14)).toBe(true);
  });

  it('stops at a sentence end and ignores scope words', () => {
    expect(negatedBefore('did they help? no. we walked', 19)).toBe(false);
    expect(negatedBefore('we almost lost the ward', 10)).toBe(false);
    expect(negatedBefore('we had water', 3)).toBe(false);
    expect(negatedBefore('we had water', 0)).toBe(false);
  });
});

describe('an inner gap that leaves the ends disconnected', () => {
  it('refuses a gap of more than eight words, whatever its letters', async () => {
    const { countWords, matchQuotation } =
      await import('@/lib/utils/shared/drafter/core/elision');
    const item =
      'the new deal gilead announced with paho this week comes after the company first blocked people across latin america and the caribbean from accessing affordable generic versions of lenacapavir';
    expect(countWords(item)).toBe(29);
    expect(
      matchQuotation(
        item,
        'the new deal … affordable generic versions of lenacapavir',
        () => false,
      ),
    ).toBeNull();
    // Five words out still reads as one sentence.
    expect(
      matchQuotation(
        item,
        'the new deal gilead announced with paho this week comes after … across latin america and the caribbean from accessing affordable generic versions of lenacapavir',
        () => false,
      ),
    ).not.toBeNull();
  });
});
