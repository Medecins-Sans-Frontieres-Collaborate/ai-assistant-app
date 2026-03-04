import type { DocumentComment } from '.';

/**
 * Formats a date string for display in the comments section.
 * Attempts to parse ISO date strings and format them nicely.
 *
 * @param dateStr - ISO date string or undefined
 * @returns Formatted date string, or undefined if input is invalid
 */
function formatDate(dateStr: string | undefined): string | undefined {
  if (!dateStr) {
    return undefined;
  }

  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      return undefined;
    }
    return date.toISOString().split('T')[0]; // YYYY-MM-DD format
  } catch {
    return undefined;
  }
}

/**
 * Formats an array of document comments into a human-readable section.
 *
 * The output format is designed to be easily readable by both humans and AI models:
 * ```
 * --- DOCUMENT COMMENTS ---
 * [1] Author: John Smith (2024-01-15)
 *     Location: Cell B5
 *     "This formula needs review"
 *
 * [2] Author: Jane Doe
 *     Location: Slide 3
 *     "Add more context here"
 * ```
 *
 * @param comments - Array of extracted document comments
 * @returns Formatted string containing all comments, or empty string if no comments
 */
export function formatCommentsSection(comments: DocumentComment[]): string {
  if (!comments || comments.length === 0) {
    return '';
  }

  const lines: string[] = ['--- DOCUMENT COMMENTS ---'];

  comments.forEach((comment, index) => {
    const number = index + 1;
    const formattedDate = formatDate(comment.date);
    const authorLine = formattedDate
      ? `[${number}] Author: ${comment.author} (${formattedDate})`
      : `[${number}] Author: ${comment.author}`;

    lines.push(authorLine);

    if (comment.location) {
      lines.push(`    Location: ${comment.location}`);
    }

    // Wrap comment text in quotes and indent
    const text = comment.text.trim();
    if (text) {
      lines.push(`    "${text}"`);
    }

    // Add blank line between comments
    lines.push('');
  });

  return lines.join('\n');
}
