/**
 * Stage 5: write the final scorecard xlsx (ExcelJS).
 *
 * Sheets:
 *  - Summary: weighted totals + ranking (live formulas referencing Analysis)
 *  - Flags: mechanical facts about this run (deferred answers, supplemental
 *    references, missing data, scoring failures) grouped per vendor, plus an
 *    arithmetic decomposition of what decided the ranking
 *  - Analysis: full per-criterion grid. Score cells mirror the category tabs
 *    via cross-sheet formulas; weighted cells and totals are formulas, so a
 *    human can edit any score cell on a category tab and every total
 *    recalculates in place.
 *  - One tab per category: verbatim Q&A + rubric + scoring with justifications.
 *    These score cells are the editable source of truth. Amber = deferred to
 *    human scoring (blank); blue = scored but references supplemental material.
 */
import type { CriteriaSpec, Criterion } from '../criteria';
import { allCriteria, questionCompare } from '../criteria';
import type { Responses } from './extractResponses';
import type { Rubrics } from './generateRubrics';
import type { Scores, VendorScore } from './scoreVendors';

import ExcelJS from 'exceljs';
import { existsSync, readFileSync } from 'fs';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';

// openpyxl-era guard kept for parity: strip illegal XML control chars.
// eslint-disable-next-line no-control-regex
const ILLEGAL = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
const clean = (v: string) => v.replace(ILLEGAL, '');

/**
 * Display-only cleanup for verbatim answer cells. PDFs sometimes render
 * bullet glyphs as a separate text column, which extraction faithfully
 * copies as orphan "•" lines divorced from their item text. Collapse runs
 * of orphan glyph lines; attach a single orphan glyph to the line that
 * follows it. Never applied to cached data — the scoring inputs are
 * untouched.
 */
function displayAnswer(v: string): string {
  return (
    clean(v)
      // runs of 2+ orphan glyph lines (a detached bullet column) → drop
      .replace(/(?:^[ \t]*[•§▪◦‣●][ \t]*$\n?){2,}/gm, '')
      // a single lone glyph line directly followed by text → inline bullet
      .replace(/^[ \t]*([•§▪◦‣●])[ \t]*\n(?=(?![ \t]*[•§▪◦‣●])\S)/gm, '$1 ')
      // any straggler lone glyph lines → drop
      .replace(/^[ \t]*[•§▪◦‣●][ \t]*$\n?/gm, '')
      // collapse the triple+ blank lines this can leave behind
      .replace(/\n{3,}/g, '\n\n')
  );
}

const THIN = { style: 'thin' as const, color: { argb: 'FF999999' } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF1F4E78' },
};
const SECTION_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFD9E1F2' },
};
const TOTAL_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFFFF2CC' },
};
const DEFER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFFFD966' },
};
const SUPP_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFDDEBF7' },
};
const HEADER_FONT = {
  name: 'Calibri',
  size: 11,
  bold: true,
  color: { argb: 'FFFFFFFF' },
};
const SECTION_FONT = { name: 'Calibri', size: 11, bold: true };
const TOTAL_FONT = { name: 'Calibri', size: 11, bold: true, italic: true };
const FLAG_FONT = {
  name: 'Calibri',
  size: 11,
  bold: true,
  color: { argb: 'FF9C5700' },
};
const NOTE_FONT = { italic: true, color: { argb: 'FF555555' } };
const WRAP: Partial<ExcelJS.Alignment> = { wrapText: true, vertical: 'top' };
const CENTER: Partial<ExcelJS.Alignment> = {
  horizontal: 'center',
  vertical: 'middle',
  wrapText: true,
};

