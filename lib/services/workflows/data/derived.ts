import { DataColumn } from '@/types/workflow';

/**
 * Derived-column formula engine: a small, dependency-free, number-only
 * expression language over row cells.
 *
 *   expr    := term (('+' | '-') term)*
 *   term    := unary (('*' | '/' | '%') unary)*
 *   unary   := '-' unary | primary
 *   primary := NUMBER | '[' ref ']' | FUNC '(' expr (',' expr)* ')' | '(' expr ')'
 *
 * Functions (case-insensitive): round(x[, n]), abs(x), min(...), max(...).
 * Null semantics — one uniform rule: a ref whose cell is not a finite
 * number evaluates to null, and null propagates through every operator
 * and function; division/modulo by zero and non-finite results are null.
 *
 * Formulas are stored on columns in canonical id-ref form ("[cases] *
 * 2"); the schema editor works in name-ref form and converts via
 * rewriteFormulaRefs/formulaToDisplay. Derived cells are computed at
 * render time by applyDerivedColumns and never persisted.
 */

export type FormulaIssueCode = 'syntax' | 'unknownRef' | 'arity' | 'cycle';

export interface FormulaIssue {
  code: FormulaIssueCode;
  /** Offending token: ref text for unknownRef, function name for arity. */
  detail?: string;
}

export interface CompiledFormula {
  /** Canonical row keys referenced (deduped). */
  refs: string[];
  /** Number-only; null on missing/non-numeric operands, /0, non-finite. */
  evaluate: (row: Record<string, unknown>) => number | null;
}

export type CompileResult =
  | { ok: true; compiled: CompiledFormula }
  | { ok: false; issue: FormulaIssue };

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'ref'; text: string }
  | { kind: 'ident'; name: string }
  | { kind: 'op'; op: '+' | '-' | '*' | '/' | '%' | '(' | ')' | ',' };

type EvalNode = (row: Record<string, unknown>) => number | null;

const FUNCTIONS: Record<
  string,
  { minArgs: number; maxArgs: number; apply: (args: number[]) => number }
> = {
  round: {
    minArgs: 1,
    maxArgs: 2,
    apply: ([x, n]) => {
      const factor = 10 ** Math.trunc(n ?? 0);
      return Math.round(x * factor) / factor;
    },
  },
  abs: { minArgs: 1, maxArgs: 1, apply: ([x]) => Math.abs(x) },
  min: { minArgs: 1, maxArgs: Infinity, apply: (args) => Math.min(...args) },
  max: { minArgs: 1, maxArgs: Infinity, apply: (args) => Math.max(...args) },
};

class FormulaError extends Error {
  issue: FormulaIssue;
  constructor(issue: FormulaIssue) {
    super(issue.code);
    this.issue = issue;
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i += 1;
    } else if (ch === '[') {
      const close = source.indexOf(']', i + 1);
      if (close < 0) throw new FormulaError({ code: 'syntax' });
      tokens.push({ kind: 'ref', text: source.slice(i + 1, close) });
      i = close + 1;
    } else if (/[0-9]/.test(ch)) {
      const match = /^[0-9]+(\.[0-9]+)?/.exec(source.slice(i))!;
      tokens.push({ kind: 'num', value: Number(match[0]) });
      i += match[0].length;
    } else if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i))!;
      tokens.push({ kind: 'ident', name: match[0].toLowerCase() });
      i += match[0].length;
    } else if ('+-*/%(),'.includes(ch)) {
      tokens.push({
        kind: 'op',
        op: ch as '+' | '-' | '*' | '/' | '%' | '(' | ')' | ',',
      });
      i += 1;
    } else {
      throw new FormulaError({ code: 'syntax' });
    }
  }
  return tokens;
}

/** Wraps a raw binary computation with null propagation + finite check. */
function binaryNode(
  left: EvalNode,
  right: EvalNode,
  op: '+' | '-' | '*' | '/' | '%',
): EvalNode {
  return (row) => {
    const a = left(row);
    if (a === null) return null;
    const b = right(row);
    if (b === null) return null;
    if ((op === '/' || op === '%') && b === 0) return null;
    const result =
      op === '+'
        ? a + b
        : op === '-'
          ? a - b
          : op === '*'
            ? a * b
            : op === '/'
              ? a / b
              : a % b;
    return Number.isFinite(result) ? result : null;
  };
}

