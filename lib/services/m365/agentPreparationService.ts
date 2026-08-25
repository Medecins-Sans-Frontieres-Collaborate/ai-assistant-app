/**
 * Per-file preparation for M365 agents — phase 4 of
 * docs/M365_SEVENTH_PASS_RECURSIVE_AGENT_SOURCES.md.
 *
 * Files the extractors can't read are turned into searchable text by an
 * EXPLICIT, per-file admin action — never as part of a recursive run:
 *
 *   image          → a vision model describes it and transcribes visible
 *                    text (one call)
 *   scanned PDF    → pdftoppm renders pages, the vision model reads each
 *                    (page markers kept so citations get "p. N")
 *   audio / video  → Whisper synchronously up to its 25MB limit; larger
 *                    files go through the existing chunked transcription
 *                    job, which the admin's browser polls; `complete`
 *                    then stores the transcript
 *
 * Output is cached per agent/item/eTag (agentDerivedTextStore); the
 * planner flips the file to `indexable` and the next index run reads the
 * derived text instead of extracting. A changed file drops back to
 * "needs preparation".
 */
import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import { ServiceContainer } from '@/lib/services/ServiceContainer';
import type {
  M365Agent,
  M365PreparationKind,
} from '@/lib/services/agentAccess/types';
import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';
import { guardTranscriptionMinutes } from '@/lib/services/limits/transcriptionBudget';
import {
  mutateDerivedIndex,
  readDerivedIndex,
  writeDerivedText,
} from '@/lib/services/m365/agentDerivedTextStore';
import { downloadItemBytes } from '@/lib/services/m365/agentIndexService';
import {
  MAX_M365_SOURCE_FILE_BYTES,
  classifyItem,
  extensionOf,
} from '@/lib/services/m365/agentSourcePlanner';
import { M365Error, graphJson } from '@/lib/services/m365/graphApi';
import { getJobForUser } from '@/lib/services/transcription/chunkedJobStore';
import { getChunkedTranscriptionService } from '@/lib/services/transcription/chunkedTranscriptionService';
import { WhisperTranscriptionService } from '@/lib/services/transcription/whisperTranscriptionService';

import { WHISPER_MAX_SIZE } from '@/lib/utils/app/const';
import { BlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { env } from '@/config/environment';
import { getFileCategory, getFileSizeLimit } from '@/lib/constants/fileLimits';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const GRAPH_SCOPES = ['Files.ReadWrite.All'];

/** Images above this are refused — vision inputs are small by design. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** Pages OCR'd per scanned PDF; beyond this the admin is told to split. */
const MAX_OCR_PAGES = 30;
const OCR_RENDER_DPI = 110;
/** Derived text cap, matching the extractor's budget order of magnitude. */
const MAX_DERIVED_CHARS = 2_000_000;
const OCR_PAGE_CONCURRENCY = 2;

export class PreparationError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = 'PreparationError';
  }
}

export type PreparationOutcome =
  | {
      status: 'prepared';
      kind: M365PreparationKind;
      itemId: string;
      name: string;
      eTag: string;
      chars: number;
    }
  | {
      status: 'pending';
      kind: M365PreparationKind;
      itemId: string;
      name: string;
      eTag: string;
      /** Chunked transcription job in the STARTING admin's user container. */
      jobId: string;
    }
  | { status: 'running'; itemId: string; jobId: string }
  | { status: 'failed'; itemId: string; error: string };

interface GraphItem {
  id?: string;
  name?: string;
  size?: number;
  eTag?: string;
  webUrl?: string;
  folder?: unknown;
  file?: { mimeType?: string };
  malware?: unknown;
}

function kindFor(name: string, mimeType?: string): M365PreparationKind | null {
  const ext = extensionOf(name);
  if (ext === 'pdf') return 'pdfOcr';
  const category = getFileCategory(name, mimeType);
  if (category === 'image' && ext !== 'svg') return 'image';
  if (category === 'audio') return 'audio';
  if (category === 'video') return 'video';
  return null;
}

