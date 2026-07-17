/**
 * Stage 2: LLM field extraction from grant document text.
 *
 * Uses Azure OpenAI to extract structured project information.
 */
import { getDeployment, getGrantOpenAIClient } from '../grantOpenAIClient';
import type { OCConfig } from '../ocConfig';
import type { ProgressEmitter } from '../progress';
import { buildExtractionPrompt } from '../prompts/extractionPrompt';

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import type { AzureOpenAI } from 'openai';
import { basename, join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

function loadTexts(textDir: string): Record<string, string> {
  const texts: Record<string, string> = {};
  const files = readdirSync(textDir)
    .filter((f) => f.endsWith('.txt'))
    .sort();
  for (const f of files) {
    texts[f] = readFileSync(join(textDir, f), 'utf-8');
  }
  return texts;
}

function cleanJsonResponse(content: string): string {
  let clean = content.trim();
  if (clean.startsWith('```json')) clean = clean.slice(7);
  if (clean.startsWith('```')) clean = clean.slice(3);
  if (clean.endsWith('```')) clean = clean.slice(0, -3);
  clean = clean.trim();

  const start = clean.indexOf('{');

  if (start < 0) return clean;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < clean.length; i++) {
    const ch = clean[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return clean.slice(start, i + 1);
    }
  }
  return clean.slice(start);
}

async function llmExtract(
  client: AzureOpenAI,
  deploymentName: string,
  prompt: string,
  docText: string,
  maxRetries: number = 3,
  temperature: number = 0.0,
): Promise<AnyRecord> {
  const MAX_INPUT_CHARS = 300000;
  let fullPrompt = prompt + docText;
  if (fullPrompt.length > MAX_INPUT_CHARS) {
    const budget = Math.max(0, MAX_INPUT_CHARS - prompt.length);
    fullPrompt = prompt + docText.slice(0, budget) + '\n[Truncated]';
    // Opts to not silently truncate since a chopped document loses projects and context.
    console.warn(
      `    ! TRUNCATED document text: ${docText.length.toLocaleString()} -> ${budget.toLocaleString()} chars ` +
        `(over the ${MAX_INPUT_CHARS.toLocaleString()}-char input budget). Projects/activities in the discarded tail WILL be missed.`,
    );
  }

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const resp = await client.chat.completions.create({
        model: deploymentName,
        messages: [{ role: 'user', content: fullPrompt }],
        temperature,
        max_tokens: 16384,
      });
      const choice = resp.choices[0];
      const content = choice.message.content || '';
      if (!content.trim()) {
        console.log(
          `    Attempt ${attempt + 1}: empty response (finish_reason=${choice.finish_reason})`,
        );
        lastErr = new Error('Empty response from model');
        await sleep(2 ** attempt * 1000);
        continue;
      }
      const cleaned = cleanJsonResponse(content);
      return JSON.parse(cleaned);
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      console.log(`    Attempt ${attempt + 1}: ${lastErr.message}`);
      await sleep(2 ** attempt * 1000);
    }
  }

  console.log(
    `    LLM call failed after ${maxRetries} attempts: ${lastErr?.message}`,
  );
  return { error: lastErr?.message || 'Unknown error' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractSingle(
  result: AnyRecord,
  sourceFile: string,
): AnyRecord | AnyRecord[] {
  if ('error' in result) return result;

  // The model classifies the whole DOCUMENT (project narrative vs coordination /
  // strategy / overview / compilation). For a multi-project response it sits at
  // the top level; apply it to every project from that document.
  const docType =
    typeof result.document_type === 'string' ? result.document_type.trim() : '';

  const clean = (rec: AnyRecord): AnyRecord => {
    rec._source_file = sourceFile;
    if (docType && !rec._document_type) rec._document_type = docType;
    // Canonicalize the project code: strip stray spaces/hyphens the source
    // sometimes introduces (e.g. "SL-125", "BD1-12") and uppercase, so codes
    // match the OC's pattern. OC-agnostic — no OC uses spaces/hyphens in codes.
    if (rec.project_code != null) {
      rec.project_code = String(rec.project_code)
        .replace(/[\s-]/g, '')
        .toUpperCase();
    }
    return rec;
  };

  // A document may bundle several distinct projects (any OC, not just OCP) — the
  // model returns {"projects":[...]}. Handle that universally so bundled codes
  // (e.g. "BD112 & BD114", "NG110 NG109") each become their own record; a
  // single-project doc falls through to the single-record path below.
  if (Array.isArray(result.projects) && result.projects.length > 0) {
    // Mark records that came from a document bundling multiple projects: for
    // those, downstream must trust the model's per-project code (the filename
    // carries only one code and would collapse them all to the first).
    const multi = result.projects.length > 1;
    return result.projects.map((p) => {
      const r = clean(p);
      if (multi) r._multi_code_doc = true;
      return r;
    });
  }

  return clean(result);
}

const NEVER_A_PROJECT_CODE = new Set(['FH360', 'HT174S']);

function detectMultiCodes(
  text: string,
  codeRegex: string,
  minOccurrences: number = 2,
  extraBlocklist: string[] = [],
): string[] {
  const body = codeRegex.replace(/^\^/, '').replace(/\$$/, '');
  let validate: RegExp;
  try {
    validate = new RegExp(`^${body}$`, 'i');
  } catch {
    return [];
  }

  const counts = new Map<string, number>();
  const re = /\b[A-Za-z]{1,3}\d{2,4}[A-Za-z]?\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const norm = m[0].toUpperCase();
    if (validate.test(norm)) counts.set(norm, (counts.get(norm) || 0) + 1);
  }
  const blocked = new Set([
    ...NEVER_A_PROJECT_CODE,
    ...extraBlocklist.map((c) => c.toUpperCase()),
  ]);
  return [...counts.entries()]
    .filter(([c, n]) => n >= minOccurrences && !blocked.has(c))
    .map(([c]) => c);
}

