import { Citation } from '@/types/rag';

const DEFAULT_HEADING = 'Sources';

// Escape characters that would break out of markdown link text.
function escapeLinkText(text: string): string {
  return text.replace(/([\\[\]])/g, '\\$1');
}

// Percent-encode characters that would terminate or break the markdown link
// destination. URLs are otherwise treated as opaque strings — never parsed
// with `new URL()`, which throws on malformed input.
function encodeLinkUrl(url: string): string {
  return url.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/ /g, '%20');
}

/**
 * Formats a message's citations as a markdown "Sources" section.
 *
 * Entries are numbered by 1-based array position — the same resolution the
 * chat UI uses for inline `[n]` markers — and are never deduplicated or
 * skipped, since dropping an entry would shift positions and desync the
 * exported list from the inline markers. Returns '' when there is nothing to
 * render. Never throws.
 */
export function formatCitationsAsMarkdown(
  citations: Citation[],
  heading: string = DEFAULT_HEADING,
): string {
  if (!citations || citations.length === 0) return '';

  const entries = citations.map((citation, index) => {
    const url = citation.url?.trim() ?? '';
    const label = citation.title?.trim() || url;
    const link = url
      ? `[${escapeLinkText(label)}](${encodeLinkUrl(url)})`
      : escapeLinkText(label) || '—';
    const date = citation.date?.trim() ?? '';
    return `${index + 1}. ${link}${date ? ` — ${date}` : ''}`;
  });

  return `## ${heading}\n\n${entries.join('\n')}`;
}

/**
 * Appends the formatted citations section to markdown content, separated by a
 * thematic break. Returns `content` unchanged when there are no citations.
 */
export function appendCitationsToMarkdown(
  content: string,
  citations: Citation[],
  heading: string = DEFAULT_HEADING,
): string {
  const block = formatCitationsAsMarkdown(citations, heading);
  if (!block) return content;
  return `${content.replace(/\s+$/, '')}\n\n---\n\n${block}\n`;
}