function colLetter(n: number): string {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function styleHeader(cell: ExcelJS.Cell): void {
  cell.fill = HEADER_FILL;
  cell.font = HEADER_FONT;
  cell.alignment = CENTER;
  cell.border = BORDER;
}

function critLabel(crit: Criterion): string {
  return `${crit.name} (${crit.questions.join(', ')})`;
}

function basis(
  vendorsD: Record<string, VendorScore>,
  vendors: string[],
): string {
  const parts: string[] = [];
  for (const v of vendors) {
    const d = vendorsD[v];
    if (!d) continue;
    const why = (d.why || '').trim();
    const tag = d.deferred ? ' [DEFERRED]' : '';
    if (why) parts.push(`${v} (${d.score}${tag}): ${why}`);
  }
  return parts.join('\n');
}

const isDeferred = (vendorsD: Record<string, VendorScore>, v: string) =>
  Boolean(vendorsD[v]?.deferred);

// Generic supplemental-reference language — detects the *pattern* of routing a
// reader to external material, so it works across RFPs without content-specific
// rules. Review-biased (a false flag costs one human glance and never changes a
// score), but ambiguous words like "attached"/"exhibit" require document
// context so ordinary prose doesn't misfire.
const SUPP_RE = new RegExp(
  [
    'appendix|appendices|attachment|enclos(ed|ure)|addendum',
    'https?://|www\\.',
    'attached\\s+(document|file|pdf|sample|portfolio|pricing|budget|deck|sheet)',
    '(see|find|refer\\s+to|included\\s+in)\\s+(the\\s+)?attached',
    'exhibit\\s+[a-z0-9]\\b|see\\s+exhibit',
    'samples?\\s+(are\\s+|is\\s+)?(provided|included|enclosed|linked|available)',
    'see\\s+(our\\s+)?(sample|portfolio|case\\s+stud)',
    // link-language without a literal URL ("visit this link", "linked here")
    'visit\\s+(this\\s+|the\\s+)?link|linked\\s+here|click\\s+here|via\\s+(this\\s+|the\\s+)?link',
    // "an example/sample ... provided/included/linked" within one sentence
    '(example|sample)s?\\b[^.!?\\n]{0,60}\\b(provided|included|enclosed|linked|attached)',
    // in-document exhibit blocks ("see the example in the following 8 pages")
    'following\\s+\\d+\\s+pages?',
    // a bare heading line introducing a sample ("Sample Campaign Brief")
    '^\\s*samples?\\s+\\w+[^.!?\\n]{0,60}$',
  ].join('|'),
  'im',
);

type SuppMap = Record<string, boolean>; // `${key}|${vendor}` -> true
const suppKey = (key: string, vendor: string) => `${key}|${vendor}`;

/** Supplemental-reference map from the scorer's flag OR a deterministic
 * text-pattern backstop, so detection stays consistent across vendors. */
function supplementalMap(
  spec: CriteriaSpec,
  scores: Scores,
  responses: Responses,
  vendors: string[],
): SuppMap {
  const supp: SuppMap = {};
  for (const [ci, cj, crit] of allCriteria(spec)) {
    const key = `${ci}_${cj}`;
    const vendorsD = scores[key]?.vendors || {};
    for (const v of vendors) {
      const vd = vendorsD[v];
      if (vd?.deferred) continue; // already the stronger flag
      if (vd?.external_material) {
        supp[suppKey(key, v)] = true;
        continue;
      }
      for (const q of crit.questions) {
        const ans = responses[v]?.[q]?.answer || '';
        if (ans && SUPP_RE.test(ans)) {
          supp[suppKey(key, v)] = true;
          break;
        }
      }
    }
  }
  return supp;
}

interface CategoryTabResult {
  scoreRefs: Record<string, string>; // `${key}|${vendor}` -> "'sheet'!B12"
}

function writeCategoryTab(
  ws: ExcelJS.Worksheet,
  ci: number,
  spec: CriteriaSpec,
  responses: Responses,
  rubrics: Rubrics,
  scores: Scores,
  vendors: string[],
  supp: SuppMap,
): CategoryTabResult {
  const cat = spec.categories[ci];
  const nV = vendors.length;
  const sheetRef = ws.name.replace(/'/g, "''");
  const scoreRefs: Record<string, string> = {};

  ws.getCell('A1').value = `${cat.num}. ${cat.name}`;
  ws.getCell('A1').font = { size: 14, bold: true };
  ws.getCell('A2').value =
    'Score cells: amber = deferred, type a 0-5 score after reviewing the ' +
    "vendor's supplemental material; blue = scored, but the answer references " +
    'supplemental material worth reviewing (see Flags tab). Edits here flow ' +
    'to the Analysis and Summary totals automatically.';
  ws.getCell('A2').font = NOTE_FONT;
  let row = 3;

  ws.getCell(row, 1).value = 'Verbatim vendor responses';
  ws.getCell(row, 1).font = { bold: true, size: 12 };
  row += 1;
  const headers = ['Q#', 'Question', ...vendors];
  headers.forEach((label, i) =>
    styleHeader(Object.assign(ws.getCell(row, i + 1), { value: label })),
  );
  ws.getRow(row).height = 25;
  row += 1;

  const qSet = [...new Set(cat.criteria.flatMap((c) => c.questions))].sort(
    questionCompare,
  );
  for (const q of qSet) {
    ws.getCell(row, 1).value = q;
    ws.getCell(row, 1).alignment = CENTER;
    ws.getCell(row, 2).value = clean(spec.questions[q]);
    ws.getCell(row, 2).alignment = WRAP;

    let maxAnswerLen = 0;
    vendors.forEach((v, vi) => {
      let ans = (responses[v]?.[q]?.answer || '').trim();
      if (!ans) ans = '[RESPONSE NOT FOUND]';
      ws.getCell(row, 3 + vi).value = displayAnswer(ans);
      ws.getCell(row, 3 + vi).alignment = WRAP;
      maxAnswerLen = Math.max(maxAnswerLen, ans.length);
    });
    for (let c = 1; c < 3 + nV; c++) ws.getCell(row, c).border = BORDER;
    // Dynamic row height: ~15px per line, ~50 chars per line at width 60
    ws.getRow(row).height = Math.max(
      120,
      Math.min(600, (maxAnswerLen / 50) * 15),
    );
    row += 1;
  }
  row += 1;

  cat.criteria.forEach((crit, cj) => {
    const key = `${ci}_${cj}`;
    const vendorsD = scores[key]?.vendors || {};
    const rub = rubrics[key]?.levels || {};

    ws.getCell(row, 1).value = `Criterion: ${critLabel(crit)}`;
    ws.getCell(row, 1).font = { bold: true, size: 12 };
    row += 1;
    ws.getCell(row, 1).value = `Weight: ${(crit.weight * 100).toFixed(1)}%`;
    ws.getCell(row, 1).font = { italic: true };
    row += 1;
    if (crit.audience) {
      ws.getCell(row, 1).value = `Audience: ${crit.audience}`;
      ws.getCell(row, 1).font = { italic: true };
      row += 1;
    }

    ws.getCell(row, 1).value = 'Rubric';
    ws.getCell(row, 1).font = { bold: true };
    row += 1;
    for (const lvl of ['5', '4', '3', '2', '1', '0']) {
      ws.getCell(row, 1).value = lvl;
      ws.getCell(row, 1).alignment = CENTER;
      ws.getCell(row, 2).value = clean(rub[lvl] || '');
      ws.getCell(row, 2).alignment = WRAP;
      ws.getCell(row, 1).border = BORDER;
      ws.getCell(row, 2).border = BORDER;
      row += 1;
    }
    row += 1;

    ['Vendor', 'Score', 'Why'].forEach((label, i) =>
      styleHeader(Object.assign(ws.getCell(row, i + 1), { value: label })),
    );
    row += 1;
    for (const v of vendors) {
      const vd = vendorsD[v];
      ws.getCell(row, 1).value = v;
      ws.getCell(row, 1).alignment = CENTER;
      const scoreCell = ws.getCell(row, 2);
      if (vd?.deferred) {
        // Left blank for the reviewer's 0-5; amber marks it pending
        scoreCell.fill = DEFER_FILL;
      } else {
        scoreCell.value = vd?.score ?? 0;
        if (supp[suppKey(key, v)]) scoreCell.fill = SUPP_FILL;
      }
      scoreCell.alignment = CENTER;
      scoreRefs[suppKey(key, v)] = `'${sheetRef}'!B${row}`;
      ws.getCell(row, 3).value = clean(vd?.why || '');
      ws.getCell(row, 3).alignment = WRAP;
      for (let c = 1; c <= 3; c++) ws.getCell(row, c).border = BORDER;
      ws.getRow(row).height = 60;
      row += 1;
    }
    row += 2;
  });

  ws.getColumn(1).width = 8;
  ws.getColumn(2).width = 50;
  for (let i = 0; i < nV; i++) ws.getColumn(3 + i).width = 60;
  ws.views = [{ state: 'frozen', xSplit: 2, ySplit: 4 }];
  return { scoreRefs };
}

interface AnalysisResult {
  sectionRefs: Record<string, string>; // `${ci}|${vendor}` -> "E11" on Analysis
  totals: Record<string, number>;
}

function writeAnalysis(
  ws: ExcelJS.Worksheet,
  spec: CriteriaSpec,
  scores: Scores,
  vendors: string[],
  catRefs: Record<string, string>,
  supp: SuppMap,
): AnalysisResult {
  const nV = vendors.length;
  ws.getCell('B1').value = 'VENDOR CRITERIA & SELECTION GRID';
  ws.getCell('B1').font = { size: 14, bold: true };
  ws.getCell('B2').value = 'CRITERIA CHECKLIST';
  ws.getCell('B2').font = { size: 11, bold: true, italic: true };
  ws.getCell('B3').value =
    'Scores 0-5 (0 = N/A). Weighted score = (score / 5) × weight. ' +
    'This sheet is a computed view: score cells mirror the category ' +
    'tabs, so MAKE ALL EDITS ON THE CATEGORY TABS and every total ' +
    'here recalculates. Typing directly into this sheet breaks the ' +
    'mirror link for that cell. Amber cells are DEFERRED to human ' +
    'review — type a 0-5 score in the amber cell on the category tab.';
  ws.getCell('B3').font = NOTE_FONT;

  let row = 4;
  const sectionRefs: Record<string, string> = {};
  const totals: Record<string, number> = Object.fromEntries(
    vendors.map((v) => [v, 0]),
  );

  const headerCols = () => {
    const cols = ['Criterion', 'Weight'];
    for (const v of vendors) cols.push(`${v}\nSCORE`, `${v}\nWEIGHTED`);
    cols.push('BASIS FOR SCORE');
    return cols;
  };

  spec.categories.forEach((cat, ci) => {
    ws.getCell(row, 2).value = `${cat.num}. ${cat.name}`;
    ws.getCell(row, 2).font = SECTION_FONT;
    for (let c = 2; c <= 3 + 2 * nV + 1; c++)
      ws.getCell(row, c).fill = SECTION_FILL;
    row += 1;

    headerCols().forEach((label, i) =>
      styleHeader(Object.assign(ws.getCell(row, i + 2), { value: label })),
    );
    ws.getRow(row).height = 36;
    row += 1;

    const firstCritRow = row;
    let sectionWeight = 0;
    cat.criteria.forEach((crit, cj) => {
      const key = `${ci}_${cj}`;
      const vendorsD = scores[key]?.vendors || {};

      ws.getCell(row, 2).value = critLabel(crit);
      ws.getCell(row, 2).alignment = WRAP;
      ws.getCell(row, 3).value = crit.weight;
      ws.getCell(row, 3).numFmt = '0.0%';
      ws.getCell(row, 3).alignment = CENTER;

      let col = 4;
      for (const v of vendors) {
        const vd = vendorsD[v];
        const s = Number(vd?.score ?? 0);
        const scoreCell = ws.getCell(row, col);
        // Mirror the category tab's score cell so edits there flow here
        scoreCell.value = { formula: `=${catRefs[suppKey(key, v)]}`.slice(1) };
        if (isDeferred(vendorsD, v)) {
          scoreCell.fill = DEFER_FILL;
        } else {
          if (supp[suppKey(key, v)]) scoreCell.fill = SUPP_FILL;
          totals[v] += (s / 5.0) * crit.weight;
        }
        scoreCell.alignment = CENTER;
        const wCell = ws.getCell(row, col + 1);
        wCell.value = { formula: `(${colLetter(col)}${row}/5)*$C${row}` };
        wCell.numFmt = '0.0%';
        wCell.alignment = CENTER;
        col += 2;
      }
      ws.getCell(row, col).value = clean(basis(vendorsD, vendors));
      ws.getCell(row, col).alignment = WRAP;
      sectionWeight += crit.weight;
      for (let c = 2; c <= col; c++) ws.getCell(row, c).border = BORDER;
      row += 1;
    });
    const lastCritRow = row - 1;

    ws.getCell(row, 2).value = 'Section Total';
    ws.getCell(row, 2).font = TOTAL_FONT;
    ws.getCell(row, 3).value = sectionWeight;
    ws.getCell(row, 3).numFmt = '0.0%';
    ws.getCell(row, 3).font = TOTAL_FONT;
    let col = 4;
    for (const v of vendors) {
      const wCol = colLetter(col + 1);
      const cell = ws.getCell(row, col + 1);
      cell.value = {
        formula: `SUM(${wCol}${firstCritRow}:${wCol}${lastCritRow})`,
      };
      cell.numFmt = '0.0%';
      cell.font = TOTAL_FONT;
      sectionRefs[`${ci}|${v}`] = `${wCol}${row}`;
      col += 2;
    }
    for (let c = 2; c <= 3 + 2 * nV + 1; c++) {
      ws.getCell(row, c).fill = TOTAL_FILL;
      ws.getCell(row, c).border = BORDER;
    }
    row += 2;
  });

  // Roll-up
  ws.getCell(row, 2).value = 'CRITERIA SCORES';
  ws.getCell(row, 2).font = { size: 12, bold: true };
  row += 1;
  ['Category', 'Weight', ...vendors.map((v) => `${v}\nWEIGHTED`)].forEach(
    (label, i) =>
      styleHeader(Object.assign(ws.getCell(row, i + 2), { value: label })),
  );
  ws.getRow(row).height = 30;
  row += 1;

  const firstRollRow = row;
  let weightSum = 0;
  spec.categories.forEach((cat, ci) => {
    ws.getCell(row, 2).value = `${cat.num}. ${cat.name}`;
    ws.getCell(row, 2).alignment = WRAP;
    const wCat = cat.criteria.reduce((s, c) => s + c.weight, 0);
    weightSum += wCat;
    ws.getCell(row, 3).value = wCat;
    ws.getCell(row, 3).numFmt = '0.0%';
    ws.getCell(row, 3).alignment = CENTER;
    vendors.forEach((v, vi) => {
      const cell = ws.getCell(row, 4 + vi);
      cell.value = { formula: sectionRefs[`${ci}|${v}`] };
      cell.numFmt = '0.0%';
      cell.alignment = CENTER;
    });
    for (let c = 2; c < 4 + nV; c++) ws.getCell(row, c).border = BORDER;
    row += 1;
  });

  ws.getCell(row, 2).value = 'Total Score';
  ws.getCell(row, 2).font = TOTAL_FONT;
  ws.getCell(row, 3).value = weightSum;
  ws.getCell(row, 3).numFmt = '0.0%';
  ws.getCell(row, 3).font = TOTAL_FONT;
  vendors.forEach((v, vi) => {
    const col = colLetter(4 + vi);
    const cell = ws.getCell(row, 4 + vi);
    cell.value = { formula: `SUM(${col}${firstRollRow}:${col}${row - 1})` };
    cell.numFmt = '0.0%';
    cell.font = TOTAL_FONT;
  });
  for (let c = 2; c < 4 + nV; c++) {
    ws.getCell(row, c).fill = TOTAL_FILL;
    ws.getCell(row, c).border = BORDER;
  }

  ws.getColumn(1).width = 2;
  ws.getColumn(2).width = 50;
  ws.getColumn(3).width = 9;
  for (let i = 0; i < nV; i++) {
    ws.getColumn(4 + 2 * i).width = 9;
    ws.getColumn(5 + 2 * i).width = 12;
  }
  ws.getColumn(4 + 2 * nV).width = 60;
  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 4 }];
  // NOTE: no sheet protection. Strict openers (Numbers, Excel Online) can
  // refuse the whole workbook over a sheetProtection element.
  return { sectionRefs, totals };
}