function tempPath(name: string): string {
  return path.join(os.tmpdir(), `${randomUUID()}${path.extname(name)}`);
}

async function withTempFile<T>(
  name: string,
  buffer: Buffer,
  fn: (filePath: string) => Promise<T>,
  keep = false,
): Promise<T> {
  const filePath = tempPath(name);
  await fs.promises.writeFile(filePath, buffer);
  try {
    return await fn(filePath);
  } finally {
    if (!keep) await fs.promises.unlink(filePath).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Vision
// ---------------------------------------------------------------------------

const IMAGE_PROMPT =
  'You are preparing an image so it can be found by text search. Write plain text, no markdown: ' +
  '(1) a factual description of what the image shows; (2) every piece of visible text transcribed ' +
  'verbatim, including numbers, dates, labels and captions; (3) if it is a chart, table or diagram, ' +
  'the data and relationships it conveys. Do not speculate about what is not visible.';

const OCR_PROMPT =
  'This is one page of a scanned document. Transcribe ALL text on the page verbatim, preserving ' +
  'reading order, headings and paragraph breaks. Render tables as rows of cells separated by " | ". ' +
  'Briefly describe figures in square brackets. Output plain text only.';

async function describeWithVision(
  imageBuffer: Buffer,
  mimeType: string,
  prompt: string,
): Promise<string> {
  const client = ServiceContainer.getInstance().getOpenAIClient();
  const completion = await client.chat.completions.create({
    model: env.M365_AGENT_VISION_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: {
              url: `data:${mimeType};base64,${imageBuffer.toString('base64')}`,
              detail: 'high',
            },
          },
        ],
      },
    ],
  });
  return completion.choices[0]?.message?.content?.trim() ?? '';
}

async function ocrPdf(buffer: Buffer): Promise<string> {
  return withTempFile('scan.pdf', buffer, async (pdfPath) => {
    const outDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'm365-ocr-'),
    );
    try {
      await execFileAsync(
        'pdftoppm',
        [
          '-r',
          String(OCR_RENDER_DPI),
          '-png',
          '-l',
          String(MAX_OCR_PAGES),
          pdfPath,
          path.join(outDir, 'page'),
        ],
        { timeout: 120_000 },
      );
      const pages = (await fs.promises.readdir(outDir))
        .filter((f) => f.endsWith('.png'))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      if (pages.length === 0) {
        throw new PreparationError(
          'The PDF has no pages that could be rendered',
        );
      }
      const texts = new Array<string>(pages.length);
      let next = 0;
      await Promise.all(
        Array.from(
          { length: Math.min(OCR_PAGE_CONCURRENCY, pages.length) },
          async () => {
            for (;;) {
              const index = next++;
              if (index >= pages.length) return;
              const png = await fs.promises.readFile(
                path.join(outDir, pages[index]),
              );
              texts[index] = await describeWithVision(
                png,
                'image/png',
                OCR_PROMPT,
              );
            }
          },
        ),
      );
      // The pdfjs marker dialect, so chunkDocument attributes "p. N".
      return texts
        .map((text, i) => `--- Page ${i + 1} ---\n${text}`)
        .join('\n');
    } finally {
      await fs.promises
        .rm(outDir, { recursive: true, force: true })
        .catch(() => undefined);
    }
  });
}

// ---------------------------------------------------------------------------
// Preparation
// ---------------------------------------------------------------------------

export interface PrepareTarget {
  driveId: string;
  itemId: string;
}

/**
 * Prepares ONE file with the calling admin's token and stores the derived
 * text. Throws PreparationError for admin-facing refusals (wrong type,
 * too large, budget), M365Error for Graph/session problems.
 */