/**
 * Extract each project of a multi-project document with its OWN LLM call. Asking
 * one call for N projects reliably under-delivers — the model returns one or two
 * and offers to "continue", or answers in prose that breaks JSON parsing (observed
 * 2 of 8 on a DRC country doc). One project per call is a task it completes.
 */
async function extractPerCode(
  client: AzureOpenAI,
  deploymentName: string,
  prompt: string,
  fullText: string,
  sourceFile: string,
  codes: string[],
  year: number,
): Promise<AnyRecord[]> {
  const results: AnyRecord[] = [];
  const upper = fullText.toUpperCase();
  const head = fullText.slice(0, 3000); // country/context header
  const RADIUS = 6000;

  for (const code of codes) {
    // Focused excerpt: the document head (country/context) plus a window around
    // EVERY occurrence of this code — its table row, its section, its budget line.
    const windows: string[] = [];
    let from = 0;
    let occ = 0;
    while (occ < 6) {
      const idx = upper.indexOf(code.toUpperCase(), from);
      if (idx < 0) break;
      windows.push(
        fullText.slice(
          Math.max(0, idx - RADIUS),
          Math.min(fullText.length, idx + code.length + RADIUS),
        ),
      );
      from = idx + code.length;
      occ++;
    }
    const excerpt = (
      head + (windows.length ? '\n…\n' + windows.join('\n…\n') : '')
    ).slice(0, 120000);

    const codeHint =
      `\n\nIMPORTANT: This document covers MULTIPLE projects. FIRST decide what the token "${code}" actually IS in this document — judge the TOKEN's role, not whether the surrounding text happens to describe a project.\n\n` +
      `Return an EMPTY result — {"project_name": "", "project_objective": "", "activities_${year}": []} — if "${code}" is NOT this document's label for its own distinct project. It is NOT a project code when it is:\n` +
      `  * a road or route number, or another geographic/infrastructure reference (e.g. "à 20 kilomètres de la ville sur la ${code}", "axe ${code}");\n` +
      `  * a table column header, statistics label, or figure caption (e.g. "Cité Soleil - ${code}" heading a results table);\n` +
      `  * a passing reference to OTHER projects inside a different project's text (e.g. "réponses aux épidémies (${code}, ...)");\n` +
      `  * any other identifier (a date, a budget line, a document reference) that is not the label of a distinct project.\n` +
      `Surrounding text describing a real project does NOT make "${code}" that project's code — a road number printed inside a project's narrative is still a road number.\n\n` +
      `ONLY if "${code}" genuinely labels its OWN project here — it heads a project fiche/section/title, or is that project's row in a project table — extract THAT project: return a SINGLE JSON object (not a "projects" array), using only the passages describing "${code}".\n\n` +
      `NEVER copy another project's name, objective, or activities onto "${code}" — attributing one project's data to another code is a serious error.\n\n`;

    const result = await llmExtract(
      client,
      deploymentName,
      prompt,
      codeHint + excerpt,
    );
    if ('error' in result) {
      console.log(`      x ${code}: ${result.error}`);
      continue;
    }
    // Unwrap in case the model still answers with a projects array.
    const rec: AnyRecord =
      Array.isArray(result.projects) && result.projects.length > 0
        ? result.projects[0]
        : result;

    // The model signals "this code has no project description here" with an empty
    // name and no activities — it was only a passing reference inside another
    // project's text (e.g. "Ripostes aux épidémies (CD104, CD109 et CD113)"
    // inside CD140's fiche). Emitting a row here would copy the HOST project's
    // data onto this code — the wrong-attribution error we must never make.
    const nameEmpty = !String(rec.project_name || '').trim();
    const actsEmpty = !(rec[`activities_${year}`] || rec.activities_2026 || [])
      .length;
    if (nameEmpty && actsEmpty) {
      console.log(
        `      - ${code}: no dedicated project description in this document (passing reference) — skipped`,
      );
      continue;
    }

    rec.project_code = code; // pin: we know which project we asked for
    rec._source_file = sourceFile;
    rec._multi_code_doc = true; // downstream trusts this code over the filename
    if (
      typeof result.document_type === 'string' &&
      result.document_type.trim() &&
      !rec._document_type
    ) {
      rec._document_type = result.document_type.trim();
    }
    results.push(rec);
    const nActs = (rec.activities_2026 || []).length;
    console.log(
      `      + ${code}: ${String(rec.project_name || '?').slice(0, 45)}, ${nActs} activities`,
    );
  }
  return results;
}