function writeSummary(
  ws: ExcelJS.Worksheet,
  spec: CriteriaSpec,
  scores: Scores,
  vendors: string[],
  sectionRefs: Record<string, string>,
  totals: Record<string, number>,
): void {
  ws.getCell('A1').value = 'RFP Vendor Analysis — Summary';
  ws.getCell('A1').font = { size: 16, bold: true };
  ws.getCell('A2').value =
    'Generated by the RFP analyzer. Scores are 0-5 with rubric-anchored ' +
    'justifications. Totals are live formulas: edit any score cell on the ' +
    'category tabs (including amber DEFERRED cells) and this sheet ' +
    'recalculates. See the Flags tab for items needing human review.';
  ws.getCell('A2').alignment = WRAP;
  ws.getRow(2).height = 50;

  ['Category', 'Weight', ...vendors].forEach((label, i) =>
    styleHeader(Object.assign(ws.getCell(4, i + 1), { value: label })),
  );
  ws.getRow(4).height = 25;

  let row = 5;
  const firstCatRow = row;
  let weightSum = 0;
  spec.categories.forEach((cat, ci) => {
    ws.getCell(row, 1).value = `${cat.num}. ${cat.name}`;
    ws.getCell(row, 1).alignment = WRAP;
    const wCat = cat.criteria.reduce((s, c) => s + c.weight, 0);
    weightSum += wCat;
    ws.getCell(row, 2).value = wCat;
    ws.getCell(row, 2).numFmt = '0.0%';
    vendors.forEach((v, vi) => {
      const cell = ws.getCell(row, 3 + vi);
      cell.value = { formula: `Analysis!${sectionRefs[`${ci}|${v}`]}` };
      cell.numFmt = '0%';
    });
    for (let c = 1; c < 3 + vendors.length; c++)
      ws.getCell(row, c).border = BORDER;
    row += 1;
  });

  ws.getCell(row, 1).value = 'TOTAL';
  ws.getCell(row, 1).font = TOTAL_FONT;
  ws.getCell(row, 2).value = weightSum;
  ws.getCell(row, 2).numFmt = '0.0%';
  vendors.forEach((v, vi) => {
    const col = colLetter(3 + vi);
    const cell = ws.getCell(row, 3 + vi);
    cell.value = { formula: `SUM(${col}${firstCatRow}:${col}${row - 1})` };
    cell.numFmt = '0.00%';
    cell.font = TOTAL_FONT;
  });
  for (let c = 1; c < 3 + vendors.length; c++) {
    ws.getCell(row, c).fill = TOTAL_FILL;
    ws.getCell(row, c).border = BORDER;
  }
  row += 1;

  // Deferred counts per vendor (static count at generation time)
  const deferredCounts: Record<string, number> = Object.fromEntries(
    vendors.map((v) => [v, 0]),
  );
  for (const entry of Object.values(scores)) {
    for (const v of vendors) {
      if (isDeferred(entry.vendors || {}, v)) deferredCounts[v] += 1;
    }
  }
  if (vendors.some((v) => deferredCounts[v] > 0)) {
    ws.getCell(row, 1).value =
      'Criteria pending manual review (amber cells on the category tabs)';
    ws.getCell(row, 1).font = FLAG_FONT;
    vendors.forEach((v, vi) => {
      const cell = ws.getCell(row, 3 + vi);
      cell.value = deferredCounts[v];
      cell.alignment = CENTER;
      if (deferredCounts[v] > 0) {
        cell.fill = DEFER_FILL;
        cell.font = FLAG_FONT;
      }
    });
    row += 1;
  }

  row += 1;
  ws.getCell(row, 1).value = 'Ranking';
  ws.getCell(row, 1).font = { bold: true };
  const ranked = vendors.slice().sort((a, b) => totals[b] - totals[a]);
  ws.getCell(row, 2).value =
    ranked.map((v) => `${v} (${(totals[v] * 100).toFixed(1)}%)`).join(' > ') +
    ' (generated scores; totals above recalculate if scores are edited)';

  ws.getColumn(1).width = 45;
  ws.getColumn(2).width = 10;
  for (let i = 0; i < vendors.length; i++) ws.getColumn(3 + i).width = 14;
}

