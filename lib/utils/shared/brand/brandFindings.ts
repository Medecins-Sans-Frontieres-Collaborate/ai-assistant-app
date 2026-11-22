/**
 * What a brand review reports (docs/DOCUMENT_PLATFORM.md, phase F), the
 * same for the deterministic checks and the model's page review, so the
 * viewer, the findings list and the report read one shape.
 *
 * A finding names WHERE (a page, and a unit or picture of THE DOCUMENT
 * MODEL with its box) and WHAT as values (`found`, `expected`), never as
 * sentences: the interface words them in the reader's language. Only the
 * model's findings carry text of their own (`note`).
 */
import { PageBox } from '@/lib/utils/shared/documents/documentModel';

/** Every kind of finding, in the order a report lists them. */
export const BRAND_FINDING_RULES = [
  'font',
  'color',
  'size',
  'banned-term',
  'preferred-term',
  'language',
  'logo-distorted',
  'logo-small',
  'logo-background',
  'logo-unknown',
  'visual',
  'tone',
] as const;

export type BrandFindingRule = (typeof BRAND_FINDING_RULES)[number];

/**
 * How much a finding matters: `error` breaks a rule the book states,
 * `warning` is likely wrong, `info` is worth a look.
 */
export const BRAND_FINDING_SEVERITIES = ['error', 'warning', 'info'] as const;

export type BrandFindingSeverity = (typeof BRAND_FINDING_SEVERITIES)[number];

export interface BrandFinding {
  /** Stable within one review: rule, page and target. */
  id: string;
  rule: BrandFindingRule;
  severity: BrandFindingSeverity;
  /** 1-based page, or null for text on no page (speaker notes). */
  page: number | null;
  unitId: string | null;
  imageId: string | null;
  /** Where to draw it, in page points; null when it has no place. */
  box: PageBox | null;
  /** What the document has: a font, a hex, a size, a term, a tag. */
  found: string;
  /** What the book allows instead, nearest first. */
  expected: string[];
  /** Who found it. */
  source: 'check' | 'model';
  /** The model's own words (model findings only). */
  note?: string;
  /** How many times within its unit (terms), when more than once. */
  count?: number;
}

/** Findings in report order: page, then rule order, then position. */
export function sortFindings(
  findings: readonly BrandFinding[],
): BrandFinding[] {
  const ruleOrder = new Map(BRAND_FINDING_RULES.map((rule, at) => [rule, at]));
  return [...findings].sort(
    (a, b) =>
      (a.page ?? Number.MAX_SAFE_INTEGER) -
        (b.page ?? Number.MAX_SAFE_INTEGER) ||
      (ruleOrder.get(a.rule) ?? 0) - (ruleOrder.get(b.rule) ?? 0) ||
      (a.box?.[1] ?? 0) - (b.box?.[1] ?? 0) ||
      (a.box?.[0] ?? 0) - (b.box?.[0] ?? 0) ||
      a.id.localeCompare(b.id),
  );
}

/** Counts by severity, for a summary. */
export function countBySeverity(
  findings: readonly BrandFinding[],
): Record<BrandFindingSeverity, number> {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

/** One problem and every place it was found, in report order. */
export interface BrandFindingGroup {
  /** Stable within one review. */
  key: string;
  /** The places; never empty. The first stands for the group. */
  findings: BrandFinding[];
}

/**
 * Findings as problems: a check's findings of the same rule and values
 * are one problem found in several places (a document set wholly in the
 * wrong typeface is one problem, not one per paragraph). The model's
 * findings each stay alone: their notes differ.
 *
 * @returns Groups in report order of their first place.
 */
export function groupFindings(
  findings: readonly BrandFinding[],
): BrandFindingGroup[] {
  const groups = new Map<string, BrandFindingGroup>();
  for (const finding of sortFindings(findings)) {
    const key =
      finding.source === 'model'
        ? `model ${finding.id}`
        : [
            finding.rule,
            finding.severity,
            finding.found.toLowerCase(),
            ...finding.expected,
          ].join('\u0000');
    const group = groups.get(key);
    if (group) group.findings.push(finding);
    else groups.set(key, { key, findings: [finding] });
  }
  return [...groups.values()];
}
