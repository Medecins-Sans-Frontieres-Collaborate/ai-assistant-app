import { Session } from 'next-auth';
import { NextRequest, NextResponse } from 'next/server';

import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';
import { canAccessGrants } from '@/lib/services/grants/access';
import { loadExpectedProjects } from '@/lib/services/grants/allocationList';
import {
  getDeployment,
  getGrantOpenAIClient,
} from '@/lib/services/grants/grantOpenAIClient';
import { loadOCConfig, resolveOC } from '@/lib/services/grants/ocConfig';
import {
  type DocExtract,
  normalizeName,
  reconcile,
} from '@/lib/services/grants/preprocess';
import { preprocessProgressPath } from '@/lib/services/grants/preprocessProgress';
import {
  grantPreprocessDir,
  isValidRunId,
  safeChildName,
  safeJoin,
} from '@/lib/services/grants/runPaths';
import * as extractText from '@/lib/services/grants/stages/extractText';

import { BlobProperty } from '@/lib/utils/server/blob/blob';

import { auth } from '@/auth';
import { writeFileSync } from 'fs';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

interface PreprocessRequestBody {
  oc: string;
  documentBlobPaths: string[];
  runId?: string;
}

// ---------------------------------------------------------------------------
// Lightweight progress writer (polled by /api/grants/preprocess/progress)
// ---------------------------------------------------------------------------

