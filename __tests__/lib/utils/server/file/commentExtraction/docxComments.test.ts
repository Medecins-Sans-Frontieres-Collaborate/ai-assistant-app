import { extractDocxComments } from '@/lib/utils/server/file/commentExtraction/docxComments';

import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

/**
 * Creates a minimal DOCX buffer with comments for testing.
 */
async function createDocxWithComments(
  comments: {
    id: string;
    author: string;
    date?: string;
    text: string;
  }[],
): Promise<Buffer> {
  const zip = new JSZip();

  // Create minimal required DOCX structure
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
</Types>`,
  );

  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );

  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Test document</w:t></w:r></w:p>
  </w:body>
</w:document>`,
  );

  // Create comments.xml with the provided comments
  if (comments.length > 0) {
    const commentElements = comments
      .map((c) => {
        const dateAttr = c.date ? ` w:date="${c.date}"` : '';
        return `<w:comment w:id="${c.id}" w:author="${c.author}"${dateAttr}>
        <w:p><w:r><w:t>${c.text}</w:t></w:r></w:p>
      </w:comment>`;
      })
      .join('\n');

    zip.file(
      'word/comments.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  ${commentElements}
</w:comments>`,
    );
  }

  const arrayBuffer = await zip.generateAsync({ type: 'arraybuffer' });
  return Buffer.from(arrayBuffer);
}

describe('extractDocxComments', () => {
  it('should extract a single comment', async () => {
    const buffer = await createDocxWithComments([
      {
        id: '1',
        author: 'John Smith',
        date: '2024-01-15T10:30:00Z',
        text: 'This needs review',
      },
    ]);

    const result = await extractDocxComments(buffer);

    expect(result.error).toBeUndefined();
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]).toEqual({
      id: '1',
      author: 'John Smith',
      date: '2024-01-15T10:30:00Z',
      text: 'This needs review',
    });
  });

  it('should extract multiple comments', async () => {
    const buffer = await createDocxWithComments([
      { id: '1', author: 'John Smith', text: 'First comment' },
      {
        id: '2',
        author: 'Jane Doe',
        date: '2024-01-16T14:00:00Z',
        text: 'Second comment',
      },
      { id: '3', author: 'Bob Wilson', text: 'Third comment' },
    ]);

    const result = await extractDocxComments(buffer);

    expect(result.error).toBeUndefined();
    expect(result.comments).toHaveLength(3);
    expect(result.comments[0].author).toBe('John Smith');
    expect(result.comments[1].author).toBe('Jane Doe');
    expect(result.comments[2].author).toBe('Bob Wilson');
  });

  it('should return empty array when no comments.xml exists', async () => {
    const buffer = await createDocxWithComments([]);

    const result = await extractDocxComments(buffer);

    expect(result.error).toBeUndefined();
    expect(result.comments).toHaveLength(0);
  });

  it('should handle comment without date', async () => {
    const buffer = await createDocxWithComments([
      { id: '1', author: 'John Smith', text: 'Comment without date' },
    ]);

    const result = await extractDocxComments(buffer);

    expect(result.error).toBeUndefined();
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].date).toBeUndefined();
    expect(result.comments[0].text).toBe('Comment without date');
  });

  it('should return error for invalid buffer', async () => {
    const invalidBuffer = Buffer.from('not a valid zip file');

    const result = await extractDocxComments(invalidBuffer);

    expect(result.error).toBeDefined();
    expect(result.comments).toHaveLength(0);
  });

  it('should handle empty comments.xml', async () => {
    const zip = new JSZip();
    zip.file(
      'word/comments.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
</w:comments>`,
    );

    const arrayBuffer = await zip.generateAsync({ type: 'arraybuffer' });
    const buffer = Buffer.from(arrayBuffer);

    const result = await extractDocxComments(buffer);

    expect(result.error).toBeUndefined();
    expect(result.comments).toHaveLength(0);
  });

  it('should handle comments with special characters', async () => {
    const buffer = await createDocxWithComments([
      {
        id: '1',
        author: 'John & Jane',
        text: 'Comment with <special> "characters"',
      },
    ]);

    const result = await extractDocxComments(buffer);

    expect(result.error).toBeUndefined();
    expect(result.comments).toHaveLength(1);
    // Note: XML entities will be decoded by the parser
    expect(result.comments[0].author).toBe('John & Jane');
  });

  it('should preserve paragraph boundaries in multi-paragraph comments', async () => {
    // Create a DOCX with a comment that has multiple paragraphs
    const zip = new JSZip();

    zip.file(
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
</Types>`,
    );

    zip.file(
      '_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    );

    zip.file(
      'word/document.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Test document</w:t></w:r></w:p>
  </w:body>
</w:document>`,
    );

    // Create a comment with multiple paragraphs
    zip.file(
      'word/comments.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="1" w:author="Reviewer" w:date="2024-01-15T10:30:00Z">
    <w:p><w:r><w:t>First paragraph of the comment.</w:t></w:r></w:p>
    <w:p><w:r><w:t>Second paragraph with more details.</w:t></w:r></w:p>
    <w:p><w:r><w:t>Third paragraph conclusion.</w:t></w:r></w:p>
  </w:comment>
</w:comments>`,
    );

    const arrayBuffer = await zip.generateAsync({ type: 'arraybuffer' });
    const buffer = Buffer.from(arrayBuffer);

    const result = await extractDocxComments(buffer);

    expect(result.error).toBeUndefined();
    expect(result.comments).toHaveLength(1);
    // Paragraphs should be joined with newlines
    expect(result.comments[0].text).toBe(
      'First paragraph of the comment.\nSecond paragraph with more details.\nThird paragraph conclusion.',
    );
  });
});