function isCompilationDoc(filename: string, ocCfg: OCConfig): boolean {
  const patterns = ocCfg.compilation_patterns || [];
  const nameLower = filename.toLowerCase();
  return patterns.some((p) => nameLower.includes(p.toLowerCase()));
}

function splitCompilation(fullText: string): Record<string, string> {
  const codePattern = /\b([A-Z]{2}\d{2,4}[A-Z]?)\b/g;
  const allMatches: { code: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = codePattern.exec(fullText)) !== null) {
    allMatches.push({ code: m[1], index: m.index });
  }

  const sectionStarts: { code: string; pos: number }[] = [];
  const seen = new Set<string>();

  for (const match of allMatches) {
    if (seen.has(match.code) || match.code.length < 4) continue;
    const lookahead = fullText.slice(match.index, match.index + 300);
    if (
      /Start\s*\/?\s*end\s*date/i.test(lookahead) ||
      /International Typology/i.test(lookahead) ||
      /Objective\s*:/i.test(lookahead) ||
      /Project\s*(Name|Title)/i.test(lookahead)
    ) {
      sectionStarts.push({ code: match.code, pos: match.index });
      seen.add(match.code);
    }
  }

  sectionStarts.sort((a, b) => a.pos - b.pos);
  if (sectionStarts.length === 0) return {};

  const sections: Record<string, string> = {};
  for (let i = 0; i < sectionStarts.length; i++) {
    const { code, pos } = sectionStarts[i];
    const endPos =
      i + 1 < sectionStarts.length ? sectionStarts[i + 1].pos : fullText.length;

    const contextStart = Math.max(0, pos - 500);
    const prefix = fullText.slice(contextStart, pos);
    let countryHeader = '';
    const headerMatch = prefix.match(/#\s+([A-Z][a-z]+(?:\s+[A-Za-z]+)*)\s*$/m);
    if (headerMatch) {
      countryHeader = headerMatch[0] + '\n\n';
    }

    const sectionText = countryHeader + fullText.slice(pos, endPos);
    if (sectionText.length < 500) continue;

    sections[code] = sectionText;
  }

  return sections;
}

async function extractCompilation(
  client: AzureOpenAI,
  deploymentName: string,
  prompt: string,
  fullText: string,
  sourceFile: string,
): Promise<AnyRecord[]> {
  const sections = splitCompilation(fullText);
  if (Object.keys(sections).length === 0) {
    console.log('    WARNING: No project sections found in compilation doc');
    return [];
  }

  console.log(
    `    Split into ${Object.keys(sections).length} project sections: ` +
      Object.keys(sections).sort().join(', '),
  );

  const results: AnyRecord[] = [];
  for (const code of Object.keys(sections).sort()) {
    const sectionText = sections[code];
    const codeHint = `\n\nIMPORTANT: This section is for project code ${code}. Extract data for this project only.\n\n`;
    const docText = codeHint + sectionText;

    const result = await llmExtract(client, deploymentName, prompt, docText);
    if ('error' in result) {
      console.log(`      x ${code}: ${result.error}`);
      continue;
    }

    result.project_code = code;
    result._source_file = sourceFile;
    result._document_type =
      typeof result.document_type === 'string' && result.document_type.trim()
        ? result.document_type.trim()
        : 'compilation';
    results.push(result);

    const nActs = (result.activities_2026 || []).length;
    const name = (result.project_name || '?').slice(0, 50);
    console.log(`      + ${code}: ${name}, ${nActs} activities`);
  }

  return results;
}

