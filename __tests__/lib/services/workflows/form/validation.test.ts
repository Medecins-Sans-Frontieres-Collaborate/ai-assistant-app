import {
  coerceInput,
  compilePattern,
  formatValue,
  isCalendarDate,
  isEmptyValue,
  isSafePattern,
  validateField,
} from '@/lib/services/workflows/form/validation';

import { FormField } from '@/types/formFill';

import { describe, expect, it } from 'vitest';

const base: FormField = {
  id: 'f',
  sectionId: 's',
  label: 'Field',
  type: 'text',
  required: false,
};

describe('isEmptyValue', () => {
  it('treats null, blank strings and blank lists as empty', () => {
    expect(isEmptyValue(null)).toBe(true);
    expect(isEmptyValue('   ')).toBe(true);
    expect(isEmptyValue(['', ' '])).toBe(true);
    expect(isEmptyValue(0)).toBe(false);
    expect(isEmptyValue(false)).toBe(false);
    expect(isEmptyValue(['a'])).toBe(false);
  });
});

describe('validateField', () => {
  it('flags required only when empty', () => {
    const field = { ...base, required: true };
    expect(validateField(field, null).map((i) => i.code)).toEqual(['required']);
    expect(validateField(field, 'x')).toEqual([]);
    expect(validateField(base, null)).toEqual([]);
  });

  it('applies text rules', () => {
    const field: FormField = {
      ...base,
      type: 'longtext',
      validation: { minWords: 3, maxChars: 12, pattern: '[A-Z].*' },
    };
    const codes = validateField(field, 'lower two').map((i) => i.code);
    expect(codes).toContain('minWords');
    expect(codes).toContain('pattern');
    expect(
      validateField(field, 'Alpha beta gamma delta').map((i) => i.code),
    ).toEqual(['maxChars']);
    expect(validateField(field, 'Alpha be ga')).toEqual([]);
  });

  it('never throws on an invalid regex', () => {
    const field: FormField = { ...base, validation: { pattern: '(' } };
    expect(() => validateField(field, 'x')).not.toThrow();
  });

  it('falls back to a non-unicode compile for legacy escapes and rejects unsafe patterns', () => {
    // `\-` outside a class is a SyntaxError under the u flag only.
    const field: FormField = {
      ...base,
      validation: { pattern: '[A-Z]{2}\\-\\d+' },
    };
    expect(validateField(field, 'zz').map((i) => i.code)).toEqual(['pattern']);
    expect(validateField(field, 'AB-12')).toEqual([]);
    expect(isSafePattern('(a+)+')).toBe(false);
    expect(isSafePattern('(\\d*)*')).toBe(false);
    expect(isSafePattern('([a-z]+ )+x')).toBe(false);
    expect(isSafePattern('[A-Z]{2}-\\d{4}')).toBe(true);
    expect(isSafePattern('(abc|def)+')).toBe(true);
    expect(isSafePattern('(a?)+')).toBe(true);
    expect(compilePattern('(a+)+')).toBeNull();
  });

  it('rejects calendar-invalid ISO dates', () => {
    expect(isCalendarDate('2024-02-29')).toBe(true);
    expect(isCalendarDate('2023-02-29')).toBe(false);
    expect(isCalendarDate('2024-02-30')).toBe(false);
    expect(
      validateField({ ...base, type: 'date' }, '2024-02-30').map((i) => i.code),
    ).toEqual(['type']);
  });

  it('validates numbers, dates, enums and booleans', () => {
    expect(
      validateField(
        { ...base, type: 'number', validation: { min: 1, max: 5 } },
        9,
      ).map((i) => i.code),
    ).toEqual(['max']);
    expect(
      validateField({ ...base, type: 'number' }, 'abc').map((i) => i.code),
    ).toEqual(['type']);
    expect(
      validateField(
        { ...base, type: 'date', validation: { dateAfter: '2024-01-01' } },
        '2023-12-31',
      ).map((i) => i.code),
    ).toEqual(['dateAfter']);
    expect(
      validateField({ ...base, type: 'date' }, '31/12/2023').map((i) => i.code),
    ).toEqual(['type']);
    expect(
      validateField(
        { ...base, type: 'enum', validation: { enumValues: ['A', 'B'] } },
        'C',
      ).map((i) => i.code),
    ).toEqual(['enum']);
    expect(
      validateField({ ...base, type: 'boolean' }, 'maybe').map((i) => i.code),
    ).toEqual(['type']);
    expect(validateField({ ...base, type: 'boolean' }, true)).toEqual([]);
  });

  it('validates lists', () => {
    const field: FormField = {
      ...base,
      type: 'list<number>',
      validation: { minItems: 2 },
    };
    expect(validateField(field, ['1']).map((i) => i.code)).toEqual([
      'minItems',
    ]);
    expect(validateField(field, ['1', 'x']).map((i) => i.code)).toEqual([
      'type',
    ]);
    expect(validateField(field, ['1', '2'])).toEqual([]);
  });
});

describe('coerceInput / formatValue', () => {
  it('coerces by type and keeps unparseable input for the validator', () => {
    expect(coerceInput({ ...base, type: 'number' }, '1,200')).toBe(1200);
    expect(coerceInput({ ...base, type: 'number' }, 'ten')).toBe('ten');
    expect(coerceInput({ ...base, type: 'boolean' }, 'Yes')).toBe(true);
    expect(
      coerceInput({ ...base, type: 'list<text>' }, '- a\n- b\n\n'),
    ).toEqual(['a', 'b']);
    expect(coerceInput(base, '  ')).toBeNull();
  });

  it('formats round-trip', () => {
    expect(formatValue(['a', 'b'])).toBe('a\nb');
    expect(formatValue(true)).toBe('Yes');
    expect(formatValue(null)).toBe('');
  });
});
