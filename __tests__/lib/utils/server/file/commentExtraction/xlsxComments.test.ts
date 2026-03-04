import { extractXlsxComments } from '@/lib/utils/server/file/commentExtraction/xlsxComments';

import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

/**
 * Creates a minimal XLSX buffer with legacy comments for testing.
 */
async function createXlsxWithLegacyComments(
  comments: {
    ref: string;
    authorId: string;
    text: string;
  }[],
  authors: string[],
): Promise<Buffer> {
  const zip = new JSZip();

  // Create minimal required XLSX structure
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
</Types>`,
  );

  // Create comments file if there are comments
  if (comments.length > 0) {
    const authorElements = authors
      .map((a) => `<author>${a}</author>`)
      .join('\n');
    const commentElements = comments
      .map(
        (c) => `
      <comment ref="${c.ref}" authorId="${c.authorId}">
        <text><t>${c.text}</t></text>
      </comment>
    `,
      )
      .join('\n');

    zip.file(
      'xl/comments1.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <authors>
    ${authorElements}
  </authors>
  <commentList>
    ${commentElements}
  </commentList>
</comments>`,
    );
  }

  const arrayBuffer = await zip.generateAsync({ type: 'arraybuffer' });
  return Buffer.from(arrayBuffer);
}

/**
 * Creates a minimal XLSX buffer with threaded comments for testing.
 */
async function createXlsxWithThreadedComments(
  comments: {
    id: string;
    ref: string;
    personId: string;
    date?: string;
    text: string;
  }[],
  persons: { id: string; displayName: string }[],
): Promise<Buffer> {
  const zip = new JSZip();

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`,
  );

  // Create persons file
  if (persons.length > 0) {
    const personElements = persons
      .map((p) => `<person displayName="${p.displayName}" id="${p.id}"/>`)
      .join('\n');

    zip.file(
      'xl/persons/person.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
<personList xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments">
  ${personElements}
</personList>`,
    );
  }

  // Create threaded comments file
  if (comments.length > 0) {
    const commentElements = comments
      .map((c) => {
        const dateAttr = c.date ? ` dT="${c.date}"` : '';
        return `<threadedComment ref="${c.ref}" id="${c.id}" personId="${c.personId}"${dateAttr}>
        <text>${c.text}</text>
      </threadedComment>`;
      })
      .join('\n');

    zip.file(
      'xl/threadedComments1.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
<ThreadedComments xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments">
  ${commentElements}
</ThreadedComments>`,
    );
  }

  const arrayBuffer = await zip.generateAsync({ type: 'arraybuffer' });
  return Buffer.from(arrayBuffer);
}

describe('extractXlsxComments', () => {
  describe('legacy comments', () => {
    it('should extract a single legacy comment', async () => {
      const buffer = await createXlsxWithLegacyComments(
        [{ ref: 'A1', authorId: '0', text: 'Check this value' }],
        ['John Smith'],
      );

      const result = await extractXlsxComments(buffer);

      expect(result.error).toBeUndefined();
      expect(result.comments).toHaveLength(1);
      expect(result.comments[0]).toMatchObject({
        author: 'John Smith',
        text: 'Check this value',
        location: 'Cell A1',
      });
    });

    it('should extract multiple legacy comments with different authors', async () => {
      const buffer = await createXlsxWithLegacyComments(
        [
          { ref: 'A1', authorId: '0', text: 'First comment' },
          { ref: 'B5', authorId: '1', text: 'Second comment' },
          { ref: 'C10', authorId: '0', text: 'Third comment' },
        ],
        ['Alice', 'Bob'],
      );

      const result = await extractXlsxComments(buffer);

      expect(result.error).toBeUndefined();
      expect(result.comments).toHaveLength(3);
      expect(result.comments[0].author).toBe('Alice');
      expect(result.comments[0].location).toBe('Cell A1');
      expect(result.comments[1].author).toBe('Bob');
      expect(result.comments[1].location).toBe('Cell B5');
      expect(result.comments[2].author).toBe('Alice');
      expect(result.comments[2].location).toBe('Cell C10');
    });

    it('should return empty array when no comments exist', async () => {
      const buffer = await createXlsxWithLegacyComments([], []);

      const result = await extractXlsxComments(buffer);

      expect(result.error).toBeUndefined();
      expect(result.comments).toHaveLength(0);
    });
  });

  describe('threaded comments', () => {
    it('should extract a single threaded comment', async () => {
      const buffer = await createXlsxWithThreadedComments(
        [
          {
            id: 'tc1',
            ref: 'D4',
            personId: 'p1',
            date: '2024-01-20T09:00:00Z',
            text: 'Modern comment',
          },
        ],
        [{ id: 'p1', displayName: 'Jane Doe' }],
      );

      const result = await extractXlsxComments(buffer);

      expect(result.error).toBeUndefined();
      expect(result.comments).toHaveLength(1);
      expect(result.comments[0]).toMatchObject({
        id: 'tc1',
        author: 'Jane Doe',
        date: '2024-01-20T09:00:00Z',
        text: 'Modern comment',
        location: 'Cell D4',
      });
    });

    it('should handle threaded comment without date', async () => {
      const buffer = await createXlsxWithThreadedComments(
        [{ id: 'tc1', ref: 'E5', personId: 'p1', text: 'No date comment' }],
        [{ id: 'p1', displayName: 'Jane Doe' }],
      );

      const result = await extractXlsxComments(buffer);

      expect(result.error).toBeUndefined();
      expect(result.comments).toHaveLength(1);
      expect(result.comments[0].date).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('should return error for invalid buffer', async () => {
      const invalidBuffer = Buffer.from('not a valid zip file');

      const result = await extractXlsxComments(invalidBuffer);

      expect(result.error).toBeDefined();
      expect(result.comments).toHaveLength(0);
    });

    it('should handle unknown author gracefully', async () => {
      const buffer = await createXlsxWithLegacyComments(
        [{ ref: 'A1', authorId: '99', text: 'Unknown author comment' }],
        ['Known Author'],
      );

      const result = await extractXlsxComments(buffer);

      expect(result.error).toBeUndefined();
      expect(result.comments).toHaveLength(1);
      expect(result.comments[0].author).toBe('Unknown');
    });
  });
});