/** Simple concurrency limiter. */
function pLimit(concurrency: number) {
  let active = 0;
  const queue: (() => void)[] = [];

  function next() {
    if (queue.length > 0 && active < concurrency) {
      active++;
      const run = queue.shift()!;
      run();
    }
  }

  return function <T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
  };
}

function normalizeActivitiesKey(record: AnyRecord, year: number): void {
  const yearKey = `activities_${year}`;
  if (yearKey in record && yearKey !== 'activities_2026') {
    record.activities_2026 = record[yearKey];
    delete record[yearKey];
  }
}

function filterActivitiesByYear(
  record: AnyRecord,
  year: number,
  docText: string,
): void {
  const activities = record.activities_2026;
  if (!activities || !Array.isArray(activities) || activities.length === 0)
    return;

  const yearStr = String(year);
  const yearCount = (docText.match(new RegExp(yearStr, 'g')) || []).length;

  // Only wipe activities when the target year is ENTIRELY ABSENT (an outdated /
  // wrong-year write-up). When the year IS present, trust the prompt's per-activity
  // gate: a document usually states its planning year once, not beside every
  // activity, so re-dropping activities whose quote lacked the literal year was
  // silently deleting real current-year services.
  if (yearCount === 0) {
    record.activities_2026 = [];
  }
}