export async function prepareAgentItem(
  req: NextRequest,
  session: Session,
  storage: BlobStorage,
  agent: M365Agent,
  target: PrepareTarget,
): Promise<PreparationOutcome> {
  const meta = await graphJson<GraphItem>(
    req,
    GRAPH_SCOPES,
    `/drives/${encodeURIComponent(target.driveId)}/items/${encodeURIComponent(target.itemId)}` +
      '?$select=id,name,size,file,folder,eTag,malware,webUrl',
  );
  if (meta.folder || !meta.name || !meta.eTag) {
    throw new PreparationError('Only files can be prepared');
  }
  const classification = classifyItem({
    name: meta.name,
    size: meta.size,
    mimeType: meta.file?.mimeType,
    malware: !!meta.malware,
  });
  if (classification.reason === 'malware') {
    throw new PreparationError('Microsoft flagged this file as malware');
  }
  if (classification.reason === 'disallowedType') {
    throw new PreparationError('This file type is blocked');
  }
  const kind = kindFor(meta.name, meta.file?.mimeType);
  if (!kind) throw new PreparationError('This file type cannot be prepared');
  const size = meta.size ?? 0;
  if (size <= 0) throw new PreparationError('The file is empty');

  const mimeType = meta.file?.mimeType ?? 'application/octet-stream';
  const preparedAt = new Date().toISOString();
  const record = async (text: string, model?: string) => {
    const trimmed =
      text.length > MAX_DERIVED_CHARS
        ? `${text.slice(0, MAX_DERIVED_CHARS)}\n\n[… truncated …]\n`
        : text;
    if (!trimmed.trim()) {
      throw new PreparationError('Preparation produced no text for this file');
    }
    await writeDerivedText(
      storage,
      {
        version: 1,
        agentId: agent.id,
        itemId: meta.id ?? target.itemId,
        eTag: meta.eTag!,
        kind,
        preparedAt,
        ...(model && { model }),
        text: trimmed,
      },
      meta.name!,
    );
    return {
      status: 'prepared' as const,
      kind,
      itemId: meta.id ?? target.itemId,
      name: meta.name!,
      eTag: meta.eTag!,
      chars: trimmed.length,
    };
  };

  if (kind === 'image') {
    if (size > MAX_IMAGE_BYTES) {
      throw new PreparationError(
        `Images over ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))}MB cannot be prepared`,
      );
    }
    const { buffer } = await downloadItemBytes(
      req,
      target.driveId,
      target.itemId,
      meta.name,
      MAX_IMAGE_BYTES,
    );
    const text = await describeWithVision(buffer, mimeType, IMAGE_PROMPT);
    return record(text, env.M365_AGENT_VISION_MODEL);
  }

  if (kind === 'pdfOcr') {
    if (size > MAX_M365_SOURCE_FILE_BYTES) {
      throw new PreparationError(
        `PDFs over ${Math.round(MAX_M365_SOURCE_FILE_BYTES / (1024 * 1024))}MB cannot be prepared`,
      );
    }
    const { buffer } = await downloadItemBytes(
      req,
      target.driveId,
      target.itemId,
      meta.name,
    );
    const text = await ocrPdf(buffer);
    return record(text, env.M365_AGENT_VISION_MODEL);
  }

  // Audio / video — the admin's own transcription budget applies.
  const category = kind === 'audio' ? 'audio' : 'video';
  const mediaCap = getFileSizeLimit(category);
  if (size > mediaCap) {
    throw new PreparationError(
      `${kind === 'audio' ? 'Audio' : 'Video'} over ${Math.round(mediaCap / (1024 * 1024))}MB cannot be prepared`,
    );
  }
  const { buffer } = await downloadItemBytes(
    req,
    target.driveId,
    target.itemId,
    meta.name,
    mediaCap,
  );

  if (size <= WHISPER_MAX_SIZE) {
    return withTempFile(meta.name, buffer, async (filePath) => {
      const guard = await guardTranscriptionMinutes(session, filePath);
      if (!guard.allowed) {
        throw new PreparationError(
          guard.message ?? 'Transcription limit reached',
          429,
        );
      }
      const transcript = await new WhisperTranscriptionService().transcribe(
        filePath,
      );
      return record(transcript, 'whisper');
    });
  }

  // Larger media: the chunked job (ffmpeg split → parallel Whisper) runs in
  // the background on this replica; its state lives in the starting
  // admin's user container, so only they can complete it.
  const chunked = getChunkedTranscriptionService();
  if (!chunked.isAvailable()) {
    throw new PreparationError(
      'Files over 25MB need chunked transcription, which is not available on this server',
    );
  }
  const userStorage = createBlobStorageClient(session);
  // The temp file is handed to the background loop; it must outlive this
  // request (the chunked service cleans up its own chunk dir).
  const jobStart = await withTempFile(
    meta.name,
    buffer,
    async (filePath) => {
      const guard = await guardTranscriptionMinutes(session, filePath);
      if (!guard.allowed) {
        throw new PreparationError(
          guard.message ?? 'Transcription limit reached',
          429,
        );
      }
      return chunked.startJob(
        userStorage,
        filePath,
        meta.name!,
        session.user.id,
      );
    },
    true,
  );
  await mutateDerivedIndex(storage, agent.id, (index) => ({
    ...index,
    pending: {
      ...index.pending,
      [meta.id ?? target.itemId]: {
        jobId: jobStart.jobId,
        eTag: meta.eTag!,
        kind,
        name: meta.name!,
        startedAt: preparedAt,
        startedBy: session.user.mail ?? session.user.id,
      },
    },
  }));
  return {
    status: 'pending',
    kind,
    itemId: meta.id ?? target.itemId,
    name: meta.name,
    eTag: meta.eTag,
    jobId: jobStart.jobId,
  };
}