class PreprocessProgress {
  private path: string;
  private total = 0;
  constructor(runId: string) {
    this.path = preprocessProgressPath(runId);
  }
  private write(label: string, percent: number, status = 'running') {
    try {
      writeFileSync(
        this.path,
        JSON.stringify({
          status,
          label,
          percent: Math.max(0, Math.min(100, Math.round(percent))),
        }),
      );
    } catch {
      /* ignore */
    }
  }
  // --- StageProgressLike (consumed by extractText): text-extraction phase 2→50% ---
  stageStart(_name: string, total: number) {
    this.total = total;
    this.write('Extracting text from documents…', 2);
  }
  tick(completed: number, total?: number) {
    const t = total ?? this.total ?? 1;
    this.write(
      `Extracting text (${completed}/${t})`,
      t ? (completed / t) * 50 : 2,
    );
  }
  stageDone(_name: string) {
    this.write('Text extracted', 50);
  }
  // --- preprocess-specific phases ---
  micro(i: number, n: number) {
    this.write(
      `Reading project names & codes (${i}/${n})`,
      50 + (n ? (i / n) * 45 : 0),
    );
  }
  phase(label: string, percent: number) {
    this.write(label, percent);
  }
  // Terminal success: persist the full reconciliation result alongside the
  // progress so the polling client can read it once status === 'done'. The
  // file is intentionally NOT deleted here — the client fetches the result
  // via the progress endpoint after the background run finishes.
  done(result?: Record<string, unknown>) {
    try {
      writeFileSync(
        this.path,
        JSON.stringify({
          status: 'done',
          label: 'Done',
          percent: 100,
          ...(result || {}),
        }),
      );
    } catch {
      /* ignore */
    }
  }
  // Terminal failure: surface the error message to the polling client.
  fail(message: string) {
    try {
      writeFileSync(
        this.path,
        JSON.stringify({
          status: 'error',
          label: 'Failed',
          percent: 100,
          error: message,
        }),
      );
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Lightweight name/code micro-pass
// ---------------------------------------------------------------------------

function cleanJson(content: string): string {
  let c = content.trim();
  if (c.startsWith('```json')) c = c.slice(7);
  if (c.startsWith('```')) c = c.slice(3);
  if (c.endsWith('```')) c = c.slice(0, -3);
  return c.trim();
}

/**
 * Extract ONLY the verbatim project name and any explicitly-present project
 * code from a narrative. Deliberately does NOT standardize, translate, or
 * expand the name — we need the raw name to compare against the allocation list.
 */
async function extractNameAndCode(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  deployment: string,
  text: string,
  codeRegex: string,
  codePrefix: string = '',
): Promise<{ rawProjectName: string; projectCodeIfPresent: string }> {
  const prefixNote = codePrefix
    ? ` NOTE: in these documents the code is frequently written WITHOUT the "${codePrefix}" prefix (e.g. "BF103" or "ML 107" next to a "CODE PROJET"/"Project Code" label, for a full code like ${codePrefix}BF103/${codePrefix}ML107). If you see such a partial code, return it EXACTLY as written — do NOT add the "${codePrefix}" prefix yourself, and NEVER discard a code just because the prefix is missing.`
    : '';
  const prompt =
    `You are reading one MSF grant narrative document. Extract ONLY two things and return them as JSON:\n` +
    `1. "rawProjectName": the project name EXACTLY as written in the document — verbatim. Do NOT translate, standardize, expand acronyms, or reformat it. Copy it word-for-word as it appears after a "Project Name"/"Project"/"Title" label (or the document's own title if that's the project name).\n` +
    `2. "projectCodeIfPresent": the project code if one is EXPLICITLY written in the document (the full form matches the pattern ${codeRegex}).${prefixNote} If no code is present in the text, return an empty string "". Do NOT guess or invent a code.\n\n` +
    `Return strictly: {"rawProjectName": "...", "projectCodeIfPresent": "..."}\n\n` +
    `DOCUMENT TEXT:\n---\n`;

  const full =
    prompt +
    (text.length > 60000 ? text.slice(0, 60000) + '\n[Truncated]' : text);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await client.chat.completions.create({
        model: deployment,
        messages: [{ role: 'user', content: full }],
        temperature: 0,
        max_tokens: 400,
      });
      const content = resp.choices?.[0]?.message?.content || '';
      if (!content.trim()) {
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
        continue;
      }
      const parsed = JSON.parse(cleanJson(content)) as {
        rawProjectName?: string;
        projectCodeIfPresent?: string;
      };
      return {
        rawProjectName: String(parsed.rawProjectName || '').trim(),
        projectCodeIfPresent: String(parsed.projectCodeIfPresent || '').trim(),
      };
    } catch {
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
    }
  }
  return { rawProjectName: '', projectCodeIfPresent: '' };
}

/**
 * For multi-project documents (e.g. OCP country docs that list many
 * projects), resolve the verbatim project name for a specific code. The code is
 * known to appear in the text, so we send only a focused window around its first
 * occurrence rather than the whole (potentially hundreds-of-pages) document.
 * Returns the raw name exactly as written, or '' if it can't be determined.
 */
async function lookupProjectNameForCode(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  deployment: string,
  text: string,
  code: string,
): Promise<string> {
  // The clean project name often appears in a project list/table further down the
  // document, not at the codes first mention (which is frequently a budget line
  // or a context sentence). Gather a window around every occurrence of the code,
  // plus the document head for context, so the model can see the actual name.
  const radius = 1800;
  // Locate the code whitespace-tolerantly.
  const codePattern = code
    .toUpperCase()
    .split('')
    .map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s*');
  const codeRe = new RegExp(codePattern, 'gi');
  const windows: string[] = [];
  let occ = 0;
  let m: RegExpExecArray | null;
  while (occ < 8 && (m = codeRe.exec(text)) !== null) {
    const idx = m.index;
    windows.push(
      text.slice(
        Math.max(0, idx - radius),
        Math.min(text.length, idx + m[0].length + radius),
      ),
    );
    codeRe.lastIndex = idx + m[0].length;
    occ++;
  }
  const windowText = (
    text.slice(0, 1200) +
    (windows.length
      ? '\n…\n' + windows.join('\n…\n')
      : text.slice(0, 2 * radius))
  ).slice(0, 24000);

  const prompt =
    `You are reading excerpts of one MSF grant document that describes MULTIPLE projects. ` +
    `Find the project identified by the code "${code}" and return its PROJECT NAME/TITLE. ` +
    `Return the project's descriptive TITLE exactly as written in its own heading, title box, or project-list entry — a title-cased phrase, place, or disease name that labels the project (e.g. "Pediatric care in Maiduguri and Rural medical interventions with KFP (Borno)", "Cutaneous Leishmaniasis KPK", "Katsina"). ` +
    `A title that a heading shows together with sibling codes (e.g. a box reading "<title> … <codeA> & <codeB>") genuinely names this project — use it. ` +
    `Do NOT return a bare disease or activity word taken from a DATA or EMERGENCY-RESPONSE table row that sits beside case counts, dates, months, or durations (e.g. "${code} Meningitis 3 months 262 cases") — that is an outbreak/activity entry, not the project title. ` +
    `Only if the document EXPLICITLY states the project was renamed or split into separate projects each with its OWN distinct name (e.g. "<codeA> – Shinkafi, violence", "<codeB> – Zurmi, violence") should you return this code's distinct name instead of the shared title. ` +
    `Do NOT return a full sentence, an objective, the bare project code, or a lone abbreviation. Return it verbatim — do NOT translate, standardize, expand acronyms, or reformat it. ` +
    `If you cannot confidently determine the project name for "${code}", return an empty string. ` +
    `Return strictly JSON: {"projectName": "..."}\n\n` +
    `DOCUMENT EXCERPTS:\n---\n${windowText}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await client.chat.completions.create({
        model: deployment,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 200,
      });
      const content = resp.choices?.[0]?.message?.content || '';
      if (!content.trim()) {
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
        continue;
      }
      const parsed = JSON.parse(cleanJson(content)) as { projectName?: string };
      return String(parsed.projectName || '').trim();
    } catch {
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
    }
  }
  return '';
}

/**
 * Missing-code recovery: check whether a document describes a specific expected
 * project even though the full code isn't written. Authors sometimes include only
 * the bare project number (e.g. "Objetivo - Proyecto 107" for ESMX107), which
 * defeats exact code matching. Sends a focused excerpt built around occurrences
 * of the bare number and asks the model to confirm conservatively, returning
 * verbatim evidence so a human can review the likely match.
 */
async function recoverMissingCode(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  deployment: string,
  text: string,
  code: string,
  bareNumber: string,
  country: string,
  allocationName: string,
): Promise<{ found: boolean; evidence: string; narrativeName: string }> {
  // Excerpt = document head (title/context) + windows around the first few
  // bare-number occurrences, capped so the request stays small.
  const windows: string[] = [];
  const re = new RegExp(`\\b${bareNumber}\\b`, 'g');
  let match: RegExpExecArray | null;
  let count = 0;
  while ((match = re.exec(text)) !== null && count < 3) {
    const start = Math.max(0, match.index - 1200);
    const end = Math.min(text.length, match.index + 1200);
    windows.push(text.slice(start, end));
    count++;
  }
  const excerpt = (
    text.slice(0, 1500) +
    (windows.length ? '\n…\n' + windows.join('\n…\n') : '')
  ).slice(0, 12000);

  const prompt =
    `You are checking whether ONE MSF grant document describes a SPECIFIC project.\n` +
    `Target project code: "${code}" (country: ${country || 'unknown'}; allocation-list name: "${allocationName || 'unknown'}").\n` +
    `The FULL code may not be written in the document — it often appears only as the bare project number "${bareNumber}" (e.g., "Proyecto ${bareNumber}", "Project ${bareNumber}", "N° ${bareNumber}"), or the project may be identifiable by its name/location.\n` +
    `Be conservative: answer true ONLY if the text clearly ties to project number ${bareNumber} or the named project — NOT merely because it is the same country.\n` +
    `Return strictly JSON: {"found": true|false, "evidence": "<verbatim quote from the document supporting the match, or empty>", "narrativeName": "<the project name exactly as written in the document, or empty>"}\n\n` +
    `DOCUMENT EXCERPT:\n---\n${excerpt}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await client.chat.completions.create({
        model: deployment,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 300,
      });
      const content = resp.choices?.[0]?.message?.content || '';
      if (!content.trim()) {
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
        continue;
      }
      const parsed = JSON.parse(cleanJson(content)) as {
        found?: boolean;
        evidence?: string;
        narrativeName?: string;
      };
      return {
        found: Boolean(parsed.found),
        evidence: String(parsed.evidence || '').trim(),
        narrativeName: String(parsed.narrativeName || '').trim(),
      };
    } catch {
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
    }
  }
  return { found: false, evidence: '', narrativeName: '' };
}

