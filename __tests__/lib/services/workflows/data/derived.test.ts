import {
  applyDerivedColumns,
  compileFormula,
  formulaToDisplay,
  rewriteFormulaRefs,
  stripDerivedCells,
  topoOrderFormulas,
} from '@/lib/services/workflows/data/derived';
import { ROW_ID_KEY } from '@/lib/services/workflows/data/tableUtils';

import { DataColumn } from '@/types/workflow';

import { describe, expect, it } from 'vitest';

/** Compile against a fixed set of known keys, throwing on failure. */
function compile(source: string, keys: string[] = ['a', 'b', 'c']) {
  const result = compileFormula(source, (ref) =>
    keys.includes(ref.trim()) ? ref.trim() : null,
  );
  if (!result.ok) throw new Error(`compile failed: ${result.issue.code}`);
  return result.compiled;
}

function evaluate(
  source: string,
  row: Record<string, unknown> = {},
): number | null {
  return compile(source).evaluate(row);
}

describe('compileFormula / evaluate', () => {
  it('follows arithmetic precedence and parentheses', () => {
    expect(evaluate('1 + 2 * 3')).toBe(7);
    expect(evaluate('(1 + 2) * 3')).toBe(9);
    expect(evaluate('10 - 4 - 3')).toBe(3);
    expect(evaluate('7 % 4')).toBe(3);
    expect(evaluate('2.5 * 4')).toBe(10);
  });

  it('handles unary minus, including stacked and applied to refs', () => {
    expect(evaluate('-5 + 8')).toBe(3);
    expect(evaluate('--5')).toBe(5);
    expect(evaluate('-[a]', { a: 4 })).toBe(-4);
  });

  it('resolves refs with spaces and dedupes the refs list', () => {
    const compiled = compile('[unit price] * [qty] + [unit price]', [
      'unit price',
      'qty',
    ]);
    expect(compiled.refs.sort()).toEqual(['qty', 'unit price']);
    expect(compiled.evaluate({ 'unit price': 3, qty: 2 })).toBe(9);
  });

  it('supports round/abs/min/max case-insensitively', () => {
    expect(evaluate('ROUND(2.567, 2)')).toBe(2.57);
    expect(evaluate('round(2.4)')).toBe(2);
    expect(evaluate('abs(0 - 8)')).toBe(8);
    expect(evaluate('min([a], [b], 10)', { a: 4, b: 7 })).toBe(4);
    expect(evaluate('max([a], [b])', { a: 4, b: 7 })).toBe(7);
  });

  it('propagates null through every operator and function', () => {
    expect(evaluate('[a] + 1', {})).toBeNull();
    expect(evaluate('[a] * 2', { a: 'text' })).toBeNull();
    expect(evaluate('[a] - 1', { a: true })).toBeNull();
    expect(evaluate('-[a]', { a: null })).toBeNull();
    expect(evaluate('min([a], 5)', {})).toBeNull();
    expect(evaluate('round([a])', { a: null })).toBeNull();
  });

  it('yields null on division/modulo by zero and non-finite results', () => {
    expect(evaluate('1 / 0')).toBeNull();
    expect(evaluate('[a] % 0', { a: 5 })).toBeNull();
    expect(evaluate('[a] / [b]', { a: 1, b: 0 })).toBeNull();
    // Overflow to Infinity.
    expect(evaluate('[a] * [a]', { a: Number.MAX_VALUE })).toBeNull();
  });

  it('reports issue codes for bad input', () => {
    const unknownRef = compileFormula('[nope] + 1', () => null);
    expect(unknownRef).toEqual({
      ok: false,
      issue: { code: 'unknownRef', detail: 'nope' },
    });
    expect(compileFormula('round()', () => 'x')).toMatchObject({
      ok: false,
      issue: { code: 'syntax' },
    });
    expect(compileFormula('round(1, 2, 3)', () => 'x')).toMatchObject({
      ok: false,
      issue: { code: 'arity', detail: 'round' },
    });
    expect(compileFormula('abs(1, 2)', () => 'x')).toMatchObject({
      ok: false,
      issue: { code: 'arity', detail: 'abs' },
    });
    for (const bad of ['1 +', '(1 + 2', '[a', 'foo(1)', '1 $ 2', '', '  ']) {
      expect(compileFormula(bad, () => 'a').ok).toBe(false);
    }
  });
});