export async function run(params: {
  ocCfg: OCConfig;
  textDir: string;
  outDir: string;
  progress: ProgressEmitter;
  maxWorkers?: number;
  year?: number;
  /** Full prompt template to use instead of the code default (from a saved or
   *  in-flight per-OC override). Falls back to buildExtractionPrompt when empty. */
  promptOverride?: string;
}): Promise<void> {
  const {
    ocCfg,
    textDir,
    outDir,
    progress,
    maxWorkers = 3,
    year = 2026,
    promptOverride,
  } = params;

  console.log('\n' + '='.repeat(60));
  console.log('  Stage 2: LLM Field Extraction');
  console.log('='.repeat(60));

  const texts = loadTexts(textDir);
  const total = Object.keys(texts).length;

  if (total === 0) {
    console.log('  No text files found; nothing to extract.');
    progress.stageStart('extract_fields', 0);
    progress.stageDone('extract_fields');
    return;
  }

  progress.stageStart('extract_fields', total);
  mkdirSync(outDir, { recursive: true });

  const prompt = promptOverride?.trim()
    ? promptOverride
    : buildExtractionPrompt(ocCfg, year);
  if (promptOverride?.trim()) {
    console.log('  Using custom prompt override for this run.');
  }
  const client = getGrantOpenAIClient();
  const deploymentName = getDeployment();

  console.log(
    `  Extracting fields from ${total} documents (${maxWorkers} workers, OC=${ocCfg.name})`,
  );

  const allRecords: AnyRecord[] = [];
  let completed = 0;

  // Separate compilation docs from regular docs
  const compilationDocs: Record<string, string> = {};
  const regularDocs: Record<string, string> = {};
  for (const [fname, txt] of Object.entries(texts)) {
    if (isCompilationDoc(fname, ocCfg)) {
      compilationDocs[fname] = txt;
    } else {
      regularDocs[fname] = txt;
    }
  }

  if (Object.keys(compilationDocs).length > 0) {
    console.log(
      `  Detected ${Object.keys(compilationDocs).length} compilation doc(s): ` +
        Object.keys(compilationDocs).join(', '),
    );
  }

  // Process compilation docs first (sequential, each splits into many)
  for (const [fname, txt] of Object.entries(compilationDocs)) {
    console.log(`\n  Splitting compilation: ${fname}`);
    const compResults = await extractCompilation(
      client,
      deploymentName,
      prompt,
      txt,
      fname,
    );
    allRecords.push(...compResults);
    completed++;
    progress.tick(completed, total);
    console.log(
      `    Compilation ${fname}: extracted ${compResults.length} projects`,
    );
  }

  // Process regular docs in parallel
  const limit = pLimit(maxWorkers);
  const promises = Object.entries(regularDocs).map(([fname, txt]) =>
    limit(async () => {
      try {
        // Being multi-project is a property of the document and not the OC (such docs
        // exist in every OC), so the threshold is intentionally permissive (>=1) and
        // only a candidate generator. The real gate is extractPerCode, which per
        // code refuses passing references. Errors are asymmetric: a false candidate
        // costs one call and is refused; a missed one is a silently-lost project.
        const codes = detectMultiCodes(
          txt,
          ocCfg.code_regex,
          1,
          ocCfg.code_blocklist || [],
        );

        if (codes.length > 1) {
          // One call per project — see extractPerCode for why the all-in-one
          // request silently under-delivers.
          const perCode = await extractPerCode(
            client,
            deploymentName,
            prompt,
            txt,
            fname,
            codes,
            year,
          );
          allRecords.push(...perCode);
          completed++;
          console.log(
            `    + ${fname}: ${perCode.length}/${codes.length} projects ` +
              `[${perCode.map((r) => r.project_code || '?').join(', ')}]`,
          );
          progress.tick(completed, total);
          return;
        }

        const result = await llmExtract(client, deploymentName, prompt, txt);
        const processed = extractSingle(result, fname);
        completed++;

        if ('error' in result) {
          console.log(`    x ${fname}: extraction error - ${result.error}`);
        } else if (Array.isArray(processed)) {
          allRecords.push(...processed);
          const codeList = processed.map((r) => r.project_code || '?');
          console.log(
            `    + ${fname}: ${processed.length} projects [${codeList.join(', ')}]`,
          );
        } else {
          allRecords.push(processed);
          const code = processed.project_code || '?';
          const nActs = (processed.activities_2026 || []).length;
          console.log(`    + ${fname}: ${code}, ${nActs} activities`);
        }

        progress.tick(completed, total);
      } catch (err) {
        completed++;
        console.log(`    x ${fname}: ${err}`);
        progress.tick(completed, total);
      }
    }),
  );

  await Promise.allSettled(promises);

  // Normalize activities key and filter by year
  for (const rec of allRecords) {
    normalizeActivitiesKey(rec, year);
    const sourceFile = rec._source_file || '';
    const docText = texts[sourceFile] || '';
    filterActivitiesByYear(rec, year, docText);
  }

  // Deduplicate by project code across documents (a code can appear in its own
  // narrative and in a coordination summary). Keep one record per code, preferring
  // a real narrative over a coordination doc, then the richer record. Records
  // without a code can't be deduped, so all are kept.
  const coordKw = ocCfg.coord_keywords || [];
  const activitiesKey = `activities_${year}`;
  const isCoordSource = (rec: AnyRecord): boolean => {
    const src = String(rec._source_file || '').toLowerCase();
    return coordKw.some((kw) => kw && src.includes(kw.toLowerCase()));
  };
  const richness = (rec: AnyRecord): number =>
    (rec[activitiesKey]?.length || 0) * 1000 +
    String(rec.project_objective || '').length;
  const byCode = new Map<string, AnyRecord>();
  const noCode: AnyRecord[] = [];
  for (const rec of allRecords) {
    const code = String(rec.project_code || '').toUpperCase();
    if (!code) {
      noCode.push(rec);
      continue;
    }
    const existing = byCode.get(code);
    if (!existing) {
      byCode.set(code, rec);
      continue;
    }
    const existingCoord = isCoordSource(existing);
    const recCoord = isCoordSource(rec);
    // Prefer the non-coordination source; if both are the same kind, keep the
    // richer record.
    const winner =
      existingCoord !== recCoord
        ? recCoord
          ? existing
          : rec
        : richness(rec) > richness(existing)
          ? rec
          : existing;
    if (winner !== existing) {
      console.log(
        `    dedup ${code}: preferring "${winner._source_file}" over "${existing._source_file}"`,
      );
    }
    byCode.set(code, winner);
  }
  const records = [...noCode, ...byCode.values()];

  // Write all records to outDir
  for (let idx = 0; idx < records.length; idx++) {
    const rec = records[idx];
    const source = rec._source_file || `record_${idx}`;
    const safeName = basename(source)
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-zA-Z0-9_-]/g, '_');
    const code = rec.project_code || '';
    const safeCode = code ? code.replace(/[^a-zA-Z0-9_-]/g, '_') : '';
    const outPath = join(
      outDir,
      safeCode ? `${safeName}_${safeCode}.json` : `${safeName}_${idx}.json`,
    );

    writeFileSync(outPath, JSON.stringify(rec, null, 2), 'utf-8');
  }

  progress.stageDone('extract_fields');
  console.log(
    `  Extraction complete: ${records.length} record(s) from ${total} documents` +
      (records.length !== allRecords.length
        ? ` (${allRecords.length - records.length} duplicate code(s) deduped).`
        : '.'),
  );
}
