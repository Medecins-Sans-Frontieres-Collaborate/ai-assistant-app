import {
  ABBREVIATIONS_ALWAYS,
  ABBREVIATIONS_BEFORE_NUMBER,
  CAUSAL_CONNECTORS,
  CLAUSE_CONJUNCTIONS,
  CONTRAST_WORDS,
  MAGNITUDE_WORDS,
  MODALS,
  NEGATORS,
  NUMBER_WORDS,
  POLARITY_WORDS,
  SAYING_VERBS,
  SCOPE_CHANGERS,
  STOP_WORDS,
  foldKey,
  isContrastWord,
  isNegatorWord,
  isPolarityWord,
  isQuantityWord,
  isScopeWord,
} from '@/lib/utils/shared/drafter/core/wordLists';

import { describe, expect, it } from 'vitest';

function intersection(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): string[] {
  return [...a].filter((word) => b.has(word)).sort();
}

const ALL_LISTS: Array<[string, ReadonlySet<string>]> = [
  ['NEGATORS', NEGATORS],
  ['SCOPE_CHANGERS', SCOPE_CHANGERS],
  ['POLARITY_WORDS', POLARITY_WORDS],
  ['CONTRAST_WORDS', CONTRAST_WORDS],
  ['CAUSAL_CONNECTORS', CAUSAL_CONNECTORS],
  ['MODALS', MODALS],
  ['SAYING_VERBS', SAYING_VERBS],
  ['STOP_WORDS', STOP_WORDS],
  ['CLAUSE_CONJUNCTIONS', CLAUSE_CONJUNCTIONS],
  ['ABBREVIATIONS_ALWAYS', ABBREVIATIONS_ALWAYS],
  ['ABBREVIATIONS_BEFORE_NUMBER', ABBREVIATIONS_BEFORE_NUMBER],
  ['MAGNITUDE_WORDS', MAGNITUDE_WORDS],
  ['NUMBER_WORDS', NUMBER_WORDS],
];

describe('word list invariants', () => {
  it('STOP_WORDS never swallows a polarity, contrast, causal or modal word', () => {
    expect(intersection(STOP_WORDS, POLARITY_WORDS)).toEqual([]);
    expect(intersection(STOP_WORDS, CONTRAST_WORDS)).toEqual([]);
    expect(intersection(STOP_WORDS, CAUSAL_CONNECTORS)).toEqual([]);
    expect(intersection(STOP_WORDS, MODALS)).toEqual([]);
  });

  it('STOP_WORDS never swallows a number or magnitude word', () => {
    expect(intersection(STOP_WORDS, MAGNITUDE_WORDS)).toEqual([]);
    expect(intersection(STOP_WORDS, NUMBER_WORDS)).toEqual([]);
  });

  it('SAYING_VERBS is disjoint from POLARITY_WORDS', () => {
    expect(intersection(SAYING_VERBS, POLARITY_WORDS)).toEqual([]);
  });

  it('keeps the words that must never be grammar', () => {
    for (const word of ['not', 'only', 'sin', 'mai', 'no', 'ne', 'werden']) {
      expect(STOP_WORDS.has(word), word).toBe(false);
    }
  });

  it('holds every entry lowercase and with its folded twin', () => {
    for (const [name, list] of ALL_LISTS) {
      for (const word of list) {
        expect(word, `${name}: ${word}`).toBe(word.toLowerCase());
        expect(list.has(foldKey(word)), `${name}: ${word}`).toBe(true);
      }
    }
  });

  it('POLARITY_WORDS is the union of negators and scope changers', () => {
    expect(POLARITY_WORDS.size).toBe(
      new Set([...NEGATORS, ...SCOPE_CHANGERS]).size,
    );
    expect(POLARITY_WORDS.has('almost')).toBe(true);
    expect(POLARITY_WORDS.has('nunca')).toBe(true);
  });

  it('CLAUSE_CONJUNCTIONS holds the contrast words and the joiners', () => {
    for (const word of ['but', 'mais', 'and', 'et', 'y', 'und', 'e']) {
      expect(CLAUSE_CONJUNCTIONS.has(word), word).toBe(true);
    }
    for (const word of ['because', 'weil', 'while', 'mientras', 'بينما']) {
      expect(CLAUSE_CONJUNCTIONS.has(word), word).toBe(true);
    }
  });

  it('covers every listed language with a sample per list', () => {
    const samples: Array<[ReadonlySet<string>, string[]]> = [
      [NEGATORS, ['never', 'jamais', 'nunca', 'nicht', 'não', 'senza', 'لا']],
      [SCOPE_CHANGERS, ['only', 'presque', 'casi', 'nur', 'apenas', 'فقط']],
      [CONTRAST_WORDS, ['but', 'mais', 'pero', 'aber', 'porém', 'ma', 'لكن']],
      [
        CAUSAL_CONNECTORS,
        ['because', 'parce', 'porque', 'weil', 'perché', 'بسبب'],
      ],
      [MODALS, ['could', 'pourrait', 'podría', 'könnte', 'poderia', 'سوف']],
      [SAYING_VERBS, ['said', 'dit', 'dijo', 'sagte', 'disse', 'detto', 'قال']],
      [STOP_WORDS, ['the', 'les', 'los', 'der', 'das', 'gli', 'في']],
    ];
    for (const [list, words] of samples) {
      for (const word of words) expect(list.has(word), word).toBe(true);
    }
  });
});

