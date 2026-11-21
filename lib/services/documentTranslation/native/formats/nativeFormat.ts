/**
 * THE FORMAT ADAPTER: the only part of Preserve formatting that knows what
 * kind of file it is translating.
 *
 * The pipeline (nativePdfPipeline.ts) reads, classifies, translates, checks
 * and refits UNITS on numbered PAGES. Everything that touches the file
 * itself goes through an adapter:
 *
 *   extract   the source's units for the chosen pages, and a labelled
 *             image of each page for the analyze step
 *   rebuild   the source with the translations laid in, as a PDF (what the
 *             review and the check look at), page images, and for formats
 *             that are not PDF, the translated file in its own format
 *
 * A page is a PDF page, or a slide in presentation order with hidden
 * slides counted (THE SLIDE NUMBER CONVENTION in deckText.ts). Every
 * rebuild starts from the original file, so rounds never compound.
 */
import { WorkflowUsageCollector } from '@/lib/services/workflows/shared/workflowUsage';

import { NativeSourceFormat } from '@/lib/utils/shared/translation/nativeFormats';
import {
  NativePdfExportFormat,
  NativePdfFitReport,
  NativePdfUnitStyle,
} from '@/lib/utils/shared/translation/nativePdf';

/** One page of a rebuild, as images. */
export interface NativePdfPageOutput {
  page: number;
  /** PNG of the translated page. */
  preview: Uint8Array;
  /** PNG of the original beside the translated page, units numbered. */
  check: Uint8Array;
}

/** What an extraction gives the pipeline. */
export interface FormatExtraction {
  /** The extraction (units.json): `pageCount`, `pages`, `units`. */
  unitsFile: Uint8Array;
  /**
   * The labelled image of an extracted page: the page with each unit's
   * box and number drawn on it. Null when the page could not be pictured
   * (a presentation whose slides could not be rendered): it is then read
   * from its text alone.
   *
   * @throws Error when the page was not extracted.
   */
  pageImage(page: number): Uint8Array | null;
}

/** What to make besides the translated pages. */
export interface RebuildOutput {
  /** Pages to return images of; absent means every translated page. */
  imagePages?: number[];
  /** Source pages to leave out of the result. */
  omitPages?: number[];
  /** Unit id to the person's style for it, already sanitized. */
  styles?: Record<string, NativePdfUnitStyle>;
  /** The target language's tag, already sanitized; '' or absent for none. */
  language?: string;
  /** Editable formats to build beside the PDF (PDF sources only). */
  exports?: NativePdfExportFormat[];
}

/** What a rebuild made. */
export interface RebuildOutcome {
  fits: NativePdfFitReport[];
  fonts: { sans: string; serif: string };
  /**
   * The translated pages as a PDF; null when a presentation could not be
   * rendered (the deck is still delivered, see `unpictured`).
   */
  pdf: Uint8Array | null;
  /** Pages that could not be pictured, so the check could not look at them. */
  unpictured?: number[];
  /** The editable files asked for (see EDITABLE DOWNLOADS in nativePdf.ts). */
  exports: Partial<Record<NativePdfExportFormat, Uint8Array>>;
  /**
   * The translated file in the source's own format, for sources that are
   * not PDF (a presentation comes back as a presentation).
   */
  document?: Uint8Array;
  outputs: NativePdfPageOutput[];
}

/** Things every adapter call may be given. */
export interface FormatCallContext {
  usage: WorkflowUsageCollector;
  /** Stops waiting for, or running, the call's work. */
  signal?: AbortSignal;
  /** Told how many jobs are ahead while work waits for a render slot. */
  onQueue?: (ahead: number) => void;
}

/** One source format's extract and rebuild (see THE FORMAT ADAPTER). */
export interface NativeFormatAdapter {
  readonly format: NativeSourceFormat;
  /**
   * Reads the units of the given pages.
   *
   * @param document - The source file.
   * @param pages - 1-based pages to read.
   * @param options - Whether speaker notes are read (presentations only).
   * @throws Error when the source cannot be read.
   */
  extract(
    document: Buffer,
    pages: number[],
    context: FormatCallContext & { translateNotes?: boolean },
  ): Promise<FormatExtraction>;
  /**
   * Lays translations into the original file.
   *
   * @param document - The source file.
   * @param unitsFile - The extraction the translations belong to.
   * @param translations - Unit id to its translation; others stay as written.
   * @param output - What to make besides the translated pages.
   */
  rebuild(
    document: Buffer,
    unitsFile: Uint8Array,
    translations: Map<string, string>,
    output: RebuildOutput,
    context: FormatCallContext,
  ): Promise<RebuildOutcome>;
}

/** Reads one file of a sandbox command's output. */
export function requireFile(
  files: Map<string, Uint8Array>,
  name: string,
): Uint8Array {
  const bytes = files.get(name);
  if (!bytes) throw new Error(`The sandbox output is missing ${name}`);
  return bytes;
}
