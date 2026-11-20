/**
 * Reading any document into THE DOCUMENT MODEL (documentModel.ts), and the
 * presentation engine's other operations, for every feature.
 *
 * Each format has one reader, run in the code-interpreter sandbox:
 *  - presentations: the presentation engine's `inspect` (a legacy .ppt,
 *    .pps or .pot, or an .odp, is converted to .pptx first);
 *  - PDFs: the PDF reader;
 *  - Word documents: the Word reader for what the file declares, placed
 *    on the pages of its PDF rendering, whose pictures (with their places)
 *    stand for the document's (a .doc, .odt or .rtf is converted to .docx
 *    first).
 */
import { WorkflowUsageCollector } from '@/lib/services/workflows/shared/workflowUsage';

import {
  DocumentModel,
  placeUnits,
} from '@/lib/utils/shared/documents/documentModel';
import { isPresentationType } from '@/lib/utils/shared/documents/documentSource';

import { documentPdf } from '../render/documentPages';
import { RenderLane } from '../render/renderQueue';
import { getRenderService } from '../render/renderService';
import {
  SandboxInputFile,
  SandboxScript,
  runSandboxScript,
} from '../sandbox/sandboxScriptRunner';
import { DECK_ENGINE_SCRIPT } from './deckEngineScript';
import { DOCX_INSPECT_SCRIPT } from './docxInspectScript';
import { PDF_INSPECT_SCRIPT } from './pdfInspectScript';

import { strFromU8 } from 'fflate';
import fs from 'fs';
import path from 'path';

/** A file the reader refused to open, with its typed reason. */
export class DocumentRefusedError extends Error {
  constructor(
    /** ENCRYPTED, DAMAGED, DOCTYPE, ZIP_BOMB or TOO_LARGE. */
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DocumentRefusedError';
  }
}

/** Types read by converting to another first, and the conversion. */
const CONVERSIONS: Readonly<Record<string, { to: string; filter: string }>> = {
  ppt: { to: 'pptx', filter: 'pptx:Impress MS PowerPoint 2007 XML' },
  pps: { to: 'pptx', filter: 'pptx:Impress MS PowerPoint 2007 XML' },
  pot: { to: 'pptx', filter: 'pptx:Impress MS PowerPoint 2007 XML' },
  odp: { to: 'pptx', filter: 'pptx:Impress MS PowerPoint 2007 XML' },
  doc: { to: 'docx', filter: 'docx:MS Word 2007 XML' },
  odt: { to: 'docx', filter: 'docx:MS Word 2007 XML' },
  rtf: { to: 'docx', filter: 'docx:MS Word 2007 XML' },
};

/** Types inspectDocument reads. */
export const INSPECTABLE_TYPES: readonly string[] = [
  'pptx',
  'pptm',
  'ppsx',
  'potx',
  'pdf',
  'docx',
  ...Object.keys(CONVERSIONS),
];

/** What a reading is done with. */
export interface InspectContext {
  usage?: WorkflowUsageCollector;
  /** The render lane conversions wait in. */
  lane: RenderLane;
  /** A folder the caller owns and removes. */
  workDir: string;
  signal?: AbortSignal;
  onQueue?: (ahead: number) => void;
}

/** A document read: its model and the bytes of its pictures. */
export interface InspectedDocument {
  model: DocumentModel;
  /** A picture's bytes by its `file`, or null when there is none. */
  imageFile: (file: string) => Uint8Array | null;
}

/** Throws the reader's refusal, when it refused. */
export function throwIfRefused(files: Map<string, Uint8Array>): void {
  const refused = files.get('refused.json');
  if (!refused) return;
  const reason = JSON.parse(strFromU8(refused)) as {
    code?: string;
    message?: string;
  };
  throw new DocumentRefusedError(
    reason.code ?? 'DAMAGED',
    reason.message ?? 'The document could not be read.',
  );
}

/** The job file a reader takes. */
export function jobInput(job: Record<string, unknown>): SandboxInputFile {
  return {
    filename: 'job.json',
    data: Buffer.from(JSON.stringify(job), 'utf-8'),
    mimeType: 'application/json',
  };
}