// ---------------------------------------------------------------------------
// POST /api/grants/preprocess
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!canAccessGrants(session.user)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: PreprocessRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { documentBlobPaths } = body;
  // Canonical OC from the static allowlist — never the raw request string.
  const oc = resolveOC(body.oc);
  if (!oc || !documentBlobPaths || documentBlobPaths.length === 0) {
    return NextResponse.json(
      {
        error:
          'Missing required fields: OC and documentBlobPaths (non-empty array)',
      },
      { status: 400 },
    );
  }

  if (body.runId !== undefined && !isValidRunId(body.runId)) {
    return NextResponse.json({ error: 'Invalid runId' }, { status: 400 });
  }
  const runId = body.runId || uuidv4();

  // Run the coverage check in the background and report progress + the final
  // reconciliation via the temp progress file (polled by
  // /api/grants/preprocess/progress). Returning immediately keeps this request
  // well under the dev ingress/gateway stream timeout — for many large
  // documents the full extraction + micro-pass can take several minutes, which
  // previously exceeded that limit and surfaced as a 504 "stream timeout".
  void runCoverageCheck({ session, oc, documentBlobPaths, runId });

  return NextResponse.json({ runId, status: 'running' });
}

// ---------------------------------------------------------------------------
// Background worker: download → extract text → micro-pass → reconcile.
// Reports progress and the terminal result/error through the progress file.
// ---------------------------------------------------------------------------

