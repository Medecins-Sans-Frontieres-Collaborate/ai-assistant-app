/**
 * Stage 1: Text extraction from PDF and DOCX documents.
 *
 * Uses Azure Document Intelligence REST API for PDF/DOCX files.
 */
import { createHash } from 'crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
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

function safeStem(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, '');
  return stem.replace(/[^a-zA-Z0-9_-]/g, '_');
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

/** Simple concurrency limiter (sliding window). */
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

  const resultMap = new Map<string, string>();
  const failed: string[] = [];
  const total = documents.length;
  let completed = 0;
  const limit = pLimit(2);

  const processDoc = async (doc: string, idx: number): Promise<void> => {
    // `doc` is always a local file path downloaded by the caller from our own
    // blob storage; remote URLs are deliberately not supported here.
    const docPath = doc;
    const filename = basename(docPath);
    // Filenames originate from user-supplied blob paths — JSON.stringify them
    // in log lines so embedded newlines/control chars cannot forge log entries.
    const logName = JSON.stringify(filename);

    try {
      const safe = safeStem(filename);
      const outPath = join(outDir, `${safe}.txt`);

      // Compute content hash
      const hash = contentHash(docPath);

      // Check cache
      if (cacheDir) {
        const cachedFile = join(cacheDir, `${hash}.txt`);
        if (existsSync(cachedFile)) {
          copyFileSync(cachedFile, outPath);
          resultMap.set(filename, outPath);
          console.log(
            `  [${idx + 1}/${total}] ${logName}: cached (${hash.slice(0, 12)}...)`,
          );
          return;
        }
      }

      // Extract text
      console.log(
        `  [${idx + 1}/${total}] ${logName}: extracting (${extname(docPath)})...`,
      );
      const text = await extractText(docPath);
      writeFileSync(outPath, text, 'utf-8');
      const charCount = text.length;
      console.log(
        `  [${idx + 1}/${total}] ${logName}: ${charCount.toLocaleString()} chars extracted`,
      );

      // Persist to cache
      if (cacheDir) {
        const cachedFile = join(cacheDir, `${hash}.txt`);
        copyFileSync(outPath, cachedFile);
      }

      resultMap.set(filename, outPath);
    } catch (err) {
      // A single bad/corrupt/unsupported/oversized document (e.g. Document
      // Intelligence rejects it with "Invalid request") must NOT abort the whole
      // batch — log it, skip it, and let the rest of the documents through.
      failed.push(filename);
      console.error(
        `  [${idx + 1}/${total}] ${logName}: extraction FAILED — skipped (${JSON.stringify(err instanceof Error ? err.message : String(err))})`,
      );
    } finally {
      completed++;
      progress.tick(completed, total);
    }
  };

  await Promise.all(
    documents.map((doc, idx) => limit(() => processDoc(doc, idx))),
  );

  progress.stageDone('extract_text');
  console.log(
    `  Text extraction complete: ${total - failed.length}/${total} document(s) processed` +
      (failed.length
        ? `; ${failed.length} skipped (extraction failed): ${failed.map((f) => JSON.stringify(f)).join(', ')}`
        : '.'),
  );
  return Object.fromEntries(resultMap);
}
