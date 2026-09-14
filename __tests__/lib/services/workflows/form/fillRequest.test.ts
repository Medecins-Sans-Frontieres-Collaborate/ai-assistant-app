import {
  collectCallerFills,
  isFieldFill,
} from '@/lib/services/workflows/form/fillRequest';

import { describe, expect, it } from 'vitest';

const fill = (value: unknown) => ({ value, provenance: [] });

describe('collectCallerFills', () => {
  it('keeps only fills whose key names a template field', () => {
    const fills = collectCallerFills(
      { a: fill('x'), b: fill('y'), zzz: fill('dropped') },
      new Set(['a', 'b']),
    );
    expect(Object.keys(fills)).toEqual(['a', 'b']);
    expect(fills.a).toEqual(fill('x'));
  });

  it('drops malformed fills and non-object input', () => {
    expect(
      collectCallerFills({ a: { value: 1 }, b: 'nope' }, new Set(['a', 'b'])),
    ).toEqual({});
    expect(collectCallerFills(null, new Set(['a']))).toEqual({});
    expect(collectCallerFills([fill('x')], new Set(['0']))).toEqual({});
  });

  it('never writes prototype-polluting keys (CodeQL alert 466)', () => {
    const body = JSON.parse(
      '{"__proto__":{"value":"p","provenance":[]},"constructor":{"value":"c","provenance":[]},"a":{"value":"ok","provenance":[]}}',
    );
    const fills = collectCallerFills(
      body,
      new Set(['a', '__proto__', 'constructor']),
    );
    expect(Object.keys(fills)).toEqual(['a']);
    expect(Object.getPrototypeOf(fills)).toBeNull();
    expect(({} as Record<string, unknown>).value).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('value');
  });

  it('isFieldFill requires a value and a provenance array', () => {
    expect(isFieldFill(fill(null))).toBe(true);
    expect(isFieldFill({ value: 1 })).toBe(false);
    expect(isFieldFill(undefined)).toBe(false);
  });
});
