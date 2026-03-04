import { formatCommentsSection } from '@/lib/utils/server/file/commentExtraction/formatComments';
import { DocumentComment } from '@/lib/utils/server/file/commentExtraction/types';

import { describe, expect, it } from 'vitest';

describe('formatCommentsSection', () => {
  it('should format a single comment', () => {
    const comments: DocumentComment[] = [
      {
        id: '1',
        author: 'John Smith',
        date: '2024-01-15T10:30:00Z',
        text: 'This needs review',
        location: 'Cell A1',
      },
    ];

    const result = formatCommentsSection(comments);

    expect(result).toContain('--- DOCUMENT COMMENTS ---');
    expect(result).toContain('[1] Author: John Smith (2024-01-15)');
    expect(result).toContain('Location: Cell A1');
    expect(result).toContain('"This needs review"');
  });

  it('should format multiple comments', () => {
    const comments: DocumentComment[] = [
      { id: '1', author: 'Alice', text: 'First comment' },
      { id: '2', author: 'Bob', text: 'Second comment' },
      { id: '3', author: 'Charlie', text: 'Third comment' },
    ];

    const result = formatCommentsSection(comments);

    expect(result).toContain('[1] Author: Alice');
    expect(result).toContain('[2] Author: Bob');
    expect(result).toContain('[3] Author: Charlie');
    expect(result).toContain('"First comment"');
    expect(result).toContain('"Second comment"');
    expect(result).toContain('"Third comment"');
  });

  it('should return empty string for empty array', () => {
    const result = formatCommentsSection([]);

    expect(result).toBe('');
  });

  it('should handle comment without date', () => {
    const comments: DocumentComment[] = [
      { id: '1', author: 'Jane Doe', text: 'Comment without date' },
    ];

    const result = formatCommentsSection(comments);

    expect(result).toContain('[1] Author: Jane Doe');
    expect(result).not.toContain('(');
    expect(result).not.toContain(')');
  });

  it('should handle comment without location', () => {
    const comments: DocumentComment[] = [
      { id: '1', author: 'Jane Doe', text: 'Comment without location' },
    ];

    const result = formatCommentsSection(comments);

    expect(result).not.toContain('Location:');
    expect(result).toContain('"Comment without location"');
  });

  it('should include location when provided', () => {
    const comments: DocumentComment[] = [
      { id: '1', author: 'Jane', text: 'Cell comment', location: 'Cell B5' },
      { id: '2', author: 'John', text: 'Slide comment', location: 'Slide 3' },
    ];

    const result = formatCommentsSection(comments);

    expect(result).toContain('Location: Cell B5');
    expect(result).toContain('Location: Slide 3');
  });

  it('should handle invalid date gracefully', () => {
    const comments: DocumentComment[] = [
      {
        id: '1',
        author: 'Jane',
        date: 'not-a-date',
        text: 'Invalid date comment',
      },
    ];

    const result = formatCommentsSection(comments);

    // Should not include the date if it's invalid
    expect(result).toContain('[1] Author: Jane');
    expect(result).not.toContain('not-a-date');
  });

  it('should trim whitespace from comment text', () => {
    const comments: DocumentComment[] = [
      { id: '1', author: 'Jane', text: '  Trimmed text  ' },
    ];

    const result = formatCommentsSection(comments);

    expect(result).toContain('"Trimmed text"');
    expect(result).not.toContain('"  Trimmed text  "');
  });

  it('should handle null/undefined input', () => {
    expect(formatCommentsSection(null as unknown as DocumentComment[])).toBe(
      '',
    );
    expect(
      formatCommentsSection(undefined as unknown as DocumentComment[]),
    ).toBe('');
  });

  it('should format output with correct structure', () => {
    const comments: DocumentComment[] = [
      {
        id: '1',
        author: 'Reviewer',
        date: '2024-03-01T12:00:00Z',
        text: 'Please update this section',
        location: 'Slide 5',
      },
    ];

    const result = formatCommentsSection(comments);
    const lines = result.split('\n');

    // Check structure
    expect(lines[0]).toBe('--- DOCUMENT COMMENTS ---');
    expect(lines[1]).toBe('[1] Author: Reviewer (2024-03-01)');
    expect(lines[2]).toBe('    Location: Slide 5');
    expect(lines[3]).toBe('    "Please update this section"');
  });
});
