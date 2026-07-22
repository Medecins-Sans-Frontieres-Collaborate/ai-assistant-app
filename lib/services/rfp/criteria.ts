/**
 * Criteria spec — the structured scoring configuration for one RFP.
 *
 * - `questions`: question id ("12", "12a") → question text. The pipeline
 *   extracts a verbatim answer to each question from each vendor PDF.
 * - `categories`: groups of criteria; each criterion draws evidence from one
 *   or more questions and carries a weight (fraction of the grand total).
 *
 * Weights across ALL criteria must sum to 1.0 (±0.005). Validation runs on load.
 */
import { readFileSync } from 'fs';

export interface Criterion {
  name: string;
  questions: string[];
  weight: number;
  audience: string | null;
  description: string;
}

export interface Category {
  num: number;
  name: string;
  sheet: string;
  criteria: Criterion[];
}

export interface CriteriaSpec {
  questions: Record<string, string>;
  categories: Category[];
}

/** Natural sort for question ids: '2' < '10', '12' < '12a' < '12b' < '13'. */
export function questionCompare(a: string, b: string): number {
  const parse = (q: string): [number, number | string, string] => {
    const m = /^(\d+)(.*)$/.exec(String(q));
    return m ? [0, parseInt(m[1], 10), m[2]] : [1, 0, String(q)];
  };
  const [ka, na, sa] = parse(a);
  const [kb, nb, sb] = parse(b);
  if (ka !== kb) return ka - kb;
  if (na !== nb) return (na as number) - (nb as number);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export function loadSpec(data: {
  questions: Record<string, string>;
  categories: Array<{
    num: number | string;
    name: string;
    sheet?: string;
    criteria?: Array<{
      name: string;
      questions: Array<string | number>;
      weight: number | string;
      audience?: string | null;
      description?: string;
    }>;
  }>;
}): CriteriaSpec {
  const questions: Record<string, string> = {};
  for (const [k, v] of Object.entries(data.questions || {})) {
    questions[String(k)] = v;
  }
  const categories: Category[] = (data.categories || []).map((c) => ({
    num: Number(c.num),
    name: c.name,
    sheet: c.sheet || c.name,
    criteria: (c.criteria || []).map((cr) => ({
      name: cr.name,
      questions: cr.questions.map((q) => String(q)),
      weight: Number(cr.weight),
      audience: cr.audience ?? null,
      description: cr.description || '',
    })),
  }));

  const spec: CriteriaSpec = { questions, categories };
  validateSpec(spec);
  return spec;
}

export function loadSpecFromFile(path: string): CriteriaSpec {
  return loadSpec(JSON.parse(readFileSync(path, 'utf-8')));
}

export function validateSpec(spec: CriteriaSpec): void {
  if (!Object.keys(spec.questions).length) {
    throw new Error("criteria config: 'questions' is empty");
  }
  if (!spec.categories.length) {
    throw new Error("criteria config: 'categories' is empty");
  }
  const known = new Set(Object.keys(spec.questions));
  for (const cat of spec.categories) {
    for (const crit of cat.criteria) {
      const bad = crit.questions.filter((q) => !known.has(q));
      if (bad.length) {
        throw new Error(
          `Category '${cat.name}' criterion '${crit.name}' references unknown question(s): ${bad.join(', ')}`,
        );
      }
    }
  }
  const total = spec.categories.reduce(
    (s, cat) => s + cat.criteria.reduce((t, c) => t + c.weight, 0),
    0,
  );
  if (Math.abs(total - 1.0) > 0.005) {
    throw new Error(
      `Criterion weights must sum to 1.0 (±0.005); got ${total.toFixed(4)}`,
    );
  }
}

/** Yield [categoryIndex, criterionIndex, criterion] for every criterion. */
export function allCriteria(
  spec: CriteriaSpec,
): Array<[number, number, Criterion]> {
  const out: Array<[number, number, Criterion]> = [];
  spec.categories.forEach((cat, ci) =>
    cat.criteria.forEach((crit, cj) => out.push([ci, cj, crit])),
  );
  return out;
}

export function questionIds(spec: CriteriaSpec): string[] {
  return Object.keys(spec.questions).sort(questionCompare);
}

export function criterionCount(spec: CriteriaSpec): number {
  return spec.categories.reduce((s, c) => s + c.criteria.length, 0);
}
