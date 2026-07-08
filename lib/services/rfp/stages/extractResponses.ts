/**
 * Stage 2: batched verbatim per-question extraction, with three quality passes:
 *
 * 1. Batch pass — questions in batches of ~8, full PDF text in context.
 * 2. Stub retry pass — re-extracts answers that look like stubs (empty, short
 *    for a non-trivial question, or bare in-document pointers like
 *    "(RESPONSES BEGIN ON THE NEXT PAGE)").
 * 3. Verbatim-integrity pass — extraction promises verbatim text; every answer
 *    is verified by string containment against the vendor's own PDF text. A
 *    low-verbatim answer (paraphrase/composition) gets one strict re-extract;
 *    the better-matching version is kept (never regress). Unfixable answers
 *    are recorded in extraction_flags.json for the scorecard's Flags tab.
 */
import { llmJson, pLimit } from '../client';
import type { CriteriaSpec } from '../criteria';
import { questionIds } from '../criteria';
import type { ProgressEmitter } from '../progress';
import { safeVendorStem } from './extractPdfs';

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { mkdirSync } from 'fs';
import type { AzureOpenAI } from 'openai';
import { dirname, join } from 'path';

export interface AnswerEntry {
  answer: string;
  found: boolean;
}
export type Responses = Record<string, Record<string, AnswerEntry>>;

// Small batches keep per-call output budgets roomy: with too many questions
// per call, the model trims long answers to fit its token budget.
const BATCH_SIZE = 4;
const DEFAULT_SHORT_OK_LEN = 60;
const DEFAULT_STUB_THRESHOLD = 400;
const CONTAINMENT_OK = 0.6;

const EXTRACT_SYSTEM =
  "You are an RFP-analysis assistant. The user gives you the full text of one vendor's " +
  "RFP response and a subset of questions. For each question, return the vendor's " +
  "ANSWER VERBATIM (do not summarise, paraphrase, or rewrite). Preserve the vendor's " +
  'exact wording, bullet structure, and paragraph breaks (use plain text, newline-separated).\n\n' +
  'Rules:\n' +
  "- The vendor's response is typically organised by question number. Find the section " +
  '  that answers each requested question and return its full text.\n' +
  '- Strip page numbers, headers/footers, pagination artefacts but keep prose intact.\n' +
  '- If the vendor refers to an EXTERNAL appendix/sample/attachment whose content is not ' +
  '  in this document, include their pointer text verbatim.\n' +
  "- If the vendor's text points elsewhere WITHIN this document (e.g., '(RESPONSES BEGIN " +
  "  ON THE NEXT PAGE)', 'continued on the following page'), FOLLOW the pointer and " +
  '  return the actual answer content — never return only the pointer line.\n' +
  '- For multi-part questions, capture the full answer including all sub-parts.\n' +
  '- If you genuinely cannot find an answer, set found=false and answer="".\n' +
  '- Return strict JSON: {"responses": [{"q": "<id>", "answer": "<verbatim>", ' +
  '  "found": <bool>}]} — only for the requested question ids, in order.';

const AGGRESSIVE_SYSTEM =
  'You are an RFP-analysis assistant. The vendor PDF text below contains the verbatim ' +
  'answer to ONE question. A prior pass returned only a stub. Find the COMPLETE answer ' +
  'in the document and return it verbatim.\n\n' +
  'Critical:\n' +
  '- The answer may span multiple pages and may NOT be neatly labelled by the question ' +
  '  number. For multi-part questions about audiences/categories/topics, the answer might ' +
  '  be N separate sections titled by topic name. Concatenate ALL such sections.\n' +
  '- Sample/appendix questions often reference an attachment or link — return the pointer ' +
  "  text plus any preview/caption describing what's shown.\n" +
  '- Preserve original wording, structure, bullets. Strip page numbers/headers.\n' +
  '- If after thorough search you find nothing more than the prior stub, return the stub ' +
  '  and set found=true.\n\n' +
  'Return strict JSON: {"answer": "<verbatim>", "found": <bool>}.';

