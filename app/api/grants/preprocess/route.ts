import { NextRequest, NextResponse } from 'next/server';

import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';
import { canAccessGrants } from '@/lib/services/grants/access';
import {
  getDeployment,
  getGrantOpenAIClient,
} from '@/lib/services/grants/grantOpenAIClient';
import {
  type SupplementalFileSpec,
  loadOCConfig,
} from '@/lib/services/grants/ocConfig';
import {
  type DocExtract,
  type ExpectedProject,
  reconcile,
} from '@/lib/services/grants/preprocess';
import { preprocessProgressPath } from '@/lib/services/grants/preprocessProgress';
import * as extractText from '@/lib/services/grants/stages/extractText';
import { loadTable } from '@/lib/services/grants/supplementalTable';

import { BlobProperty } from '@/lib/utils/server/blob/blob';

import { auth } from '@/auth';
import { rmSync, writeFileSync } from 'fs';
import { mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, join } from 'path';
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
  done() {
    this.write('Done', 100, 'done');
  }
  cleanup() {
    try {
      rmSync(this.path, { force: true });
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
): Promise<{ rawProjectName: string; projectCodeIfPresent: string }> {
  const prompt =
    `You are reading one MSF grant narrative document. Extract ONLY two things and return them as JSON:\n` +
    `1. "rawProjectName": the project name EXACTLY as written in the document — verbatim. Do NOT translate, standardize, expand acronyms, or reformat it. Copy it word-for-word as it appears after a "Project Name"/"Project"/"Title" label (or the document's own title if that's the project name).\n` +
    `2. "projectCodeIfPresent": the project code if one is EXPLICITLY written in the document (it should match the pattern ${codeRegex}). If no code is present in the text, return an empty string "". Do NOT guess or invent a code.\n\n` +
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

// ---------------------------------------------------------------------------
// Expected (code, name) allocation list loader — blob → temp file → table
// ---------------------------------------------------------------------------

function matchBlobName(
  blobNames: string[],
  configFilename: string,
): string | null {
  const target = configFilename.toLowerCase();
  // exact
  for (const b of blobNames) if (basename(b).toLowerCase() === target) return b;
  // substring (config name inside blob name)
  for (const b of blobNames)
    if (basename(b).toLowerCase().includes(target)) return b;
  // keyword fallback
  for (const b of blobNames)
    if (basename(b).toLowerCase().includes('allocation')) return b;
  return null;
}

async function loadExpectedList(params: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  blobClient: any;
  oc: string;
  spec: SupplementalFileSpec;
  workDir: string;
}): Promise<ExpectedProject[]> {
  const { blobClient, oc, spec, workDir } = params;

  let blobNames: string[] = [];
  try {
    const blobs = await blobClient.listBlobs(`grants/${oc}/supplemental/`);
    blobNames = blobs.map((b: { name: string }) => b.name);
  } catch {
    return [];
  }

  const blobPath = matchBlobName(blobNames, spec.filename);
  if (!blobPath) return [];

  const localPath = join(workDir, basename(blobPath));
  const buffer = (await blobClient.get(blobPath, BlobProperty.BLOB)) as Buffer;
  await writeFile(localPath, buffer);

  const rows = loadTable(localPath, spec.skiprows || 0);
  const codeCol = String(spec.columns.code || 'Project Code');
  const nameCol = String(spec.columns.name || 'Project Name');
  const countryCol = String(spec.columns.country || 'Country');

  const out: ExpectedProject[] = [];
  for (const r of rows) {
    const code = String(r[codeCol] ?? '').trim();
    const name = String(r[nameCol] ?? '').trim();
    const country = String(r[countryCol] ?? '').trim();
    if (code && code.toUpperCase() !== 'NAN') out.push({ code, name, country });
  }
  return out;
}

// ---------------------------------------------------------------------------
// POST /api/grants/preprocess
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const runId = uuidv4();
  const workDir = join(tmpdir(), `grant-preprocess-${runId}`);
  let prog: PreprocessProgress | null = null;
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!canAccessGrants(session.user)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body: PreprocessRequestBody = await request.json();
    const { oc, documentBlobPaths } = body;
    prog = new PreprocessProgress(body.runId || runId);

    if (!oc || !documentBlobPaths || documentBlobPaths.length === 0) {
      return NextResponse.json(
        {
          error:
            'Missing required fields: oc and documentBlobPaths (non-empty array)',
        },
        { status: 400 },
      );
    }

    const ocCfg = loadOCConfig(oc);
    const textDir = join(workDir, 'extracted_text');
    await mkdir(textDir, { recursive: true });

    const blobClient = createBlobStorageClient(session);

    // 1. Download selected narratives to a temp work dir.
    const localDocPaths: string[] = [];
    const localToBlobName: Record<string, string> = {};
    for (const blobPath of documentBlobPaths) {
      const fileName = basename(blobPath);
      const localPath = join(workDir, fileName);
      const buffer = (await blobClient.get(
        blobPath,
        BlobProperty.BLOB,
      )) as Buffer;
      await writeFile(localPath, buffer);
      localDocPaths.push(localPath);
      localToBlobName[fileName] = fileName;
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
    const { readFileSync } = await import('fs');

    const docs: DocExtract[] = [];
    const entries = Object.entries(textMap);
    let microIdx = 0;
    for (const [filename, txtPath] of entries) {
      let text = '';
      try {
        text = readFileSync(txtPath, 'utf-8');
      } catch {
        text = '';
      }
      const { rawProjectName, projectCodeIfPresent } = await extractNameAndCode(
        client,
        deployment,
        text,
        ocCfg.code_regex,
      );
      docs.push({ file: filename, rawProjectName, projectCodeIfPresent, text });
      microIdx++;
      prog.micro(microIdx, entries.length);
    }

    // 4. Load the expected (code, name) allocation list from the OC's
    //    supplemental files in blob (dedicated category, distinct from
    //    project_list). If not configured/found, expected is empty.
    let expected: ExpectedProject[] = [];
    const allocSpec = ocCfg.supplemental_files?.allocation_list;
    if (allocSpec) {
      expected = await loadExpectedList({
        blobClient,
        oc,
        spec: allocSpec,
        workDir,
      });
    }

    // 5. Reconcile (pure logic).
    prog.phase('Reconciling against allocation list…', 97);
    const reconciliation = reconcile({
      expected,
      docs,
      multiProject: ocCfg.multi_project,
    });
    prog.done();

    return NextResponse.json({
      oc,
      hasExpectedList: expected.length > 0,
      reconciliation,
    });
  } catch (error) {
    console.error('[Grants Preprocess] error:', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 },
    );
  } finally {
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    if (prog) prog.cleanup();
  }
}
