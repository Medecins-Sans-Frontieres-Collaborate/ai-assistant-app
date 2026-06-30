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
  return clean.trim();
}

async function llmExtract(
  client: AzureOpenAI,
  deploymentName: string,
  prompt: string,
  docText: string,
  maxRetries: number = 3,
  temperature: number = 0.0,
): Promise<AnyRecord> {
  let fullPrompt = prompt + docText;
  if (fullPrompt.length > 120000) {
    fullPrompt = prompt + docText.slice(0, 100000) + '\n[Truncated]';
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
  ocCfg: OCConfig,
): AnyRecord | AnyRecord[] {
  if ('error' in result) return result;

  if (ocCfg.multi_project) {
    const projects = result.projects || [result];
    if (Array.isArray(projects) && projects.length > 0) {
      for (const proj of projects) {
        proj._source_file = sourceFile;
      }
      return projects;
    }
  }

  result._source_file = sourceFile;
  return result;
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
  const yearStr = String(year);
  const activities = record.activities_2026;
  if (!activities || !Array.isArray(activities) || activities.length === 0)
    return;

  const yearCount = (docText.match(new RegExp(yearStr, 'g')) || []).length;

  if (yearCount === 0) {
    record.activities_2026 = [];
    return;
  }

  if (yearCount >= 2) return;

  // Year appears only once — apply per-activity quote filtering
  const filtered = activities.filter((act: AnyRecord) => {
    const quoteEn = act.quote_english || '';
    const quoteOrig = act.quote_original || '';
    const section = act.section || '';
    return (
      quoteEn.includes(yearStr) ||
      quoteOrig.includes(yearStr) ||
      section.includes(yearStr)
    );
  });
  record.activities_2026 = filtered;
}

export async function run(params: {
  ocCfg: OCConfig;
  textDir: string;
  outDir: string;
  progress: ProgressEmitter;
  maxWorkers?: number;
  year?: number;
}): Promise<void> {
  const {
    ocCfg,
    textDir,
    outDir,
    progress,
    maxWorkers = 3,
    year = 2026,
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

  const prompt = buildExtractionPrompt(ocCfg, year);
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
        const result = await llmExtract(client, deploymentName, prompt, txt);
        const processed = extractSingle(result, fname, ocCfg);
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

  // Write all records to outDir
  for (let idx = 0; idx < allRecords.length; idx++) {
    const rec = allRecords[idx];
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
    `  Extraction complete: ${allRecords.length} record(s) from ${total} documents.`,
  );
}
