/**
 * Grant pre-processing: coverage check + project-code matching.
 *
 *
 * Coverage is determined two ways (robust for multi-project country docs):
 *   1. A code is "found" if it appears literally in ANY narrative's text, or
 *      the micro-pass returned it for a document.
 *   2. For expected codes NOT found, we content-match the project NAME against
 *      every narrative's full text (keyword coverage + abbreviation expansion +
 *      country boost) and propose the best narrative for human review.
 */

export interface ExpectedProject {
  code: string;
  name: string;
  country?: string;
}

export interface DocExtract {
  /** Source narrative filename. */
  file: string;
  /** Project name exactly as written in the narrative (pre-standardization). */
  rawProjectName: string;
  /** Project code found in the narrative by the micro-pass, or '' if none. */
  projectCodeIfPresent: string;
  /** Full extracted narrative text (used for content/keyword + literal-code search). */
  text: string;
}

export interface NameMatchProposal {
  /** Expected project from the allocation list. */
  proposedCode: string;
  proposedName: string;
  country?: string;
  /** Narrative the project most likely appears in. */
  file: string;
  /** The name the micro-pass read from that narrative (may be '' for multi-project docs). */
  narrativeName: string;
  /** Which name keywords (or their abbreviations) were found in the narrative text. */
  matchedTerms: string[];
  /** True when the expected project's country was also found in the narrative. */
  countryMatched: boolean;
  confidence: number; // 0..1
}

export interface ReconciliationRow {
  projectCode: string; // allocation list
  projectName: string; // allocation list
  projectCodeInNarrative: string; // found in narrative, or '' if none
  projectNameInNarrative: string; // raw, as found in narrative
  // Narrative the code was matched in (used to resolve multi-project names).
  narrativeFile?: string;
  /** True when a Not-Found code was recovered via the missing-code LLM pass
   *  (e.g. the document references only the bare project number, not the full
   *  code). Such rows are "likely" matches surfaced for human review. */
  recovered?: boolean;
  // Verbatim supporting quote from the narrative backing a recovered match.
  evidence?: string;
  align: 'Yes' | 'No';
  differences: string;
  aligned: string;
}

export interface Reconciliation {
  rows: ReconciliationRow[];
  expected: string[];
  found: string[];
  matched: string[];
  missingFromNarratives: string[];
  proposals: NameMatchProposal[];
}

export const RECONCILIATION_COLUMNS = [
  'Project Code',
  'Project Name',
  'Project Code in Narrative',
  'Project Name in Narrative',
  'Do Allocation List and Narrative Align?',
  'What are the differences?',
  'What is aligned?',
] as const;

/** Minimum keyword coverage for a content match to be proposed. */
export const COVERAGE_THRESHOLD = 0.5;

// Generic, low-signal words stripped from project names before keyword matching.
const STOPWORDS = new Set([
  'project',
  'projects',
  'programme',
  'program',
  'response',
  'care',
  'health',
  'healthcare',
  'support',
  'services',
  'service',
  'the',
  'of',
  'and',
  'for',
  'to',
  'in',
  'a',
  'an',
  'de',
  'du',
  'des',
  'la',
  'le',
  'les',
  'et',
  'with',
]);

// Lightweight medical abbreviation expansion so a name token like
// "tuberculosis" matches "TB" in the body (and vice-versa).
const SYNONYMS: Record<string, string[]> = {
  tuberculosis: ['tb', 'drtb', 'mdrtb', 'dr-tb', 'mdr-tb'],
  tb: ['tuberculosis'],
  hiv: ['aids', 'art', 'arv'],
  malnutrition: ['nutrition', 'sam', 'mam', 'itfc', 'atfc'],
  nutrition: ['malnutrition', 'sam', 'mam'],
  maternal: ['maternity', 'obstetric', 'obstetrics', 'anc', 'pnc'],
  maternity: ['maternal', 'obstetric'],
  neonatal: ['neonatology', 'newborn'],
  measles: ['rougeole'],
  vaccination: ['vaccine', 'immunization', 'immunisation', 'epi'],
  leishmaniasis: ['kala', 'azar', 'cl', 'mcl'],
  cutaneous: ['cl'],
  surgery: ['surgical'],
  displacement: ['displaced', 'idp', 'idps', 'refugee', 'refugees'],
  violence: ['sgbv', 'gbv'],
};

function normalizeCode(code: string): string {
  return (code || '').trim().toUpperCase();
}