describe('foldKey', () => {
  it('strips accents and lowercases', () => {
    expect(foldKey('état')).toBe('etat');
    expect(foldKey('ÉCOLE')).toBe('ecole');
    expect(foldKey('Straße')).toBe('straße');
    expect(foldKey('naïve')).toBe('naive');
  });

  it('strips Arabic vowel marks and unifies alif, ta marbuta and alif maqsura', () => {
    expect(foldKey('العِيَادَة')).toBe('العياده');
    expect(foldKey('أطفال')).toBe('اطفال');
    expect(foldKey('إلى')).toBe('الي');
    expect(foldKey('مـــستشفى')).toBe('مستشفي');
  });

  it('keeps apostrophes, so contracted negations stay recognisable', () => {
    expect(foldKey("N'AVONS")).toBe("n'avons");
    expect(foldKey("didn't")).toBe("didn't");
  });
});

describe('isNegatorWord and isPolarityWord', () => {
  it('recognises listed negators and the contracted forms', () => {
    expect(isNegatorWord('not')).toBe(true);
    expect(isNegatorWord('jamas')).toBe(true);
    expect(isNegatorWord("n'avons")).toBe(true);
    expect(isNegatorWord("didn't")).toBe(true);
    expect(isNegatorWord('nobody')).toBe(true);
    expect(isNegatorWord('rien')).toBe(true);
    expect(isNegatorWord('water')).toBe(false);
    expect(isNegatorWord('only')).toBe(false);
  });

  it('counts scope changers as polarity but not ordinary words', () => {
    expect(isPolarityWord('only')).toBe(true);
    expect(isPolarityWord('almost')).toBe(true);
    expect(isPolarityWord("n'ont")).toBe(true);
    expect(isPolarityWord('clean')).toBe(false);
    expect(isPolarityWord('but')).toBe(false);
  });

  it('holds the French ne…plus family and "seul" [F9]', () => {
    for (const word of ['plus', 'personne', 'nul', 'nulle', 'point']) {
      expect(isNegatorWord(word), word).toBe(true);
    }
    for (const word of ['seul', 'seule', 'seuls', 'seules']) {
      expect(isScopeWord(word), word).toBe(true);
      expect(isNegatorWord(word), word).toBe(false);
    }
  });

  it('reads an Arabic negator or scope word through an attached و/ف prefix [EQ-1]', () => {
    for (const word of ['ولم', 'ولا', 'ولن', 'وليس', 'فلم', 'فلا', 'فليس']) {
      expect(isNegatorWord(foldKey(word)), word).toBe(true);
      expect(isPolarityWord(foldKey(word)), word).toBe(true);
    }
    expect(isScopeWord(foldKey('وفقط'))).toBe(true);
    expect(isContrastWord(foldKey('ولكن'))).toBe(true);
    expect(isContrastWord(foldKey('وإلا'))).toBe(true);
    // Not every word starting with و hides a negator.
    expect(isNegatorWord(foldKey('ولد'))).toBe(false);
    expect(isNegatorWord(foldKey('وجدنا'))).toBe(false);
    expect(isNegatorWord('و')).toBe(false);
  });
});

describe('isQuantityWord', () => {
  it('names magnitudes and spelled-out numbers in every listed language', () => {
    for (const word of [
      'million',
      'thousand',
      'percent',
      'half',
      'twelve',
      'mille',
      'douze',
      'millones',
      'doce',
      'prozent',
      'zwölf',
      'milhões',
      'doze',
      'mila',
      'dodici',
      'مليون',
      'عشرة',
    ]) {
      expect(isQuantityWord(foldKey(word)), word).toBe(true);
    }
    for (const word of ['water', 'patients', 'the', 'un', 'a', 'sei']) {
      expect(isQuantityWord(word), word).toBe(false);
    }
  });
});
