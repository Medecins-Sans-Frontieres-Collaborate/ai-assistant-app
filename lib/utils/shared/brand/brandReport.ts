/**
 * A brand review in words: one sentence per finding, and the report a
 * person downloads (docs/DOCUMENT_PLATFORM.md, phase F). The words come
 * from the caller's translator, so the report is in the reader's language;
 * this module only decides which message a finding takes and with what.
 */
import {
  BrandFinding,
  BrandFindingRule,
  countBySeverity,
  sortFindings,
} from './brandFindings';

/** A translator over `workflows.brandReview` (next-intl's `t`). */
export type BrandReviewTranslate = (
  key: string,
  values?: Record<string, string | number>,
) => string;

/** Rules whose `found` and `expected` are colours, shown as swatches. */
const COLOR_RULES: ReadonlySet<BrandFindingRule> = new Set([
  'color',
  'logo-background',
]);

/** Whether a finding's values are colours. */
export function isColorFinding(finding: BrandFinding): boolean {
  return COLOR_RULES.has(finding.rule);
}

/**
 * The sentence for a finding: the model's own note for its findings, a
 * message built from the values for the checks'.
 */
export function describeFinding(
  finding: BrandFinding,
  t: BrandReviewTranslate,
): string {
  if (finding.source === 'model' && finding.note) return finding.note;
  const values = {
    found: finding.found,
    expected: finding.expected.join(', '),
    first: finding.expected[0] ?? '',
    name: finding.note ?? '',
    count: finding.count ?? 1,
  };
  const key =
    finding.expected.length === 0 &&
    (finding.rule === 'banned-term' || finding.rule === 'font')
      ? `${finding.rule}-alone`
      : finding.rule;
  return t(`message.${key}`, values);
}

/** Escapes text for HTML. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A colour swatch, only for a value that is a colour. */
function swatch(value: string): string {
  return /^#[0-9a-f]{6}$/i.test(value)
    ? `<span class="swatch" style="background:${value}"></span>`
    : '';
}

/** What the report says about the review as a whole. */
export interface BrandReportInput {
  documentName: string;
  bookName: string;
  /** When the review was made, already formatted for the reader. */
  date: string;
  /** The reader's language, for the page's `lang`. */
  locale: string;
  findings: readonly BrandFinding[];
  pageCount: number;
  skippedPages: readonly number[];
  /** Whether the review ended early (stopped or failed). */
  partial: boolean;
}

/**
 * The review as a standalone HTML page to download and print.
 *
 * @returns The page's source; every value from the document, the book or
 *   the model is escaped.
 */
export function buildBrandReport(
  input: BrandReportInput,
  t: BrandReviewTranslate,
): string {
  const counts = countBySeverity(input.findings);
  const rows = sortFindings(input.findings)
    .map((finding) => {
      const colorValues = isColorFinding(finding)
        ? [finding.found, ...finding.expected.slice(0, 1)]
            .map((hex) => `${swatch(hex)}${escapeHtml(hex)}`)
            .join(' &rarr; ')
        : escapeHtml(finding.found);
      return `<tr class="${finding.severity}">
<td>${finding.page ?? escapeHtml(t('report.notes'))}</td>
<td><span class="tag">${escapeHtml(t(`severity.${finding.severity}`))}</span></td>
<td>${escapeHtml(t(`rule.${finding.rule}`))}</td>
<td>${escapeHtml(describeFinding(finding, t))}</td>
<td class="found">${colorValues}</td>
</tr>`;
    })
    .join('\n');
  const notes = [
    input.partial ? t('report.partial') : '',
    input.skippedPages.length > 0
      ? t('report.skipped', { pages: input.skippedPages.join(', ') })
      : '',
  ].filter(Boolean);
  return `<!doctype html>
<html lang="${escapeHtml(input.locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(t('report.title', { name: input.documentName }))}</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; color: #1f2328; background: #fff; margin: 2rem auto; max-width: 64rem; padding: 0 1rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  .meta { color: #59636e; margin: 0 0 1rem; }
  .counts span { display: inline-block; margin-right: 1rem; font-weight: 600; }
  .note { background: #fff8c5; border: 1px solid #d4a72c; border-radius: 6px; padding: .5rem .75rem; margin: .5rem 0; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
  th, td { text-align: left; vertical-align: top; padding: .45rem .6rem; border-bottom: 1px solid #d1d9e0; }
  th { font-size: .8rem; text-transform: uppercase; letter-spacing: .03em; color: #59636e; }
  .tag { font-size: .75rem; font-weight: 600; padding: .05rem .4rem; border-radius: 999px; background: #eef1f4; }
  tr.error .tag { background: #ffebe9; color: #a40e26; }
  tr.warning .tag { background: #fff8c5; color: #7d4e00; }
  .found { font-family: ui-monospace, monospace; font-size: .85rem; }
  .swatch { display: inline-block; width: .8rem; height: .8rem; border: 1px solid #d1d9e0; border-radius: 2px; vertical-align: -1px; margin-right: .25rem; }
  @media print { body { margin: 0; } }
</style>
</head>
<body>
<h1>${escapeHtml(t('report.title', { name: input.documentName }))}</h1>
<p class="meta">${escapeHtml(t('report.meta', { book: input.bookName, date: input.date, pages: input.pageCount }))}</p>
<p class="counts"><span>${escapeHtml(t('report.errors', { count: counts.error }))}</span><span>${escapeHtml(t('report.warnings', { count: counts.warning }))}</span><span>${escapeHtml(t('report.infos', { count: counts.info }))}</span></p>
${notes.map((note) => `<p class="note">${escapeHtml(note)}</p>`).join('\n')}
${
  input.findings.length === 0
    ? `<p>${escapeHtml(t('report.none'))}</p>`
    : `<table>
<thead><tr><th>${escapeHtml(t('report.page'))}</th><th>${escapeHtml(t('report.severity'))}</th><th>${escapeHtml(t('report.rule'))}</th><th>${escapeHtml(t('report.finding'))}</th><th>${escapeHtml(t('report.found'))}</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`
}
</body>
</html>
`;
}
