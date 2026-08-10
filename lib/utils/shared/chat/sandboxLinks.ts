import type { GeneratedFileRef } from '@/lib/streamMarkers';

/**
 * The code-interpreter model refers to files it wrote with links into its
 * own container filesystem — `[Download the report](sandbox:/mnt/data/report.xlsx)`.
 * Browsers can never resolve the `sandbox:` scheme, and the markdown
 * renderer's link hardening strips the href and shows a grey "…[blocked]"
 * span instead, which users read as the download being blocked. These
 * references must never reach the renderer.
 *
 * Inline `[label](sandbox:…)` links (optional `<…>` target wrapper and
 * link title), `![alt](sandbox:…)` images, and `<sandbox:…>` autolinks.
 */
const SANDBOX_LINK_RE =
  /(!?)\[([^\]]*)\]\(\s*<?(sandbox:[^)\s>]*)>?(?:\s+"[^"]*")?\s*\)|<(sandbox:[^>\s]+)>/g;

function filenameFromSandboxUrl(url: string): string {
  const path = url.replace(/^sandbox:/, '');
  const last = path.split('/').filter(Boolean).pop() ?? '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * Replaces every sandbox link in `content`:
 *  - anchor links whose filename matches a generated file are re-pointed at
 *    the file's real app URL (`/api/file/<sha256>.<ext>`),
 *  - unmatched anchor links degrade to their plain label text,
 *  - image references are dropped (the generated-files panel renders the
 *    real preview; a `sandbox:` src can never load),
 *  - autolinks degrade to the bare filename.
 *
 * With no `files` (the server-side strip, where persisted URLs aren't in
 * scope) everything degrades: labels survive, links don't.
 */
export function rewriteSandboxLinks(
  content: string,
  files: readonly GeneratedFileRef[] = [],
): string {
  if (!content.includes('sandbox:')) return content;

  const byFilename = new Map<string, GeneratedFileRef>();
  for (const file of files) {
    byFilename.set(file.filename.toLowerCase(), file);
  }

  return content.replace(
    SANDBOX_LINK_RE,
    (_match, bang: string, label: string, url: string, autolinkUrl: string) => {
      if (autolinkUrl) {
        return filenameFromSandboxUrl(autolinkUrl);
      }
      if (bang === '!') {
        return '';
      }
      const filename = filenameFromSandboxUrl(url);
      const file = byFilename.get(filename.toLowerCase());
      // Images resolve through the base64 endpoint, not their file URL, so
      // only non-image files can be re-linked directly.
      if (file && !file.is_image) {
        return `[${label}](${file.url})`;
      }
      return label;
    },
  );
}