function parse(
  tokens: Token[],
  resolveRef: (ref: string) => string | null,
): CompiledFormula {
  let pos = 0;
  const refs = new Set<string>();

  const peek = () => tokens[pos];
  const takeOp = (op: string): boolean => {
    const token = tokens[pos];
    if (token?.kind === 'op' && token.op === op) {
      pos += 1;
      return true;
    }
    return false;
  };

  function expr(): EvalNode {
    let node = term();
    for (;;) {
      if (takeOp('+')) node = binaryNode(node, term(), '+');
      else if (takeOp('-')) node = binaryNode(node, term(), '-');
      else return node;
    }
  }

  function term(): EvalNode {
    let node = unary();
    for (;;) {
      if (takeOp('*')) node = binaryNode(node, unary(), '*');
      else if (takeOp('/')) node = binaryNode(node, unary(), '/');
      else if (takeOp('%')) node = binaryNode(node, unary(), '%');
      else return node;
    }
  }

  function unary(): EvalNode {
    if (takeOp('-')) {
      const inner = unary();
      return (row) => {
        const v = inner(row);
        return v === null ? null : -v;
      };
    }
    return primary();
  }

  function primary(): EvalNode {
    const token = peek();
    if (!token) throw new FormulaError({ code: 'syntax' });
    if (token.kind === 'num') {
      pos += 1;
      return () => token.value;
    }
    if (token.kind === 'ref') {
      pos += 1;
      const key = resolveRef(token.text);
      if (key === null) {
        throw new FormulaError({
          code: 'unknownRef',
          detail: token.text.trim(),
        });
      }
      refs.add(key);
      return (row) => {
        const v = row[key];
        return typeof v === 'number' && Number.isFinite(v) ? v : null;
      };
    }
    if (token.kind === 'ident') {
      pos += 1;
      const fn = FUNCTIONS[token.name];
      if (!fn || !takeOp('(')) throw new FormulaError({ code: 'syntax' });
      const args: EvalNode[] = [expr()];
      while (takeOp(',')) args.push(expr());
      if (!takeOp(')')) throw new FormulaError({ code: 'syntax' });
      if (args.length < fn.minArgs || args.length > fn.maxArgs) {
        throw new FormulaError({ code: 'arity', detail: token.name });
      }
      return (row) => {
        const values: number[] = [];
        for (const arg of args) {
          const v = arg(row);
          if (v === null) return null;
          values.push(v);
        }
        const result = fn.apply(values);
        return Number.isFinite(result) ? result : null;
      };
    }
    if (token.kind === 'op' && token.op === '(') {
      pos += 1;
      const node = expr();
      if (!takeOp(')')) throw new FormulaError({ code: 'syntax' });
      return node;
    }
    throw new FormulaError({ code: 'syntax' });
  }

  const root = expr();
  if (pos !== tokens.length) throw new FormulaError({ code: 'syntax' });
  return { refs: [...refs], evaluate: root };
}

/**
 * Tokenize + recursive-descent parse + close over the AST. resolveRef
 * maps bracket-ref text to the canonical row key (null = unknown ref).
 * Parse once per column; evaluate per row.
 */
export function compileFormula(
  source: string,
  resolveRef: (ref: string) => string | null,
): CompileResult {
  try {
    const tokens = tokenize(source);
    if (tokens.length === 0) throw new FormulaError({ code: 'syntax' });
    return { ok: true, compiled: parse(tokens, resolveRef) };
  } catch (error) {
    if (error instanceof FormulaError) return { ok: false, issue: error.issue };
    throw error;
  }
}

/**
 * Lexer-level rewrite of [ref] spans only; everything else is copied
 * verbatim. Shared by both translation directions (display→stored
 * resolves names to ids and fails on unknowns; stored→display goes
 * through formulaToDisplay, which never fails).
 */
