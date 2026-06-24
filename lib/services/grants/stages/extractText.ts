/**
 * Stage 1: Text extraction from PDF and DOCX documents.
 *
 * Uses Azure Document Intelligence REST API for PDF/DOCX files.
 * Writes one .txt file per input document into outDir/.
 * Results are cached by SHA-256 content hash.
 */
import { createHash } from 'crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { basename, extname, join } from 'path';

/**
 * Minimal structural progress interface. ProgressEmitter satisfies this, and
 * so does the preprocess route's lightweight progress writer — letting both
 * the full pipeline and the coverage check reuse this stage.
 */
export interface StageProgressLike {
  stageStart(name: string, total: number): void;
  tick(completed: number, total?: number): void;
  stageDone(name: string): void;
}

function diEndpoint(): string {
  return (
    process.env.GRANT_PIPELINE_DI_ENDPOINT ||
    process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT ||
    ''
  );
}

function diKey(): string {
  return (
    process.env.GRANT_PIPELINE_DI_KEY ||
    process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY ||
    ''
  );
}

function contentHash(filePath: string): string {
  const hash = createHash('sha256');
  const data = readFileSync(filePath);
  hash.update(data);
  return hash.digest('hex');
}

function contentHashBytes(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function safeStem(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, '');
  return stem.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function isUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function guessExtension(urlOrPath: string): string {
  try {
    const url = new URL(urlOrPath);
    const ext = extname(url.pathname).toLowerCase();
    if (['.pdf', '.docx', '.doc', '.txt'].includes(ext)) return ext;
  } catch {
    const ext = extname(urlOrPath).toLowerCase();
    if (['.pdf', '.docx', '.doc', '.txt'].includes(ext)) return ext;
  }
  return '.pdf';
}

async function downloadToTempFile(
  url: string,
  suffix: string = '.pdf',
): Promise<string> {
  const tmpPath = join(
    tmpdir(),
    `grant-doc-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`,
  );
  const resp = await fetch(url);
  if (!resp.ok)
    throw new Error(`Download failed: ${resp.status} ${resp.statusText}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  writeFileSync(tmpPath, buffer);
  return tmpPath;
}

/**
 * Extract text from a document using Azure Document Intelligence REST API.
 */
async function extractWithDocIntelligence(docPath: string): Promise<string> {
  const endpoint = diEndpoint();
  const key = diKey();

  if (!endpoint) {
    throw new Error(
      'No Azure Document Intelligence endpoint configured. ' +
        'Set GRANT_PIPELINE_DI_ENDPOINT or AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT.',
    );
  }
  if (!key) {
    throw new Error(
      'No Azure Document Intelligence key configured. ' +
        'Set GRANT_PIPELINE_DI_KEY or AZURE_DOCUMENT_INTELLIGENCE_KEY.',
    );
  }

  const fileBuffer = readFileSync(docPath);
  const ext = extname(docPath).toLowerCase();
  const contentType =
    ext === '.pdf'
      ? 'application/pdf'
      : ext === '.docx'
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : 'application/octet-stream';

  // Submit analysis request
  const analyzeUrl = `${endpoint.replace(/\/$/, '')}/documentintelligence/documentModels/prebuilt-layout:analyze?api-version=2024-11-30`;

  const submitResp = await fetch(analyzeUrl, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': contentType,
    },
    body: fileBuffer,
  });

  if (!submitResp.ok) {
    const body = await submitResp.text();
    throw new Error(
      `Document Intelligence submit failed: ${submitResp.status} - ${body}`,
    );
  }

  const operationLocation = submitResp.headers.get('operation-location');
  if (!operationLocation) {
    throw new Error(
      'No operation-location header in Document Intelligence response',
    );
  }

  // Poll for completion
  let attempts = 0;
  const maxAttempts = 120; // 10 minutes max
  while (attempts < maxAttempts) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    attempts++;

    const pollResp = await fetch(operationLocation, {
      headers: { 'Ocp-Apim-Subscription-Key': key },
    });

    if (!pollResp.ok) {
      throw new Error(`Document Intelligence poll failed: ${pollResp.status}`);
    }

    const result = (await pollResp.json()) as {
      status: string;
      analyzeResult?: { content?: string };
      error?: { message?: string };
    };

    if (result.status === 'succeeded') {
      return result.analyzeResult?.content || '';
    }
    if (result.status === 'failed') {
      throw new Error(
        `Document Intelligence analysis failed: ${result.error?.message || 'Unknown error'}`,
      );
    }
    // status is 'running' or 'notStarted' — continue polling
  }

  throw new Error('Document Intelligence analysis timed out');
}

async function extractText(docPath: string): Promise<string> {
  const ext = extname(docPath).toLowerCase();
  if (ext === '.txt') {
    return readFileSync(docPath, 'utf-8');
  }
  // Use Document Intelligence for PDF, DOCX, and other formats
  return extractWithDocIntelligence(docPath);
}

export interface ExtractTextResult {
  [filename: string]: string; // filename -> path to extracted .txt file
}

export async function run(params: {
  documents: string[];
  outDir: string;
  progress: StageProgressLike;
  cacheDir?: string;
}): Promise<ExtractTextResult> {
  const { documents, outDir, progress, cacheDir } = params;

  console.log('\n' + '='.repeat(60));
  console.log('  Stage 1: Extract Text (Azure Document Intelligence)');
  console.log('='.repeat(60));

  mkdirSync(outDir, { recursive: true });
  if (cacheDir) mkdirSync(cacheDir, { recursive: true });

  progress.stageStart('extract_text', documents.length);

  const resultMap: ExtractTextResult = {};
  const total = documents.length;

  for (let idx = 0; idx < documents.length; idx++) {
    const doc = documents[idx];
    const docIsUrl = isUrl(doc);
    let tmpFile: string | null = null;

    try {
      let docPath: string;
      let filename: string;

      if (docIsUrl) {
        const ext = guessExtension(doc);
        const urlPath = new URL(doc).pathname;
        filename = basename(urlPath) || `document_${idx + 1}${ext}`;
        console.log(
          `  [${idx + 1}/${total}] ${filename}: downloading from URL...`,
        );
        tmpFile = await downloadToTempFile(doc, ext);
        docPath = tmpFile;
      } else {
        docPath = doc;
        filename = basename(doc);
      }

      const safe = safeStem(docIsUrl ? filename : basename(docPath));
      const outPath = join(outDir, `${safe}.txt`);

      // Compute content hash
      const hash = contentHash(docPath);

      // Check cache
      if (cacheDir) {
        const cachedFile = join(cacheDir, `${hash}.txt`);
        if (existsSync(cachedFile)) {
          copyFileSync(cachedFile, outPath);
          resultMap[filename] = outPath;
          console.log(
            `  [${idx + 1}/${total}] ${filename}: cached (${hash.slice(0, 12)}...)`,
          );
          progress.tick(idx + 1, total);
          continue;
        }
      }

      // Extract text
      console.log(
        `  [${idx + 1}/${total}] ${filename}: extracting (${extname(docPath)})...`,
      );
      const text = await extractText(docPath);
      writeFileSync(outPath, text, 'utf-8');
      const charCount = text.length;
      console.log(
        `  [${idx + 1}/${total}] ${filename}: ${charCount.toLocaleString()} chars extracted`,
      );

      // Persist to cache
      if (cacheDir) {
        const cachedFile = join(cacheDir, `${hash}.txt`);
        copyFileSync(outPath, cachedFile);
      }

      resultMap[filename] = outPath;
      progress.tick(idx + 1, total);
    } finally {
      if (tmpFile && existsSync(tmpFile)) {
        try {
          unlinkSync(tmpFile);
        } catch {}
      }
    }
  }

  progress.stageDone('extract_text');
  console.log(`  Text extraction complete: ${total} document(s) processed.`);
  return resultMap;
}
