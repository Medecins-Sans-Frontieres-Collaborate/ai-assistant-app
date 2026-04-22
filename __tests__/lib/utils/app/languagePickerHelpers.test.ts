import {
  LanguageOption,
  filterLanguageOptions,
  sortLanguageOptionsByLabel,
} from '@/lib/utils/app/languagePickerHelpers';

import { describe, expect, it } from 'vitest';

const options: LanguageOption[] = [
  { code: 'en', label: 'English', sublabel: 'English' },
  { code: 'es', label: 'Spanish', sublabel: 'Español' },
  { code: 'zh', label: 'Chinese', sublabel: '中文' },
  { code: 'my', label: 'Burmese', sublabel: 'မြန်မာ', supported: false },
];

describe('filterLanguageOptions', () => {
  it('returns the original list when query is empty', () => {
    expect(filterLanguageOptions(options, '')).toEqual(options);
    expect(filterLanguageOptions(options, '   ')).toEqual(options);
  });

  it('matches against label case-insensitively', () => {
    expect(filterLanguageOptions(options, 'eng').map((o) => o.code)).toEqual([
      'en',
    ]);
    expect(filterLanguageOptions(options, 'ENG').map((o) => o.code)).toEqual([
      'en',
    ]);
  });

  it('matches against sublabel', () => {
    expect(
      filterLanguageOptions(options, 'Español').map((o) => o.code),
    ).toEqual(['es']);
    expect(filterLanguageOptions(options, '中文').map((o) => o.code)).toEqual([
      'zh',
    ]);
  });

  it('matches against code', () => {
    expect(filterLanguageOptions(options, 'my').map((o) => o.code)).toEqual([
      'my',
    ]);
  });

  it('returns empty array when nothing matches', () => {
    expect(filterLanguageOptions(options, 'xyzzzz')).toEqual([]);
  });
});

describe('sortLanguageOptionsByLabel', () => {
  it('sorts alphabetically by label', () => {
    const sorted = sortLanguageOptionsByLabel(options).map((o) => o.code);
    expect(sorted).toEqual(['my', 'zh', 'en', 'es']);
  });

  it('does not mutate the input', () => {
    const snapshot = options.map((o) => o.code);
    sortLanguageOptionsByLabel(options);
    expect(options.map((o) => o.code)).toEqual(snapshot);
  });

  it('is case-insensitive', () => {
    const mixed: LanguageOption[] = [
      { code: 'a', label: 'banana' },
      { code: 'b', label: 'Apple' },
      { code: 'c', label: 'cherry' },
    ];
    const sorted = sortLanguageOptionsByLabel(mixed).map((o) => o.code);
    expect(sorted).toEqual(['b', 'a', 'c']);
  });
});