export function rewriteFormulaRefs(
  source: string,
  resolve: (ref: string) => string | null,
): { ok: true; formula: string } | { ok: false; issue: FormulaIssue } {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '[') {
      const close = source.indexOf(']', i + 1);
      if (close < 0) return { ok: false, issue: { code: 'syntax' } };
      const ref = source.slice(i + 1, close);
      const resolved = resolve(ref);
      if (resolved === null) {
        return { ok: false, issue: { code: 'unknownRef', detail: ref.trim() } };
      }
      out += `[${resolved}]`;
      i = close + 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return { ok: true, formula: out };
}

/** Stored id-refs → display name-refs; unknown ids are left as-is. */
export function formulaToDisplay(
  stored: string,
  columns: Pick<DataColumn, 'id' | 'name'>[],
): string {
  const byId = new Map(columns.map((column) => [column.id, column.name]));
  const result = rewriteFormulaRefs(
    stored,
    (ref) => byId.get(ref.trim()) ?? ref,
  );
  return result.ok ? result.formula : stored;
}

/**
 * Kahn topological order over derived columns (edges only between the
 * given nodes; refs to raw columns are ignored). Nodes left over are in
 * (or downstream of) a cycle.
 */
export function topoOrderFormulas(
  nodes: Array<{ key: string; refs: string[] }>,
): { order: string[]; cyclic: Set<string> } {
  const keys = new Set(nodes.map((node) => node.key));
  const indegree = new Map<string, number>(nodes.map((node) => [node.key, 0]));
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    for (const ref of new Set(node.refs)) {
      if (!keys.has(ref)) continue;
      indegree.set(node.key, (indegree.get(node.key) ?? 0) + 1);
      const list = dependents.get(ref) ?? [];
      list.push(node.key);
      dependents.set(ref, list);
    }
  }
  const queue = nodes
    .map((node) => node.key)
    .filter((key) => indegree.get(key) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const key = queue.shift()!;
    order.push(key);
    for (const dependent of dependents.get(key) ?? []) {
      const remaining = indegree.get(dependent)! - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) queue.push(dependent);
    }
  }
  const cyclic = new Set([...keys].filter((key) => !order.includes(key)));
  return { order, cyclic };
}

/**
 * The choke-point overlay: returns rows with derived cells computed.
 * IDENTITY (same reference) when no column has a formula, so downstream
 * memos never churn while the feature is unused. Compiles each formula
 * once, topo-orders derived columns (chained refs allowed), then
 * evaluates per row into a shallow copy so later formulas see earlier
 * derived values. Compile failure / stale ref / cycle → that column is
 * all-null. Never mutates input; __rid rides along untouched.
 */
export function applyDerivedColumns(
  columns: DataColumn[],
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  const derived = columns.filter((column) => column.formula);
  if (derived.length === 0 || rows.length === 0) return rows;

  const ids = new Set(columns.map((column) => column.id));
  const compiled = new Map<string, CompiledFormula | null>();
  for (const column of derived) {
    const result = compileFormula(column.formula!, (ref) => {
      const key = ref.trim();
      return ids.has(key) ? key : null;
    });
    compiled.set(column.id, result.ok ? result.compiled : null);
  }
  const { order, cyclic } = topoOrderFormulas(
    derived.map((column) => ({
      key: column.id,
      refs: compiled.get(column.id)?.refs ?? [],
    })),
  );

  return rows.map((row) => {
    const out = { ...row };
    for (const id of order) {
      const formula = compiled.get(id);
      out[id] = formula ? formula.evaluate(out) : null;
    }
    for (const id of cyclic) out[id] = null;
    return out;
  });
}

/**
 * Persistence hygiene: removes derived-column keys from rows (identity
 * when nothing to strip). Derived cells are never persisted — this
 * protects the localStorage budget and prevents stale materialized
 * values (transform results, legacy states) from shadowing formulas.
 */
export function stripDerivedCells(
  columns: DataColumn[],
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  const derivedIds = columns
    .filter((column) => column.formula)
    .map((column) => column.id);
  if (derivedIds.length === 0) return rows;
  if (!rows.some((row) => derivedIds.some((id) => id in row))) return rows;
  return rows.map((row) => {
    if (!derivedIds.some((id) => id in row)) return row;
    const out = { ...row };
    for (const id of derivedIds) delete out[id];
    return out;
  });
}