const STRICT_VERBATIM_SYSTEM =
  'You are an RFP-analysis assistant. A prior extraction pass returned text that does ' +
  "NOT appear verbatim in the vendor's document — it was paraphrased or composed. Find " +
  "the vendor's actual answer to the question in the document text below and COPY IT " +
  'EXACTLY, character for character. Never summarise, bridge sections with your own ' +
  'words, or smooth the wording. If the answer spans multiple sections, concatenate the ' +
  'exact source passages in order. If no relevant text exists, set found=false.\n\n' +
  'Return strict JSON: {"answer": "<exact copy>", "found": <bool>}.';

// In-document continuation pointers: the content exists later in the same PDF,
// so an "answer" that is only this phrase must be re-extracted, however short.
const POINTER_RE =
  /(begins?\s+on\s+the\s+(next|following)\s+page|responses?\s+begin|continued?\s+on\s+the\s+(next|following)|see\s+(the\s+)?(next|following)\s+(page|section)|on\s+the\s+(next|following)\s+pages?|(in|on)\s+the\s+following\s+\d+\s+pages?)/i;

function cleanInvisibleChars(text: string): string {
  // zero-width space/non-joiner/joiner, BOM, soft hyphen
  return text.replace(/\u200B|\u200C|\u200D|\uFEFF|\u00AD/g, '');
}

export function looksLikeStub(answer: string): boolean {
  if (!answer) return true;
  const a = answer.trim();
  if (a.length < 200 && POINTER_RE.test(a)) return true; // bare pointer is never the answer
  // Ends with a page footer → truncated at a page boundary, whatever the length
  if (/page\s+\d+\s+(of|\/)\s+\d+$/i.test(a)) return true;
  if (a.length < DEFAULT_SHORT_OK_LEN) return false; // might be a legit one-liner ("2009")
  if (a.length < DEFAULT_STUB_THRESHOLD) return true;
  // Bullet-list only (just the question's own enumerable choices)
  if ((a.match(/•/g) || []).length >= 5 && a.length < 700) return true;
  return false;
}

/** Normalise text for verbatim containment checks. */
export function normForMatch(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '');
}

/**
 * Fraction of sampled answer windows found verbatim in the source text. A
 * window also counts when matched with all spaces removed — PDF line-break
 * hyphenation inserts spurious spaces that are not extraction errors.
 */
export function containment(
  answer: string,
  textNorm: string,
  textSpaceless: string,
): number {
  const na = normForMatch(answer);
  if (!na) return 1.0;
  if (na.length <= 50) {
    return textNorm.includes(na) || textSpaceless.includes(na.replace(/ /g, ''))
      ? 1.0
      : 0.0;
  }
  const step = Math.max(1, Math.floor((na.length - 50) / 4));
  const windows: string[] = [];
  for (let i = 0; i < na.length - 49 && windows.length < 5; i += step) {
    windows.push(na.slice(i, i + 50));
  }
  const hits = windows.filter(
    (w) => textNorm.includes(w) || textSpaceless.includes(w.replace(/ /g, '')),
  ).length;
  return hits / windows.length;
}

function batches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

function buildUser(
  spec: CriteriaSpec,
  vendor: string,
  pdfText: string,
  qIds: string[],
): string {
  const questionsBlock = qIds
    .map((n) => `Q${n}. ${spec.questions[n]}`)
    .join('\n');
  return (
    `Vendor: ${vendor}\n\n` +
    `=== REQUESTED QUESTIONS (${qIds.length}) ===\n${questionsBlock}\n\n` +
    `=== VENDOR RESPONSE TEXT ===\n${pdfText}\n\n` +
    `Return verbatim answers for the ${qIds.length} requested questions.`
  );
}

