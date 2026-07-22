import type { FetchedPage } from './urlFetchClient';
import { hostnameOf } from './urlFetchClient';

/**
 * Builds the attachment documents for a pasted link.
 *
 * A failed fetch still produces a real, uploadable document — one that says
 * what went wrong. That is deliberate: the alternative is an attachment with
 * no content, which the chat pipeline silently drops from the payload, leaving
 * the model to guess why a link it was shown contributed nothing. An explicit
 * "this could not be retrieved, and here is why" is far better input than
 * silence, and it keeps the user's send unblocked.
 *
 * Kept as pure string builders so the wording can be unit-tested without a
 * DOM, with all copy passed in by the caller that owns the translations.
 */

export interface PageDocumentCopy {
  sourceLabel: string;
  retrievedLabel: string;
}

export interface FailureDocumentCopy {
  heading: string;
  sourceLabel: string;
  attemptedLabel: string;
  /** Localized explanation of the specific failure. */
  reason: string;
  /** What the user can do instead. */
  hint: string;
}

function frontMatter(lines: string[]): string {
  return lines.filter(Boolean).join('\n');
}

export function buildPageDocument(
  page: FetchedPage,
  copy: PageDocumentCopy,
  now: Date = new Date(),
): string {
  const title =
    page.title?.trim() || hostnameOf(page.resolvedUrl) || 'Web page';
  return `${frontMatter([
    `# ${title}`,
    '',
    `${copy.sourceLabel}: ${page.resolvedUrl}`,
    `${copy.retrievedLabel}: ${now.toISOString()}`,
  ])}\n\n---\n\n${page.text.trim()}\n`;
}

export function buildFailureDocument(
  url: string,
  copy: FailureDocumentCopy,
  now: Date = new Date(),
): string {
  return `${frontMatter([
    `# ${copy.heading}`,
    '',
    `${copy.sourceLabel}: ${url}`,
    `${copy.attemptedLabel}: ${now.toISOString()}`,
  ])}\n\n---\n\n${copy.reason}\n\n${copy.hint}\n`;
}

/** Wraps generated text as a Markdown File for the upload pipeline. */
export function makeTextFile(name: string, content: string): File {
  return new File([content], name, { type: 'text/markdown' });
}

/**
 * Short deterministic suffix. The upload pipeline keys previews and progress
 * by filename, so two pages with the same title must not collide — and the
 * same URL fetched twice should produce the same name so it reads as a repeat
 * rather than a second unrelated file.
 */
export function shortHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** Filesystem-safe, readable, collision-resistant name for a fetched page. */
export function attachmentFileName(
  title: string,
  url: string,
  options: { failed?: boolean } = {},
): string {
  const base = (title.trim() || hostnameOf(url) || 'web-page')
    .replace(/[\\/:*?"<>|#]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .replace(/[-\s]+$/, '');
  const suffix = options.failed ? '-unavailable' : '';
  return `${base || 'web-page'}${suffix}-${shortHash(url)}.md`;
}