/** Lowercase, strip accents + punctuation, collapse whitespace. */
export function normalizeName(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(s: string): string[] {
  const n = normalizeName(s);
  return n ? n.split(' ').filter(Boolean) : [];
}

/** Significant (non-stopword, length ≥ 3) tokens of a project name. */
function significantTokens(name: string): string[] {
  const toks = tokenize(name).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  // Fall back to all tokens if stopword-stripping left nothing.
  return toks.length > 0 ? toks : tokenize(name).filter((t) => t.length >= 2);
}

/** Does a whole word (or one of its synonyms) appear in the narrative text? */
function wordInText(word: string, normText: string): boolean {
  const candidates = [word, ...(SYNONYMS[word] || [])];
  for (const c of candidates) {
    const re = new RegExp(
      `\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
      'i',
    );
    if (re.test(normText)) return true;
  }
  return false;
}

/**
 * Literal project-code presence in a narrative (case-insensitive). Tolerant of a
 * single collapsed space between any two characters of the code: DOCX
 * run-splitting and author typos routinely fragment codes during text extraction
 * (e.g. "E SNG107" or "ESNG 107" for ESNG107), which a plain exact-string match
 * misses. Anchored on word boundaries so it can't start mid-word.
 */
function codeInText(code: string, normText: string): boolean {
  const norm = normalizeCode(code);
  if (!norm) return false;
  const esc = (ch: string) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let pattern = esc(norm[0]);
  for (let i = 1; i < norm.length; i++) {
    // Allow a single collapsed space between characters EXCEPT between two
    // digits: codes fragment at letter/letter and letter↔digit boundaries during
    // extraction, but a number run stays intact — and allowing spaces inside it
    // would false-match spaced figures in budget tables (e.g. "AF 1 10 500").
    const betweenDigits = /\d/.test(norm[i - 1]) && /\d/.test(norm[i]);
    pattern += (betweenDigits ? '' : ' ?') + esc(norm[i]);
  }
  const re = new RegExp(`\\b${pattern}\\b`, 'i');
  return re.test(normText);
}

interface ContentMatch {
  coverage: number;
  matchedTerms: string[];
  countryMatched: boolean;
}

/** Score how strongly an expected project's name appears in a narrative. */
function contentMatch(
  expected: ExpectedProject,
  doc: DocExtract,
): ContentMatch {
  const normText = ' ' + normalizeName(doc.text) + ' ';
  const tokens = significantTokens(expected.name);
  const matchedTerms: string[] = [];
  for (const t of tokens) {
    if (wordInText(t, normText)) matchedTerms.push(t);
  }
  const coverage = tokens.length > 0 ? matchedTerms.length / tokens.length : 0;

  let countryMatched = false;
  if (expected.country) {
    const haystack = normalizeName(doc.text + ' ' + doc.file);
    const countryToks = significantTokens(expected.country);
    countryMatched =
      countryToks.length > 0 &&
      countryToks.some((c) => wordInText(c, ' ' + haystack + ' '));
  }

  return { coverage, matchedTerms, countryMatched };
}

export function reconcile(params: {
  expected: ExpectedProject[];
  docs: DocExtract[];
  /** True for OCs whose narratives are country/region overviews covering many
   *  projects (e.g. OCP). For these there is no single per-project name to show. */
  multiProject?: boolean;
  /** Filename keywords marking coordination/strategy docs (from the OC config).
   *  When several documents contain a code, a real project narrative is preferred
   *  over a coordination summary. */
  coordKeywords?: string[];
}): Reconciliation {
  const { expected, docs, multiProject = false, coordKeywords = [] } = params;

  // Pre-normalize each doc's text once.
  const docNorm = new Map<string, string>();
  for (const d of docs) docNorm.set(d.file, ' ' + normalizeName(d.text) + ' ');

  // Micro-pass code → doc.
  const docByCode = new Map<string, DocExtract>();
  const foundCodeSet = new Set<string>();
  for (const d of docs) {
    const c = normalizeCode(d.projectCodeIfPresent);
    if (c) {
      foundCodeSet.add(c);
      if (!docByCode.has(c)) docByCode.set(c, d);
    }
  }

  const isCoordDoc = (file: string): boolean => {
    const f = file.toLowerCase();
    return coordKeywords.some((kw) => kw && f.includes(kw.toLowerCase()));
  };

  const rows: ReconciliationRow[] = [];
  const matched: string[] = [];
  const missingFromNarratives: string[] = [];
  const proposals: NameMatchProposal[] = [];

  for (const e of expected) {
    const code = normalizeCode(e.code);

    // Gather every document evidencing this code — the micro-pass (LLM read the
    // code) plus any literal occurrence (whitespace-tolerant, so fragmented codes
    // like "E SNG107" still match). Prefer a real project narrative over a
    // coordination/strategy summary when several documents contain the code.
    const candidates: DocExtract[] = [];
    const microDoc = docByCode.get(code) || null;
    if (microDoc) candidates.push(microDoc);
    for (const d of docs) {
      if (candidates.includes(d)) continue;
      if (codeInText(code, docNorm.get(d.file) || '')) candidates.push(d);
    }
    const foundDoc =
      candidates.find((d) => !isCoordDoc(d.file)) || candidates[0] || null;

    if (foundDoc) {
      foundCodeSet.add(code);
      matched.push(code);
      // Surface the raw (verbatim) narrative project name whenever we matched the
      // code. For single-project OCs one document = one project, so the micro-pass
      // name IS this project's name — use it directly whether the code was matched
      // via the micro-pass or found literally in the text. Multi-project country/
      // overview docs yield only a single micro-pass name for the whole document,
      // so we leave the name blank here and resolve it per-code with a targeted
      // LLM lookup after reconciliation (see the preprocess route).
      const narrName = multiProject ? '' : foundDoc.rawProjectName;
      const nameAligned = narrName
        ? normalizeName(e.name) === normalizeName(narrName)
        : false;
      rows.push({
        projectCode: e.code,
        projectName: e.name,
        projectCodeInNarrative: code,
        projectNameInNarrative: narrName,
        narrativeFile: foundDoc.file,
        align: 'Yes',
        differences: narrName
          ? nameAligned
            ? `Code found; allocation name "${e.name}" matches narrative name "${narrName}"`
            : `Code found; allocation name "${e.name}" vs narrative name "${narrName}"`
          : `Code ${code} found in narrative "${foundDoc.file}"`,
        aligned: narrName
          ? nameAligned
            ? 'Code and name match'
            : 'Code matches (name not compared)'
          : 'Code present in narrative',
      });
      continue;
    }

    // 3. No code found → content-match the NAME across all narratives.
    missingFromNarratives.push(code);

    let best: { doc: DocExtract; m: ContentMatch } | null = null;
    for (const d of docs) {
      const m = contentMatch(e, d);
      const accept =
        m.coverage >= COVERAGE_THRESHOLD ||
        (m.coverage > 0 && m.countryMatched);
      if (!accept) continue;
      const score = m.coverage + (m.countryMatched ? 0.15 : 0);
      const bestScore = best
        ? best.m.coverage + (best.m.countryMatched ? 0.15 : 0)
        : -1;
      if (score > bestScore) best = { doc: d, m };
    }

    if (best) {
      const confidence = Math.min(
        1,
        best.m.coverage + (best.m.countryMatched ? 0.15 : 0),
      );
      proposals.push({
        proposedCode: e.code,
        proposedName: e.name,
        country: e.country,
        file: best.doc.file,
        narrativeName: best.doc.rawProjectName,
        matchedTerms: best.m.matchedTerms,
        countryMatched: best.m.countryMatched,
        confidence: Number(confidence.toFixed(2)),
      });
    }

    rows.push({
      projectCode: e.code,
      projectName: e.name,
      projectCodeInNarrative: '',
      // No reliable per-project name for a code-less / multi-project match —
      // leave blank rather than surface a document's name as if it were the
      // project's name.
      projectNameInNarrative: '',
      align: 'No',
      // Automated match suggestions are paused while the matching logic is
      // reworked, so the note simply states that nothing was found rather than
      // proposing a potential narrative.
      differences: 'No matching project code or name found in the narratives',
      aligned: '',
    });
  }

  return {
    rows,
    expected: expected.map((e) => normalizeCode(e.code)),
    found: [...foundCodeSet],
    matched,
    missingFromNarratives,
    proposals,
  };
}

function csvEscape(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function reconciliationToCsv(rec: Reconciliation): string {
  const header = RECONCILIATION_COLUMNS.join(',');
  const lines = rec.rows.map((r) =>
    [
      r.projectCode,
      r.projectName,
      r.projectCodeInNarrative,
      r.projectNameInNarrative,
      r.align,
      r.differences,
      r.aligned,
    ]
      .map((x) => csvEscape(String(x ?? '')))
      .join(','),
  );
  return [header, ...lines].join('\n');
}
