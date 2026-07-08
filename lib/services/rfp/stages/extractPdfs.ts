/**
 * Stage 1: PDF → plain text per document, via the `pdftotext` CLI (poppler).
 *
 * poppler-utils is already installed in the production Docker image, so this
 * stage needs no new dependencies or credentials. Page breaks (form feeds)
 * are converted to the same "===== PAGE N =====" markers the extraction
 * prompts rely on.
 */
import { execFile } from 'child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Materialise a local source file at dest. Sources are always paths the
 * generate route wrote itself (remote/blob inputs are intentionally not
 * supported — smaller attack surface; add deliberately if ever needed).
 */
export async function fetchSource(
  source: string,
  dest: string,
): Promise<string> {
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  copyFileSync(source, dest);
  return dest;
}

const PAGE_FOOTER_RE = /^\s*page\s+\d+\s+(of|\/)\s+\d+\s*$/i;
// Bullet glyphs rendered as their own text column: pdftotext emits them as
// consecutive lines containing only the glyph, divorced from their item text.
// The item texts keep their own lines, so dropping the orphan glyphs loses
// nothing but noise.
const LONE_BULLET_RE = /^\s*[•§▪◦‣●·]\s*$/;

/**
 * Remove repeating page furniture (footers like "Page 33 of 85" and headers
 * repeated on most pages). pdftotext emits footers directly before each page
 * break, which reads like "end of section" to the extraction model and causes
 * answers to truncate at page boundaries. Content-agnostic: a short line
 * recurring on ≥60% of pages is furniture by definition.
 */
function stripPageFurniture(pages: string[]): string[] {
  const pageLines = pages.map((p) => p.split('\n'));
  const counts = new Map<string, number>();
  for (const lines of pageLines) {
    const seen = new Set<string>();
    for (const l of lines) {
      const t = l.trim();
      if (!t || t.length > 80 || seen.has(t)) continue;
      seen.add(t);
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  const threshold = Math.max(3, Math.ceil(pages.length * 0.6));
  const furniture = new Set(
    [...counts.entries()].filter(([, n]) => n >= threshold).map(([t]) => t),
  );
  return pageLines.map((lines) =>
    lines
      .filter((l) => {
        const t = l.trim();
        if (PAGE_FOOTER_RE.test(t)) return false;
        if (LONE_BULLET_RE.test(l)) return false;
        if (pages.length >= 4 && furniture.has(t)) return false;
        return true;
      })
      .join('\n'),
  );
}

/**
 * @param layout preserve tabular layout (`pdftotext -layout`). Use for
 * table-heavy documents like criteria grids, where reading-order mode
 * dissociates row labels from their values. Prose documents (vendor
 * responses, questionnaires) extract better in default reading-order mode.
 */
export async function extractPdfText(
  pdfPath: string,
  layout = false,
): Promise<string> {
  const args = layout ? ['-layout', pdfPath, '-'] : [pdfPath, '-'];
  const { stdout } = await execFileAsync('pdftotext', args, {
    maxBuffer: 64 * 1024 * 1024,
  });
  const pages = stripPageFurniture(stdout.split('\f'));
  return pages
    .map((text, i) => `\n\n===== PAGE ${i + 1} =====\n${text}`)
    .join('');
}

export function safeVendorStem(vendor: string): string {
  return vendor.replace(/[^a-zA-Z0-9]/g, '_');
}

export async function run(params: {
  questionnairePdf: string;
  vendorPdfs: Record<string, string>;
  outDir: string;
}): Promise<Record<string, string>> {
  const { questionnairePdf, vendorPdfs, outDir } = params;
  mkdirSync(outDir, { recursive: true, mode: 0o700 });

  const qText = await extractPdfText(questionnairePdf);
  writeFileSync(join(outDir, 'questionnaire.txt'), qText);
  console.log(`  questionnaire: ${qText.length.toLocaleString()} chars`);

  const textPaths: Record<string, string> = {};
  for (const [vendor, pdf] of Object.entries(vendorPdfs)) {
    const out = join(outDir, `${safeVendorStem(vendor)}.txt`);
    const text = await extractPdfText(pdf);
    writeFileSync(out, text);
    textPaths[vendor] = out;
    console.log(`  ${vendor}: ${text.length.toLocaleString()} chars`);
  }
  return textPaths;
}