async function extractBatch(
  client: AzureOpenAI,
  spec: CriteriaSpec,
  vendor: string,
  pdfText: string,
  qIds: string[],
): Promise<Record<string, AnswerEntry>> {
  const result = await llmJson(
    client,
    [
      { role: 'system', content: EXTRACT_SYSTEM },
      { role: 'user', content: buildUser(spec, vendor, pdfText, qIds) },
    ],
    { maxTokens: 12000 },
  );
  const out: Record<string, AnswerEntry> = {};
  for (const entry of (result.responses as Array<Record<string, unknown>>) ||
    []) {
    let q = String(entry.q ?? '').trim();
    if (q[0] === 'Q' || q[0] === 'q') q = q.slice(1).trim(); // tolerate "Q12a"
    if (!qIds.includes(q)) continue;
    const ans = cleanInvisibleChars(String(entry.answer || '').trim());
    out[q] = { answer: ans, found: Boolean(entry.found) && Boolean(ans) };
  }
  return out;
}

async function reextract(
  client: AzureOpenAI,
  spec: CriteriaSpec,
  vendor: string,
  pdfText: string,
  q: string,
  strict = false,
): Promise<AnswerEntry> {
  const user =
    `Vendor: ${vendor}\nQuestion: Q${q}. ${spec.questions[q]}\n\n` +
    `=== VENDOR RESPONSE TEXT ===\n${pdfText}\n\n` +
    'Find the complete verbatim answer and return JSON.';
  const result = await llmJson(
    client,
    [
      {
        role: 'system',
        content: strict ? STRICT_VERBATIM_SYSTEM : AGGRESSIVE_SYSTEM,
      },
      { role: 'user', content: user },
    ],
    { maxTokens: 12000 },
  );
  const ans = cleanInvisibleChars(String(result.answer || '').trim());
  return { answer: ans, found: Boolean(result.found) && Boolean(ans) };
}

