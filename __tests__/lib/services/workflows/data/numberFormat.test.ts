import {
  detectColumnNumberFormat,
  formatNumberForDisplay,
  parseFormattedNumber,
} from '@/lib/services/workflows/data/numberFormat';

import { describe, expect, it } from 'vitest';

describe('parseFormattedNumber', () => {
  it('parses currency prefixes and suffixes', () => {
    expect(parseFormattedNumber('$25')).toEqual({
      value: 25,
      currency: '$',
      currencyPosition: 'prefix',
    });
    expect(parseFormattedNumber('€1.234,56')).toEqual({
      value: 1234.56,
      currency: '€',
      currencyPosition: 'prefix',
      styleEvidence: 'eu',
    });
    expect(parseFormattedNumber('25 EUR')).toMatchObject({
      value: 25,
      currency: 'EUR',
      currencyPosition: 'suffix',
    });
    expect(parseFormattedNumber('USD 25')).toMatchObject({
      value: 25,
      currency: 'USD',
      currencyPosition: 'prefix',
    });
    expect(parseFormattedNumber('R$ 12,50')).toMatchObject({
      value: 12.5,
      currency: 'R$',
      styleEvidence: 'eu',
    });
    expect(parseFormattedNumber('1 234 kr')).toMatchObject({
      value: 1234,
      currency: 'kr',
      currencyPosition: 'suffix',
    });
  });

  it('parses separator conventions and grouped numbers', () => {
    expect(parseFormattedNumber('3.77')).toMatchObject({
      value: 3.77,
      styleEvidence: 'us',
    });
    expect(parseFormattedNumber('1,234.56')).toMatchObject({
      value: 1234.56,
      styleEvidence: 'us',
    });
    expect(parseFormattedNumber('1.234,56')).toMatchObject({
      value: 1234.56,
      styleEvidence: 'eu',
    });
    expect(parseFormattedNumber('25,5')).toMatchObject({
      value: 25.5,
      styleEvidence: 'eu',
    });
    expect(parseFormattedNumber("1'234.5")).toMatchObject({ value: 1234.5 });
    expect(parseFormattedNumber('1 234 567')).toMatchObject({
      value: 1234567,
    });
  });

  it('resolves the ambiguous single-separator case by style', () => {
    // Default: US convention — comma groups, dot decimal.
    expect(parseFormattedNumber('1,234')).toMatchObject({ value: 1234 });
    expect(parseFormattedNumber('1.234')).toMatchObject({ value: 1.234 });
    expect(parseFormattedNumber('1,234', 'eu')).toMatchObject({
      value: 1.234,
    });
    expect(parseFormattedNumber('1.234', 'eu')).toMatchObject({ value: 1234 });
  });

  it('handles negatives, including accounting parentheses', () => {
    expect(parseFormattedNumber('-$5')).toMatchObject({ value: -5 });
    expect(parseFormattedNumber('$-5')).toMatchObject({ value: -5 });
    expect(parseFormattedNumber('(45)')).toMatchObject({ value: -45 });
  });

  it('rejects non-numeric strings and invalid groupings', () => {
    expect(parseFormattedNumber('Yes')).toBeNull();
    expect(parseFormattedNumber('License-based')).toBeNull();
    expect(parseFormattedNumber('')).toBeNull();
    expect(parseFormattedNumber('1,23,4')).toBeNull();
    expect(parseFormattedNumber('1 2')).toBeNull();
    expect(parseFormattedNumber('$')).toBeNull();
  });
});

describe('detectColumnNumberFormat', () => {
  it('detects a partially currency-tagged US column (the "$25" case)', () => {
    expect(detectColumnNumberFormat(['25', '200', '$25', '$3.77'])).toEqual({
      numberStyle: 'us',
      currency: '$',
    });
  });

  it('detects an EU-styled suffix-currency column', () => {
    expect(detectColumnNumberFormat(['1.234,56 €', '2,50 €'])).toEqual({
      numberStyle: 'eu',
      currency: '€',
      currencyPosition: 'suffix',
    });
  });

  it('returns {} for plain numbers (nothing to remember)', () => {
    expect(detectColumnNumberFormat([1, 2, '3'])).toEqual({});
  });

  it('vetoes mixed currencies and non-numeric cells', () => {
    expect(detectColumnNumberFormat(['$5', '€5'])).toBeNull();
    expect(detectColumnNumberFormat(['$5', 'Planned'])).toBeNull();
    expect(detectColumnNumberFormat([])).toBeNull();
  });

  it('accepts legacy plain forms the formatted parser rejects', () => {
    expect(detectColumnNumberFormat(['1e5', '2'])).toEqual({});
  });
});

describe('formatNumberForDisplay', () => {
  it('renders currency and locale separators', () => {
    expect(
      formatNumberForDisplay(1234.56, { currency: '$', numberStyle: 'us' }),
    ).toBe('$1,234.56');
    expect(
      formatNumberForDisplay(1234.56, {
        currency: '€',
        currencyPosition: 'suffix',
        numberStyle: 'eu',
      }),
    ).toBe('1.234,56 €');
    expect(formatNumberForDisplay(3.77, { currency: '$' })).toBe('$3.77');
  });
});
