import {
  SUPPORTED_COMMENT_MIME_TYPES,
  extractAndFormatComments,
  extractComments,
  supportsCommentExtraction,
} from '@/lib/utils/server/file/commentExtraction';

import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

/**
 * Creates a minimal DOCX buffer with comments for testing.
 */
async function createDocxWithComments(
  comments: {
    id: string;
    author: string;
    text: string;
  }[],
): Promise<Buffer> {
  const zip = new JSZip();

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`,
  );

  if (comments.length > 0) {
    const commentElements = comments
      .map(
        (c) =>
          `<w:comment w:id="${c.id}" w:author="${c.author}">
        <w:p><w:r><w:t>${c.text}</w:t></w:r></w:p>
      </w:comment>`,
      )
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

/**
 * Creates a minimal XLSX buffer with legacy comments.
 */
async function createXlsxWithComments(): Promise<Buffer> {
  const zip = new JSZip();

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`,
  );

  zip.file(
    'xl/comments1.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <authors><author>Excel User</author></authors>
  <commentList>
    <comment ref="A1" authorId="0"><text><t>Excel comment</t></text></comment>
  </commentList>
</comments>`,
  );

  const arrayBuffer = await zip.generateAsync({ type: 'arraybuffer' });
  return Buffer.from(arrayBuffer);
}

/**
 * Creates a minimal PPTX buffer with comments.
 */
async function createPptxWithComments(): Promise<Buffer> {
  const zip = new JSZip();

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`,
  );

  zip.file(
    'ppt/commentAuthors.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<p:cmAuthorLst xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cmAuthor id="1" name="Presenter"/>
</p:cmAuthorLst>`,
  );

  zip.file(
    'ppt/comments/comment1.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<p:cmLst xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cm authorId="1" idx="1"><p:text>PowerPoint comment</p:text></p:cm>
</p:cmLst>`,
  );

  const arrayBuffer = await zip.generateAsync({ type: 'arraybuffer' });
  return Buffer.from(arrayBuffer);
}

describe('supportsCommentExtraction', () => {
  it('should return true for DOCX mime type', () => {
    expect(supportsCommentExtraction(SUPPORTED_COMMENT_MIME_TYPES.DOCX)).toBe(
      true,
    );
  });

  it('should return true for XLSX mime type', () => {
    expect(supportsCommentExtraction(SUPPORTED_COMMENT_MIME_TYPES.XLSX)).toBe(
      true,
    );
  });

  it('should return true for PPTX mime type', () => {
    expect(supportsCommentExtraction(SUPPORTED_COMMENT_MIME_TYPES.PPTX)).toBe(
      true,
    );
  });

  it('should return false for PDF', () => {
    expect(supportsCommentExtraction('application/pdf')).toBe(false);
  });

  it('should return false for plain text', () => {
    expect(supportsCommentExtraction('text/plain')).toBe(false);
  });

  it('should return false for old Office formats', () => {
    expect(supportsCommentExtraction('application/msword')).toBe(false);
    expect(supportsCommentExtraction('application/vnd.ms-excel')).toBe(false);
    expect(supportsCommentExtraction('application/vnd.ms-powerpoint')).toBe(
      false,
    );
  });
});

describe('extractComments', () => {
  it('should extract comments from DOCX', async () => {
    const buffer = await createDocxWithComments([
      { id: '1', author: 'Test Author', text: 'Test comment' },
    ]);

    const result = await extractComments(
      buffer,
      SUPPORTED_COMMENT_MIME_TYPES.DOCX,
    );

    expect(result.error).toBeUndefined();
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].text).toBe('Test comment');
  });

  it('should extract comments from XLSX', async () => {
    const buffer = await createXlsxWithComments();

    const result = await extractComments(
      buffer,
      SUPPORTED_COMMENT_MIME_TYPES.XLSX,
    );

    expect(result.error).toBeUndefined();
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].text).toBe('Excel comment');
    expect(result.comments[0].location).toBe('Cell A1');
  });

  it('should extract comments from PPTX', async () => {
    const buffer = await createPptxWithComments();

    const result = await extractComments(
      buffer,
      SUPPORTED_COMMENT_MIME_TYPES.PPTX,
    );

    expect(result.error).toBeUndefined();
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].text).toBe('PowerPoint comment');
    expect(result.comments[0].location).toBe('Slide 1');
  });

  it('should return empty array for unsupported mime types', async () => {
    const buffer = Buffer.from('some content');

    const result = await extractComments(buffer, 'text/plain');

    expect(result.error).toBeUndefined();
    expect(result.comments).toHaveLength(0);
  });

  it('should return empty array for documents without comments', async () => {
    const buffer = await createDocxWithComments([]);

    const result = await extractComments(
      buffer,
      SUPPORTED_COMMENT_MIME_TYPES.DOCX,
    );

    expect(result.error).toBeUndefined();
    expect(result.comments).toHaveLength(0);
  });
});

describe('extractAndFormatComments', () => {
  it('should extract and format DOCX comments', async () => {
    const buffer = await createDocxWithComments([
      { id: '1', author: 'Reviewer', text: 'Please fix this' },
    ]);

    const result = await extractAndFormatComments(
      buffer,
      SUPPORTED_COMMENT_MIME_TYPES.DOCX,
    );

    expect(result).toContain('--- DOCUMENT COMMENTS ---');
    expect(result).toContain('Author: Reviewer');
    expect(result).toContain('"Please fix this"');
  });

  it('should return empty string for documents without comments', async () => {
    const buffer = await createDocxWithComments([]);

    const result = await extractAndFormatComments(
      buffer,
      SUPPORTED_COMMENT_MIME_TYPES.DOCX,
    );

    expect(result).toBe('');
  });

  it('should return empty string for unsupported mime types', async () => {
    const buffer = Buffer.from('some content');

    const result = await extractAndFormatComments(buffer, 'text/plain');

    expect(result).toBe('');
  });

  it('should format multiple comments from different formats', async () => {
    // Test XLSX
    const xlsxBuffer = await createXlsxWithComments();
    const xlsxResult = await extractAndFormatComments(
      xlsxBuffer,
      SUPPORTED_COMMENT_MIME_TYPES.XLSX,
    );

    expect(xlsxResult).toContain('--- DOCUMENT COMMENTS ---');
    expect(xlsxResult).toContain('Cell A1');

    // Test PPTX
    const pptxBuffer = await createPptxWithComments();
    const pptxResult = await extractAndFormatComments(
      pptxBuffer,
      SUPPORTED_COMMENT_MIME_TYPES.PPTX,
    );

    expect(pptxResult).toContain('--- DOCUMENT COMMENTS ---');
    expect(pptxResult).toContain('Slide 1');
  });
});