/** Runs a reader's `inspect` on one file. */
async function runReader(
  script: SandboxScript,
  data: Buffer,
  sourceName: string,
  job: Record<string, unknown>,
  usage?: WorkflowUsageCollector,
): Promise<InspectedDocument> {
  const run = await runSandboxScript(
    'inspect',
    [{ filename: sourceName, data }, jobInput({ source: sourceName, ...job })],
    usage,
    script,
  );
  throwIfRefused(run.files);
  const model = run.files.get('model.json');
  if (!model) throw new DocumentRefusedError('DAMAGED', 'No model was read.');
  return {
    model: JSON.parse(strFromU8(model)) as DocumentModel,
    imageFile: (file) => run.files.get(file) ?? null,
  };
}

/** The file in a type its reader takes, converting a legacy one. */
async function readable(
  data: Buffer,
  type: string,
  context: InspectContext,
): Promise<{ data: Buffer; type: string }> {
  const conversion = CONVERSIONS[type];
  if (!conversion) return { data, type };
  const inputPath = path.join(context.workDir, `legacy.${type}`);
  await fs.promises.writeFile(inputPath, data);
  const converted = await getRenderService().convert({
    inputPath,
    type,
    convertTo: conversion.filter,
    outputDir: path.join(context.workDir, `converted-${type}`),
    lane: context.lane,
    signal: context.signal,
    onPosition: context.onQueue,
  });
  return { data: await fs.promises.readFile(converted), type: conversion.to };
}

/**
 * Reads a document into THE DOCUMENT MODEL.
 *
 * @param data - The file.
 * @param type - Its type (extension, no dot); one of INSPECTABLE_TYPES.
 * @param options.pages - 1-based pages to read; all when absent (decks
 *   and PDFs; a Word document is always read whole).
 * @param options.notes - Read a deck's speaker notes (default true).
 * @throws DocumentRefusedError when the file cannot be opened.
 * @throws Error when the type is not one inspectDocument reads.
 * @throws The render service's errors (busy, timeout) for conversions.
 */
export async function inspectDocument(
  data: Buffer,
  type: string,
  context: InspectContext,
  options: { pages?: number[]; notes?: boolean } = {},
): Promise<InspectedDocument> {
  const normalized = type.toLowerCase();
  if (!INSPECTABLE_TYPES.includes(normalized)) {
    throw new Error(`Documents of type .${normalized} cannot be read`);
  }
  const file = await readable(data, normalized, context);
  if (isPresentationType(file.type)) {
    return runReader(
      DECK_ENGINE_SCRIPT,
      file.data,
      'source.pptx',
      { pages: options.pages ?? [], notes: options.notes ?? true },
      context.usage,
    );
  }
  if (file.type === 'pdf') {
    return runReader(
      PDF_INSPECT_SCRIPT,
      file.data,
      'source.pdf',
      { pages: options.pages ?? [] },
      context.usage,
    );
  }
  // A Word document: what it declares, placed on its rendering's pages.
  const declared = await runReader(
    DOCX_INSPECT_SCRIPT,
    file.data,
    'source.docx',
    {},
    context.usage,
  );
  const docxPath = path.join(context.workDir, 'document.docx');
  await fs.promises.writeFile(docxPath, file.data);
  const pdfPath = await documentPdf(docxPath, 'docx', {
    lane: context.lane,
    workDir: context.workDir,
    signal: context.signal,
    onPosition: context.onQueue,
  });
  const rendered = await runReader(
    PDF_INSPECT_SCRIPT,
    await fs.promises.readFile(pdfPath),
    'source.pdf',
    {},
    context.usage,
  );
  return {
    model: {
      ...declared.model,
      pageCount: rendered.model.pageCount,
      pages: rendered.model.pages,
      units: placeUnits(declared.model.units, rendered.model.units),
      images: rendered.model.images,
    },
    imageFile: rendered.imageFile,
  };
}