export async function run(params: {
  client: AzureOpenAI;
  spec: CriteriaSpec;
  textDir: string;
  vendors: string[];
  cachePath: string;
  progress: ProgressEmitter;
  maxWorkers?: number;
}): Promise<Responses> {
  const {
    client,
    spec,
    textDir,
    vendors,
    cachePath,
    progress,
    maxWorkers = 4,
  } = params;
  mkdirSync(dirname(cachePath), { recursive: true, mode: 0o700 });
  const responses: Responses = existsSync(cachePath)
    ? JSON.parse(readFileSync(cachePath, 'utf-8'))
    : {};
  const pdfTexts: Record<string, string> = {};
  for (const v of vendors) {
    pdfTexts[v] = readFileSync(
      join(textDir, `${safeVendorStem(v)}.txt`),
      'utf-8',
    );
  }

  const qIds = questionIds(spec);
  const allBatches = batches(qIds, BATCH_SIZE);

  const jobs: Array<[string, string[]]> = [];
  for (const v of vendors) {
    responses[v] = responses[v] || {};
    for (const b of allBatches) {
      if (b.every((q) => responses[v][q]?.found)) continue;
      jobs.push([v, b]);
    }
  }

  progress.stageStart('extract_responses', jobs.length || 1);
  const flush = () =>
    writeFileSync(cachePath, JSON.stringify(responses, null, 2));

  if (!jobs.length) {
    // All batches cached — still run the stub + integrity passes below,
    // so cached answers get the same quality guarantees as fresh ones.
    console.log('  (all batches cached)');
  } else {
    console.log(`  ${jobs.length} batches × ${maxWorkers} workers`);
    const limit = pLimit(maxWorkers);
    let completed = 0;
    await Promise.all(
      jobs.map(([v, b]) =>
        limit(async () => {
          try {
            const out = await extractBatch(client, spec, v, pdfTexts[v], b);
            Object.assign(responses[v], out);
            const found = b.filter((q) => out[q]?.found).length;
            console.log(
              `  ✓ ${v} batch ${b[0]}-${b[b.length - 1]}: ${found}/${b.length} found`,
            );
          } catch (e) {
            console.log(`  ✗ ${v} batch ${b[0]}-${b[b.length - 1]}: ${e}`);
          }
          completed += 1;
          progress.tick(completed);
          if (completed % 4 === 0) flush();
        }),
      ),
    );
  }

  // Fill any missing slots (so downstream code never crashes)
  for (const v of vendors) {
    for (const q of qIds) {
      if (!responses[v][q]) responses[v][q] = { answer: '', found: false };
    }
  }

  // Stub-detection retry pass (in-place)
  const stubs: Array<[string, string]> = [];
  for (const v of vendors) {
    for (const q of qIds) {
      if (looksLikeStub(responses[v][q].answer)) stubs.push([v, q]);
    }
  }
  if (stubs.length) {
    console.log(`  retry pass: ${stubs.length} stubs`);
    for (const [v, q] of stubs) {
      try {
        const old = responses[v][q];
        const fresh = await reextract(client, spec, v, pdfTexts[v], q);
        if (fresh.answer.length > old.answer.length * 1.5) {
          responses[v][q] = fresh;
          console.log(
            `    ✓ ${v} Q${q}: ${old.answer.length} → ${fresh.answer.length} chars`,
          );
        }
      } catch (e) {
        console.log(`    ✗ ${v} Q${q}: ${e}`);
      }
    }
  }

  // Verbatim-integrity pass
  const normTexts: Record<string, string> = {};
  const spaceless: Record<string, string> = {};
  for (const v of vendors) {
    normTexts[v] = normForMatch(pdfTexts[v]);
    spaceless[v] = normTexts[v].replace(/ /g, '');
  }
  const suspects: Array<[string, string, number]> = [];
  for (const v of vendors) {
    for (const q of qIds) {
      const d = responses[v][q];
      if (!d.found || !d.answer) continue;
      const r = containment(d.answer, normTexts[v], spaceless[v]);
      if (r < CONTAINMENT_OK) suspects.push([v, q, r]);
    }
  }
  const extFlags: Array<{
    vendor: string;
    question: string;
    containment: number;
  }> = [];
  if (suspects.length) {
    console.log(`  integrity pass: ${suspects.length} low-verbatim answers`);
    for (const [v, q, rOldInit] of suspects) {
      let rOld = rOldInit;
      try {
        const fresh = await reextract(client, spec, v, pdfTexts[v], q, true);
        const rNew = fresh.found
          ? containment(fresh.answer, normTexts[v], spaceless[v])
          : 0;
        if (rNew > rOld) {
          responses[v][q] = fresh;
          console.log(
            `    ✓ ${v} Q${q}: containment ${Math.round(rOld * 100)}% → ${Math.round(rNew * 100)}%`,
          );
          rOld = rNew;
        } else {
          console.log(
            `    - ${v} Q${q}: retry no better (${Math.round(rNew * 100)}%); kept original`,
          );
        }
      } catch (e) {
        console.log(`    ✗ ${v} Q${q}: ${e}`);
      }
      if (rOld < CONTAINMENT_OK) {
        extFlags.push({
          vendor: v,
          question: q,
          containment: Math.round(rOld * 100) / 100,
        });
      }
    }
  }
  // Completeness pass. A verbatim answer can still be truncated — batched
  // extraction trims long answers to fit output budgets, typically stopping
  // at a page seam. Two baseline-free triggers, both resolved by one solo
  // re-extraction (full output budget for a single question), accepted only
  // if the result is longer AND still verbatim:
  //  1. Span under-fill: answers sorted by source position should roughly
  //     fill the span to the next answer's anchor.
  //  2. Abrupt ending: an answer that stops mid-sentence did not reach the
  //     real end of the vendor's response, wherever the page break fell.
  const COMPLETENESS_FILL = 0.5;
  const MIN_SPAN = 800;
  const MAX_SOLO_PER_VENDOR = 15;

  const endsAbruptly = (answer: string): boolean => {
    const a = answer.trim();
    if (a.length < 200) return false;
    // ignore trailing quotes/brackets, then require sentence-terminal punctuation
    const tail = a.replace(/["'”’)\]]+$/, '').trimEnd();
    return !/[.!?:%…]$/.test(tail);
  };

  for (const v of vendors) {
    const anchors: Array<{ q: string; pos: number; len: number }> = [];
    for (const q of qIds) {
      const na = normForMatch(responses[v][q].answer);
      if (na.length < 50) continue;
      const pos = normTexts[v].indexOf(na.slice(0, 50));
      if (pos >= 0) anchors.push({ q, pos, len: na.length });
    }
    anchors.sort((a, b) => a.pos - b.pos);
    const suspectsC = new Map<string, string>(); // q -> reason
    for (let i = 0; i < anchors.length; i++) {
      const spanEnd =
        i + 1 < anchors.length ? anchors[i + 1].pos : normTexts[v].length;
      const span = spanEnd - anchors[i].pos;
      const fill = anchors[i].len / span;
      if (span > MIN_SPAN && fill < COMPLETENESS_FILL) {
        suspectsC.set(
          anchors[i].q,
          `fills ${Math.round(fill * 100)}% of source span`,
        );
      }
    }
    for (const q of qIds) {
      if (!suspectsC.has(q) && endsAbruptly(responses[v][q].answer)) {
        suspectsC.set(q, 'ends mid-sentence');
      }
    }
    // 3. Continuation check: an answer should end where the next question
    //    begins (vendor documents echo each question before answering it).
    //    If plain prose continues right after our captured ending — rather
    //    than a question echo — the extraction stopped early, however
    //    complete the final sentence looks.
    const questionOpeners = qIds
      .map((q) => normForMatch(spec.questions[q]).slice(0, 40))
      .filter((o) => o.length >= 20);
    for (const q of qIds) {
      if (suspectsC.has(q)) continue;
      const na = normForMatch(responses[v][q].answer);
      if (na.length < 300) continue;
      const endAnchor = na.slice(-50);
      const endPos = normTexts[v].indexOf(endAnchor);
      if (endPos < 0) continue;
      const following = normTexts[v].slice(endPos + 50, endPos + 50 + 400);
      if (following.trim().length < 100) continue; // end of document
      const boundaryFollows = questionOpeners.some((o) =>
        following.includes(o),
      );
      if (!boundaryFollows) {
        suspectsC.set(q, 'prose continues past captured ending');
      }
    }
    if (!suspectsC.size) continue;
    console.log(`  completeness pass: ${v}: ${suspectsC.size} suspect answers`);
    for (const [q, reason] of [...suspectsC.entries()].slice(
      0,
      MAX_SOLO_PER_VENDOR,
    )) {
      try {
        const old = responses[v][q];
        const fresh = await reextract(client, spec, v, pdfTexts[v], q);
        const cOk =
          fresh.found &&
          containment(fresh.answer, normTexts[v], spaceless[v]) >=
            CONTAINMENT_OK;
        if (cOk && fresh.answer.length > old.answer.length * 1.05) {
          responses[v][q] = fresh;
          console.log(
            `    ✓ ${v} Q${q}: ${old.answer.length} → ${fresh.answer.length} chars (${reason})`,
          );
        } else {
          console.log(
            `    - ${v} Q${q}: retry not better; kept original (${reason})`,
          );
        }
      } catch (e) {
        console.log(`    ✗ ${v} Q${q}: ${e}`);
      }
    }
  }

  writeFileSync(
    join(dirname(cachePath), 'extraction_flags.json'),
    JSON.stringify(extFlags, null, 2),
  );
  if (extFlags.length) {
    console.log(
      `  !! ${extFlags.length} answers remain low-verbatim (flagged for review)`,
    );
  }

  flush();
  for (const v of vendors) {
    const found = qIds.filter((q) => responses[v][q].found).length;
    console.log(`  summary: ${v}: ${found}/${qIds.length} found`);
  }
  progress.stageDone('extract_responses');
  return responses;
}