describe('rewriteFormulaRefs / formulaToDisplay', () => {
  const columns: Pick<DataColumn, 'id' | 'name'>[] = [
    { id: 'cases', name: 'Cases' },
    { id: 'population', name: 'Population' },
  ];

  it('round-trips display and stored forms preserving structure', () => {
    const byName = new Map(columns.map((c) => [c.name.toLowerCase(), c.id]));
    const stored = rewriteFormulaRefs(
      '[Cases] / [Population] * 1000',
      (ref) => byName.get(ref.trim().toLowerCase()) ?? null,
    );
    expect(stored).toEqual({
      ok: true,
      formula: '[cases] / [population] * 1000',
    });
    expect(formulaToDisplay('[cases] / [population] * 1000', columns)).toBe(
      '[Cases] / [Population] * 1000',
    );
  });

  it('fails stored conversion on unknown names, keeps unknown ids as-is', () => {
    expect(rewriteFormulaRefs('[Nope] * 2', () => null)).toEqual({
      ok: false,
      issue: { code: 'unknownRef', detail: 'Nope' },
    });
    expect(formulaToDisplay('[ghost] * 2', columns)).toBe('[ghost] * 2');
  });
});

describe('topoOrderFormulas', () => {
  it('orders chains and flags cycles', () => {
    const chain = topoOrderFormulas([
      { key: 'c', refs: ['b'] },
      { key: 'a', refs: ['x'] },
      { key: 'b', refs: ['a'] },
    ]);
    expect(chain.order).toEqual(['a', 'b', 'c']);
    expect(chain.cyclic.size).toBe(0);

    const cyclic = topoOrderFormulas([
      { key: 'a', refs: ['b'] },
      { key: 'b', refs: ['a'] },
      { key: 'behind', refs: ['a'] },
      { key: 'free', refs: [] },
    ]);
    expect(cyclic.order).toEqual(['free']);
    expect([...cyclic.cyclic].sort()).toEqual(['a', 'b', 'behind']);

    const self = topoOrderFormulas([{ key: 'a', refs: ['a'] }]);
    expect(self.cyclic.has('a')).toBe(true);
  });
});

describe('applyDerivedColumns', () => {
  const columns: DataColumn[] = [
    { id: 'cases', name: 'Cases', type: 'number' },
    { id: 'pop', name: 'Population', type: 'number' },
    {
      id: 'rate',
      name: 'Rate',
      type: 'number',
      formula: '[cases] / [pop] * 1000',
    },
  ];
  const rows = [
    { [ROW_ID_KEY]: 'r1', cases: 30, pop: 1000 },
    { [ROW_ID_KEY]: 'r2', cases: 5, pop: 0 },
    { [ROW_ID_KEY]: 'r3', cases: null, pop: 500 },
  ];

  it('is identity (same reference) when no column has a formula', () => {
    const plain = columns.slice(0, 2);
    expect(applyDerivedColumns(plain, rows)).toBe(rows);
  });

  it('computes derived cells without mutating input, rids preserved', () => {
    const out = applyDerivedColumns(columns, rows);
    expect(out.map((r) => r.rate)).toEqual([30, null, null]);
    expect(out.map((r) => r[ROW_ID_KEY])).toEqual(['r1', 'r2', 'r3']);
    expect('rate' in rows[0]).toBe(false);
  });

  it('overrides a stale materialized cell with the formula value', () => {
    const out = applyDerivedColumns(columns, [
      { cases: 10, pop: 100, rate: 999 },
    ]);
    expect(out[0].rate).toBe(100);
  });

  it('evaluates chained derived columns in dependency order', () => {
    const chained: DataColumn[] = [
      ...columns,
      { id: 'double', name: 'Double', type: 'number', formula: '[rate] * 2' },
    ];
    const out = applyDerivedColumns(chained, [{ cases: 10, pop: 100 }]);
    expect(out[0].rate).toBe(100);
    expect(out[0].double).toBe(200);
  });

  it('nulls cyclic and broken columns instead of throwing', () => {
    const cyclic: DataColumn[] = [
      { id: 'a', name: 'A', type: 'number', formula: '[b] + 1' },
      { id: 'b', name: 'B', type: 'number', formula: '[a] + 1' },
      { id: 'stale', name: 'S', type: 'number', formula: '[gone] * 2' },
    ];
    const out = applyDerivedColumns(cyclic, [{ x: 1 }]);
    expect(out[0]).toMatchObject({ a: null, b: null, stale: null });
  });
});

describe('stripDerivedCells', () => {
  const columns: DataColumn[] = [
    { id: 'cases', name: 'Cases', type: 'number' },
    { id: 'rate', name: 'Rate', type: 'number', formula: '[cases] * 2' },
  ];

  it('removes derived keys and is identity when none are present', () => {
    const clean = [{ cases: 1 }];
    expect(stripDerivedCells(columns, clean)).toBe(clean);
    expect(stripDerivedCells(columns, [{ cases: 1, rate: 2 }])).toEqual([
      { cases: 1 },
    ]);
  });
});