function writeFlags(
  ws: ExcelJS.Worksheet,
  spec: CriteriaSpec,
  scores: Scores,
  responses: Responses,
  vendors: string[],
  totals: Record<string, number>,
  extractionFlags: Array<{
    vendor: string;
    question: string;
    containment: number;
  }>,
  supp: SuppMap,
): void {
  ws.getCell('A1').value = 'Flags & Review Guide';
  ws.getCell('A1').font = { size: 14, bold: true };
  ws.getCell('A2').value =
    'Every row below is a mechanical fact about this run — no judgments. ' +
    'Locations reference the Analysis tab and category tabs.';
  ws.getCell('A2').font = NOTE_FONT;

  let row = 4;
  ['Type', 'Vendor', 'Location', 'Detail'].forEach((label, i) =>
    styleHeader(Object.assign(ws.getCell(row, i + 1), { value: label })),
  );
  row += 1;
  let flagCount = 0;

  const flag = (
    ftype: string,
    vendor: string,
    location: string,
    detail: string,
  ) => {
    ws.getCell(row, 1).value = ftype;
    ws.getCell(row, 1).font = FLAG_FONT;
    ws.getCell(row, 2).value = vendor;
    ws.getCell(row, 2).alignment = CENTER;
    ws.getCell(row, 3).value = clean(location);
    ws.getCell(row, 3).alignment = WRAP;
    ws.getCell(row, 4).value = clean(detail);
    ws.getCell(row, 4).alignment = WRAP;
    for (let c = 1; c <= 4; c++) ws.getCell(row, c).border = BORDER;
    row += 1;
    flagCount += 1;
  };

  // Deferred (amber) + supplemental (blue) cells, grouped per vendor: the
  // reviewer's unit of work is a vendor's supplemental packet, not a cell.
  type Item = [string, string, number]; // category, criterion, weight
  const catSummary = (items: Item[]) => {
    const byCat: Record<string, number> = {};
    for (const [catname] of items) byCat[catname] = (byCat[catname] || 0) + 1;
    return Object.entries(byCat)
      .map(([c, n]) => (n > 1 ? `${c} ×${n}` : c))
      .join(', ');
  };

  const amberByV: Record<string, Item[]> = Object.fromEntries(
    vendors.map((v) => [v, []]),
  );
  const blueByV: Record<string, Item[]> = Object.fromEntries(
    vendors.map((v) => [v, []]),
  );
  for (const [ci, cj, crit] of allCriteria(spec)) {
    const key = `${ci}_${cj}`;
    const vendorsD = scores[key]?.vendors || {};
    const catname = spec.categories[ci].name;
    for (const v of vendors) {
      if (isDeferred(vendorsD, v))
        amberByV[v].push([catname, crit.name, crit.weight]);
      else if (supp[suppKey(key, v)])
        blueByV[v].push([catname, crit.name, crit.weight]);
    }
  }

  for (const v of vendors) {
    const items = amberByV[v];
    if (!items.length) continue;
    const wAtStake = items.reduce((s, [, , w]) => s + w, 0);
    flag(
      'SCORE REQUIRED (amber)',
      v,
      `${items.length} cells, ${(wAtStake * 100).toFixed(1)}% of total weight — ${catSummary(items)}`,
      "These answers defer to this vendor's supplemental material. Open the " +
        'material once and type 0-5 scores into the amber cells on the listed ' +
        'category tabs — totals recalculate as you go. Until scored, these count as 0.',
    );
  }
  for (const v of vendors) {
    const items = blueByV[v];
    if (!items.length) continue;
    const wAtStake = items.reduce((s, [, , w]) => s + w, 0);
    flag(
      'REVIEW SUGGESTED (blue)',
      v,
      `${items.length} cells, ${(wAtStake * 100).toFixed(1)}% of total weight — ${catSummary(items)}`,
      'These answers were scored on their text but also reference supplemental ' +
        "material. While reviewing this vendor's packet for the amber cells, " +
        'glance at these and adjust any blue score that the material changes. ' +
        'Optional — scores stand without action.',
    );
  }

  // Answers not found in the vendor PDF
  const qIdsSorted = Object.keys(spec.questions).sort(questionCompare);
  for (const v of vendors) {
    const vdata = responses[v] || {};
    if (!Object.keys(vdata).length) continue;
    const missing = qIdsSorted.filter((q) => !vdata[q]?.found);
    if (missing.length) {
      flag(
        'ANSWER NOT FOUND',
        v,
        'Q' + missing.join(', Q'),
        "No answer was located in this vendor's PDF for these questions. If the " +
          'vendor did answer (e.g., in an attachment), the related criteria scored ' +
          'on absent evidence.',
      );
    }
  }

  // Criteria that never got scored (generation failure)
  for (const [ci, cj, crit] of allCriteria(spec)) {
    if (!scores[`${ci}_${cj}`]) {
      flag(
        'SCORING INCOMPLETE',
        'all',
        `${spec.categories[ci].name} / ${crit.name}`,
        'No scores were generated for this criterion (see run logs); its score ' +
          'cells default to 0. Review and score manually.',
      );
    }
  }

  // Answers that could not be verified verbatim against the vendor PDF
  for (const ef of extractionFlags) {
    const affected = allCriteria(spec)
      .filter(([, , c]) => c.questions.includes(ef.question))
      .map(([, , c]) => c.name);
    const loc =
      `Q${ef.question}` +
      (affected.length ? ` → ${affected.slice(0, 3).join(', ')}` : '');
    flag(
      'EXTRACTION UNVERIFIED',
      ef.vendor,
      loc,
      `Only ${Math.round(ef.containment * 100)}% of sampled passages from this ` +
        "extracted answer were located verbatim in the vendor's PDF — the text " +
        'may be partially paraphrased. Verify quotes against the source document ' +
        'before relying on them.',
    );
  }

  if (flagCount === 0) {
    ws.getCell(row, 1).value =
      'No flags — every criterion was scored from located answers.';
    row += 1;
  }

  // ── Where the ranking was decided (pure arithmetic) ──
  row += 2;
  ws.getCell(row, 1).value = 'WHERE THE RANKING WAS DECIDED';
  ws.getCell(row, 1).font = { size: 12, bold: true };
  row += 1;
  ws.getCell(row, 1).value =
    "Weighted-point contributions computed from this run's own scores (weight × " +
    'score difference). No judgments — just the cells that moved the totals most.';
  ws.getCell(row, 1).font = NOTE_FONT;
  row += 2;

  const ranked = vendors.slice().sort((a, b) => totals[b] - totals[a]);
  if (ranked.length >= 2) {
    const [va, vb] = ranked;
    const lead = (totals[va] - totals[vb]) * 100;
    ws.getCell(row, 1).value =
      `#1 ${va} vs #2 ${vb} — ${va} leads by ${lead.toFixed(1)} pts. ` +
      'Largest contributions to that lead:';
    ws.getCell(row, 1).font = { bold: true };
    row += 1;
    const contribs: Array<[number, string, string, number, number]> = [];
    for (const [ci, cj, crit] of allCriteria(spec)) {
      const vd = scores[`${ci}_${cj}`]?.vendors || {};
      const sa = Number(vd[va]?.score ?? 0);
      const sb = Number(vd[vb]?.score ?? 0);
      const pts = ((sa - sb) / 5.0) * crit.weight * 100;
      if (pts > 0)
        contribs.push([pts, crit.name, spec.categories[ci].name, sa, sb]);
    }
    contribs.sort((a, b) => b[0] - a[0]);
    for (const [pts, cname, catname, sa, sb] of contribs.slice(0, 5)) {
      ws.getCell(row, 1).value =
        `  ${cname} (${catname}): ${va} ${sa} vs ${vb} ${sb} → +${pts.toFixed(1)} pts`;
      ws.getCell(row, 1).alignment = WRAP;
      row += 1;
    }
    row += 1;
  }

  ws.getCell(row, 1).value =
    "Largest weighted score spreads across all vendors (where this RFP's scoring " +
    'separated vendors most):';
  ws.getCell(row, 1).font = { bold: true };
  row += 1;
  const spreads: Array<
    [number, string, string, string, number, string, number]
  > = [];
  for (const [ci, cj, crit] of allCriteria(spec)) {
    const vd = scores[`${ci}_${cj}`]?.vendors;
    if (!vd) continue;
    const svals = vendors.map(
      (v) => [v, Number(vd[v]?.score ?? 0)] as [string, number],
    );
    svals.sort((a, b) => b[1] - a[1]);
    const [vmx, smx] = svals[0];
    const [vmn, smn] = svals[svals.length - 1];
    const pts = ((smx - smn) / 5.0) * crit.weight * 100;
    if (pts > 0)
      spreads.push([
        pts,
        crit.name,
        spec.categories[ci].name,
        vmx,
        smx,
        vmn,
        smn,
      ]);
  }
  spreads.sort((a, b) => b[0] - a[0]);
  for (const [pts, cname, catname, vmx, smx, vmn, smn] of spreads.slice(0, 5)) {
    ws.getCell(row, 1).value =
      `  ${cname} (${catname}): ${vmx} ${smx} vs ${vmn} ${smn} → ${pts.toFixed(1)} weighted pts`;
    ws.getCell(row, 1).alignment = WRAP;
    row += 1;
  }

  ws.getColumn(1).width = 24;
  ws.getColumn(2).width = 14;
  ws.getColumn(3).width = 45;
  ws.getColumn(4).width = 70;
}