async function runCoverageCheck(params: {
  session: Session;
  oc: string;
  documentBlobPaths: string[];
  runId: string;
}): Promise<void> {
  const { session, oc, documentBlobPaths, runId } = params;
  const workDir = grantPreprocessDir(runId);
  const prog = new PreprocessProgress(runId);

  try {
    const ocCfg = loadOCConfig(oc);
    const textDir = join(workDir, 'extracted_text');
    await mkdir(textDir, { recursive: true });

    const blobClient = createBlobStorageClient(session);

    // 1. Download selected narratives to a temp work dir.
    const localDocPaths: string[] = [];
    for (const blobPath of documentBlobPaths) {
      const fileName = safeChildName(blobPath);
      const localPath = safeJoin(workDir, fileName);
      const buffer = (await blobClient.get(
        blobPath,
        BlobProperty.BLOB,
      )) as Buffer;
      await writeFile(localPath, buffer);
      localDocPaths.push(localPath);
    }

    // 2. Stage-1 text extraction (reuse the existing stage) — progress 2→50%.
    const textMap = await extractText.run({
      documents: localDocPaths,
      outDir: textDir,
      progress: prog,
    });

    // 3. Lightweight LLM micro-pass per document → { rawProjectName, code }.
    const client = getGrantOpenAIClient();
    const deployment = getDeployment();
    const { readFileSync } = await import('node:fs');

    const docs: DocExtract[] = [];
    const entries = Object.entries(textMap);
    const microConcurrency = 2;
    let microDone = 0;
    for (let i = 0; i < entries.length; i += microConcurrency) {
      const batch = entries.slice(i, i + microConcurrency);
      const batchDocs = await Promise.all(
        batch.map(async ([filename, txtPath]) => {
          let text = '';
          try {
            text = readFileSync(txtPath, 'utf-8');
          } catch {
            text = '';
          }
          const { rawProjectName, projectCodeIfPresent } =
            await extractNameAndCode(
              client,
              deployment,
              text,
              ocCfg.code_regex,
              ocCfg.code_prefix,
            );
          return {
            file: filename,
            rawProjectName,
            projectCodeIfPresent,
            text,
          } as DocExtract;
        }),
      );
      docs.push(...batchDocs);
      microDone += batch.length;
      prog.micro(microDone, entries.length);
    }

    // 4. Load the expected (code, name) allocation list from the OC's
    //    supplemental files in blob (dedicated category, distinct from
    //    project_list). If none is found, expected is empty and the coverage
    //    check degrades to code-detection-only.
    const expected = await loadExpectedProjects({
      blobClient,
      oc,
      config: ocCfg,
      workDir,
    });

    // 5. Reconcile (pure logic).
    prog.phase('Reconciling against allocation list…', 96);
    const reconciliation = reconcile({
      expected,
      docs,
      multiProject: ocCfg.multi_project,
      coordKeywords: ocCfg.coord_keywords,
      codePrefix: ocCfg.code_prefix,
    });

    // 5b. Multi-project OCs (e.g. OCP): the micro-pass yields only one name per
    //     document, so resolve the verbatim per-code project name for each matched
    //     code with a targeted LLM lookup over a focused window of the narrative.
    if (ocCfg.multi_project) {
      const docByFile = new Map(docs.map((d) => [d.file, d]));
      const toResolve = reconciliation.rows.filter(
        (r) =>
          r.align === 'Yes' && !r.projectNameInNarrative && r.narrativeFile,
      );
      const concurrency = 5;
      let resolved = 0;
      for (let i = 0; i < toResolve.length; i += concurrency) {
        const batch = toResolve.slice(i, i + concurrency);
        await Promise.all(
          batch.map(async (row) => {
            const doc = docByFile.get(row.narrativeFile as string);
            if (!doc) return;
            const name = await lookupProjectNameForCode(
              client,
              deployment,
              doc.text,
              row.projectCodeInNarrative || row.projectCode,
            );
            if (name) row.projectNameInNarrative = name;
          }),
        );
        resolved += batch.length;
        prog.phase(
          `Resolving project names (${resolved}/${toResolve.length})…`,
          96 + (toResolve.length ? (resolved / toResolve.length) * 3 : 0),
        );
      }
    }

    // 5b-2. Single-project OCs occasionally have ONE narrative that documents
    //       several projects — e.g. OCBA's "Zamfara" project split into Shinkafi
    //       (ESNG107) and Zurmi (ESNG109) in a single file. The shared
    //       document-level name would otherwise be stamped onto every code in
    //       that file, so re-resolve each such code's name from a window around
    //       its own mention. Only fires when a file backs 2+ matched codes, so
    //       the common one-code-per-document rows are untouched.
    if (!ocCfg.multi_project) {
      const docByFile = new Map(docs.map((d) => [d.file, d]));
      const codesPerFile = new Map<string, number>();
      for (const r of reconciliation.rows) {
        if (r.align === 'Yes' && r.narrativeFile) {
          codesPerFile.set(
            r.narrativeFile,
            (codesPerFile.get(r.narrativeFile) || 0) + 1,
          );
        }
      }
      const shared = reconciliation.rows.filter(
        (r) =>
          r.align === 'Yes' &&
          r.narrativeFile &&
          (codesPerFile.get(r.narrativeFile) || 0) > 1,
      );
      const concurrency = 5;
      for (let i = 0; i < shared.length; i += concurrency) {
        const batch = shared.slice(i, i + concurrency);
        await Promise.all(
          batch.map(async (row) => {
            const doc = docByFile.get(row.narrativeFile as string);
            if (!doc) return;
            const name = await lookupProjectNameForCode(
              client,
              deployment,
              doc.text,
              row.projectCodeInNarrative || row.projectCode,
            );
            if (!name) return;
            row.projectNameInNarrative = name;
            // Name changed from the shared document name — recompute the note
            // against the allocation-list name so the row stays consistent.
            const aligned =
              normalizeName(row.projectName) === normalizeName(name);
            row.differences = aligned
              ? `Code found; allocation name "${row.projectName}" matches narrative name "${name}"`
              : `Code found; allocation name "${row.projectName}" vs narrative name "${name}"`;
            row.aligned = aligned
              ? 'Code and name match'
              : 'Code matches (name not compared)';
          }),
        );
      }
    }

    // 5c. Missing-code recovery: for codes still Not Found, look for implicit
    //     references (bare project number in a country-matching narrative) and
    //     confirm with a conservative LLM check, surfacing a "likely" match with
    //     verbatim evidence for human review.
    {
      const expectedByCode = new Map(
        expected.map((e) => [e.code.trim().toUpperCase(), e]),
      );
      const notFoundRows = reconciliation.rows.filter((r) => r.align === 'No');
      const concurrency = 3;
      let tried = 0;
      for (let i = 0; i < notFoundRows.length; i += concurrency) {
        const batch = notFoundRows.slice(i, i + concurrency);
        await Promise.all(
          batch.map(async (row) => {
            const code = row.projectCode.trim().toUpperCase();
            const bareNumber = (code.match(/\d{2,4}/) || [])[0] || '';
            if (!bareNumber) return;
            const e = expectedByCode.get(code);
            const country = e?.country || '';
            // Whole-word country match — a substring test let "Mali" match
            // inside Spanish words like "normalidad", attaching a Mexican
            // narrative's evidence to a Malian project.
            const countryRe = country
              ? new RegExp(
                  `\\b${country.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
                  'i',
                )
              : null;
            const numRe = new RegExp(`\\b${bareNumber}\\b`);
            const coordKw = ocCfg.coord_keywords || [];
            const isCoord = (f: string) =>
              coordKw.some(
                (kw) => kw && f.toLowerCase().includes(kw.toLowerCase()),
              );
            // Candidate docs: contain the bare number, and (when known) mention
            // the country — the LLM makes the final call, this only narrows cost.
            // Non-coordination narratives are checked first so they win the
            // first-confirmed match over coordination/strategy summaries.
            const candidates = docs
              .filter(
                (d) =>
                  numRe.test(d.text) &&
                  // Filename separators become spaces so "\bMexico\b" still
                  // hits "2026_E_AP_Mexico_CAI_Final.docx" (underscores are
                  // word characters and would defeat the boundary).
                  (!countryRe ||
                    countryRe.test(
                      `${d.text} ${d.file.replace(/[_\-.]/g, ' ')}`,
                    )),
              )
              .sort((a, b) => Number(isCoord(a.file)) - Number(isCoord(b.file)))
              .slice(0, 5);
            for (const cand of candidates) {
              const res = await recoverMissingCode(
                client,
                deployment,
                cand.text,
                code,
                bareNumber,
                country,
                e?.name || row.projectName,
              );
              if (res.found) {
                row.recovered = true;
                row.narrativeFile = cand.file;
                if (res.narrativeName)
                  row.projectNameInNarrative = res.narrativeName;
                row.evidence = res.evidence;
                row.differences =
                  `Likely match — full code not written; identified via project number ${bareNumber}` +
                  (res.evidence ? `. Evidence: "${res.evidence}"` : '');
                break;
              }
            }
          }),
        );
        tried += batch.length;
        prog.phase(
          `Recovering unlabeled project codes (${tried}/${notFoundRows.length})…`,
          99,
        );
      }

      // 5d. Name-based fallback: rows STILL not found after code search and
      //     number recovery, but whose allocation name content-matched a
      //     narrative (reconcile's proposals), surface as a "Likely (review)"
      //     match. These docs contain no code in any form, so the match can
      //     never be code-verified — it is flagged for human review, never
      //     shown as a confirmed match. Number-based recovery (5c) ran first
      //     because a project-number citation is stronger evidence than a name.
      {
        const proposalByCode = new Map(
          reconciliation.proposals.map((p) => [
            p.proposedCode.trim().toUpperCase(),
            p,
          ]),
        );
        for (const row of reconciliation.rows) {
          if (row.align !== 'No' || row.recovered) continue;
          const p = proposalByCode.get(row.projectCode.trim().toUpperCase());
          if (!p || p.confidence < 0.5) continue;
          // Anchor requirement: at least one matched term that is NOT part of
          // the country name must appear in the document's filename. Generic
          // terms ("violence", "crisis", the country itself) match many
          // narratives; the location appearing in the filename is what makes
          // the attribution reviewable rather than noise (and is exactly the
          // Bunyakiri/Ansongo/CAI shape the stakeholder flagged).
          const e = expectedByCode.get(row.projectCode.trim().toUpperCase());
          const countryToks = new Set(
            normalizeName(e?.country || '')
              .split(' ')
              .filter(Boolean),
          );
          const fileNorm = normalizeName(p.file);
          const anchored = p.matchedTerms.some(
            (t) => !countryToks.has(t) && fileNorm.includes(t),
          );
          if (!anchored) continue;
          row.recovered = true;
          row.narrativeFile = p.file;
          if (p.narrativeName) row.projectNameInNarrative = p.narrativeName;
          row.evidence =
            `Allocation name terms found in document: ${p.matchedTerms.join(', ')}` +
            (p.countryMatched ? '; country matches' : '');
          row.differences =
            `Likely match — no project code written in the narrative; ` +
            `allocation name "${row.projectName}" matched content in "${p.file}"` +
            (p.narrativeName
              ? ` (document names the project "${p.narrativeName}")`
              : '');
        }
      }

      // Recovered codes are no longer "missing" — drop them from that list so
      // the summary badge reflects only truly-unrecovered codes. They stay out
      // of `matched` (which is the strict, literal-code-present set).
      const recoveredCodes = new Set(
        reconciliation.rows
          .filter((r) => r.recovered)
          .map((r) => r.projectCode.trim().toUpperCase()),
      );
      if (recoveredCodes.size > 0) {
        reconciliation.missingFromNarratives =
          reconciliation.missingFromNarratives.filter(
            (c) => !recoveredCodes.has(c.trim().toUpperCase()),
          );
      }
    }

    prog.done({
      oc,
      hasExpectedList: expected.length > 0,
      reconciliation,
    });
  } catch (error) {
    console.error(
      '[Grants Preprocess] run failed:',
      runId,
      JSON.stringify(error instanceof Error ? error.message : String(error)),
    );
    prog.fail(error instanceof Error ? error.message : 'Internal server error');
  } finally {
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