/**
 * Finishes a pending chunked transcription: when the job in the caller's
 * user container has succeeded, its transcript becomes the derived text.
 */
export async function completePendingPreparation(
  session: Session,
  storage: BlobStorage,
  agent: M365Agent,
  itemId: string,
): Promise<PreparationOutcome> {
  const { index } = await readDerivedIndex(storage, agent.id);
  const pending = index.pending[itemId];
  if (!pending)
    throw new PreparationError('No preparation is pending for this file', 404);

  const job = await getJobForUser(
    createBlobStorageClient(session),
    pending.jobId,
    session.user.id,
  );
  if (!job) {
    throw new PreparationError(
      `The transcription job was started by ${pending.startedBy} and can only be completed from their account`,
      409,
    );
  }
  if (job.status === 'pending' || job.status === 'processing') {
    return { status: 'running', itemId, jobId: pending.jobId };
  }
  if (job.status !== 'succeeded' || !job.transcript?.trim()) {
    await mutateDerivedIndex(storage, agent.id, (current) => {
      const { [itemId]: _gone, ...rest } = current.pending;
      void _gone;
      return { ...current, pending: rest };
    });
    return {
      status: 'failed',
      itemId,
      error: job.error ?? 'Transcription did not produce a transcript',
    };
  }
  const preparedAt = new Date().toISOString();
  await writeDerivedText(
    storage,
    {
      version: 1,
      agentId: agent.id,
      itemId,
      eTag: pending.eTag,
      kind: pending.kind,
      preparedAt,
      model: 'whisper',
      text: job.transcript.slice(0, MAX_DERIVED_CHARS),
    },
    pending.name,
  );
  console.log(
    `[m365-agents] completed chunked preparation for ${sanitizeForLog(agent.id)}/${sanitizeForLog(itemId)} (${job.transcript.length} chars)`,
  );
  return {
    status: 'prepared',
    kind: pending.kind,
    itemId,
    name: pending.name,
    eTag: pending.eTag,
    chars: Math.min(job.transcript.length, MAX_DERIVED_CHARS),
  };
}