export async function run(params: {
  spec: CriteriaSpec;
  vendors: string[];
  responsesPath: string;
  rubricsPath: string;
  scoresPath: string;
  outputPath: string;
}): Promise<string> {
  const { spec, vendors, responsesPath, rubricsPath, scoresPath, outputPath } =
    params;
  const responses: Responses = existsSync(responsesPath)
    ? JSON.parse(readFileSync(responsesPath, 'utf-8'))
    : {};
  const rubrics: Rubrics = existsSync(rubricsPath)
    ? JSON.parse(readFileSync(rubricsPath, 'utf-8'))
    : {};
  const scores: Scores = existsSync(scoresPath)
    ? JSON.parse(readFileSync(scoresPath, 'utf-8'))
    : {};
  const extFlagsPath = join(dirname(responsesPath), 'extraction_flags.json');
  const extractionFlags = existsSync(extFlagsPath)
    ? JSON.parse(readFileSync(extFlagsPath, 'utf-8'))
    : [];

  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });

  const wb = new ExcelJS.Workbook();
  const supp = supplementalMap(spec, scores, responses, vendors);

  // Create sheets in display order; fill category tabs first since their
  // score cells are the source of truth the Analysis grid mirrors.
  const summaryWs = wb.addWorksheet('Summary');
  const flagsWs = wb.addWorksheet('Flags');
  const analysisWs = wb.addWorksheet('Analysis');
  const catRefs: Record<string, string> = {};
  spec.categories.forEach((cat, ci) => {
    const name = `${cat.num}. ${cat.sheet}`.slice(0, 31);
    const ws = wb.addWorksheet(name);
    Object.assign(
      catRefs,
      writeCategoryTab(ws, ci, spec, responses, rubrics, scores, vendors, supp)
        .scoreRefs,
    );
  });

  const { sectionRefs, totals } = writeAnalysis(
    analysisWs,
    spec,
    scores,
    vendors,
    catRefs,
    supp,
  );
  writeSummary(summaryWs, spec, scores, vendors, sectionRefs, totals);
  writeFlags(
    flagsWs,
    spec,
    scores,
    responses,
    vendors,
    totals,
    extractionFlags,
    supp,
  );

  await wb.xlsx.writeFile(outputPath);
  console.log(`  wrote ${outputPath}`);
  return outputPath;
}
