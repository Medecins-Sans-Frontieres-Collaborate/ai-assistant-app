/**
 * The PDF adapter (see THE FORMAT ADAPTER): both steps are commands of the
 * fixed PDF script in the sandbox (pdfNativeScript.ts).
 */
import {
  SandboxInputFile,
  runSandboxScript,
} from '@/lib/services/documents/sandbox/sandboxScriptRunner';

import { NativePdfFitReport } from '@/lib/utils/shared/translation/nativePdf';

import { PDF_SANDBOX_SCRIPT } from '../pdfNativeScript';
import {
  FormatExtraction,
  NativeFormatAdapter,
  RebuildOutcome,
  requireFile,
} from './nativeFormat';

import { strFromU8 } from 'fflate';

const SOURCE_FILENAME = 'source.pdf';
const UNITS_FILENAME = 'units.json';

/** The job file a script command reads its settings from. */
export function jobFile(job: Record<string, unknown>): SandboxInputFile {
  return {
    filename: 'job.json',
    data: Buffer.from(JSON.stringify(job), 'utf-8'),
    mimeType: 'application/json',
  };
}

export const pdfFormat: NativeFormatAdapter = {
  format: 'pdf',

  async extract(document, pages, { usage }): Promise<FormatExtraction> {
    const run = await runSandboxScript(
      'extract',
      [
        {
          filename: SOURCE_FILENAME,
          data: document,
          mimeType: 'application/pdf',
        },
        jobFile({ source: SOURCE_FILENAME, pages }),
      ],
      usage,
      PDF_SANDBOX_SCRIPT,
    );
    return {
      unitsFile: requireFile(run.files, UNITS_FILENAME),
      pageImage: (page) => requireFile(run.files, `page_${page}.png`),
    };
  },

  async rebuild(
    document,
    unitsFile,
    translations,
    output,
    { usage },
  ): Promise<RebuildOutcome> {
    const { imagePages, omitPages, styles, language, exports = [] } = output;
    const run = await runSandboxScript(
      'rebuild',
      [
        {
          filename: SOURCE_FILENAME,
          data: document,
          mimeType: 'application/pdf',
        },
        {
          filename: UNITS_FILENAME,
          data: Buffer.from(unitsFile),
          mimeType: 'application/json',
        },
        jobFile({
          source: SOURCE_FILENAME,
          units: UNITS_FILENAME,
          translations: Object.fromEntries(translations),
          // The result is the whole document with the translated pages
          // replaced, so batches add up to one file.
          onlyTranslatedPages: false,
          ...(imagePages ? { imagePages } : {}),
          ...(omitPages?.length ? { omitPages } : {}),
          ...(styles && Object.keys(styles).length > 0 ? { styles } : {}),
          // Words too long for their line are hyphenated by this language's rules.
          ...(language ? { language } : {}),
          // SLIDES in the script: the result as a presentation as well.
          ...(exports.includes('pptx') ? { slides: true } : {}),
        }),
      ],
      usage,
      PDF_SANDBOX_SCRIPT,
    );
    const report = JSON.parse(
      strFromU8(requireFile(run.files, 'report.json')),
    ) as {
      fonts: { sans: string; serif: string };
      units: NativePdfFitReport[];
    };
    const pages = [...new Set(report.units.map((unit) => unit.page))]
      .filter((page) => !imagePages || imagePages.includes(page))
      .sort((a, b) => a - b);
    return {
      fits: report.units,
      fonts: report.fonts,
      pdf: requireFile(run.files, 'translated.pdf'),
      exports: exports.includes('pptx')
        ? { pptx: requireFile(run.files, 'translated.pptx') }
        : {},
      outputs: pages.map((page) => ({
        page,
        preview: requireFile(run.files, `preview_${page}.png`),
        check: requireFile(run.files, `check_${page}.png`),
      })),
    };
  },
};
