import { extractPptxComments } from '@/lib/utils/server/file/commentExtraction/pptxComments';

import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

/**
 * Creates a minimal PPTX buffer with comments for testing.
 */
async function createPptxWithComments(
  authors: { id: string; name: string }[],
  comments: {
    slideNumber: number;
    authorId: string;
    idx?: string;
    date?: string;
    text: string;
  }[],
): Promise<Buffer> {
  const zip = new JSZip();

  // Create minimal required PPTX structure
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
</Types>`,
  );

  // Create comment authors file
  if (authors.length > 0) {
    const authorElements = authors
      .map((a) => `<p:cmAuthor id="${a.id}" name="${a.name}"/>`)
      .join('\n');

    zip.file(
      'ppt/commentAuthors.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
<p:cmAuthorLst xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  ${authorElements}
</p:cmAuthorLst>`,
    );
  }

  // Group comments by slide number and create comment files
  const commentsBySlide = new Map<number, typeof comments>();
  for (const comment of comments) {
    const existing = commentsBySlide.get(comment.slideNumber) || [];
    existing.push(comment);
    commentsBySlide.set(comment.slideNumber, existing);
  }

  for (const [slideNumber, slideComments] of commentsBySlide) {
    const commentElements = slideComments
      .map((c) => {
        const idxAttr = c.idx ? ` idx="${c.idx}"` : '';
        const dateAttr = c.date ? ` dt="${c.date}"` : '';
        return `<p:cm authorId="${c.authorId}"${idxAttr}${dateAttr}>
        <p:text>${c.text}</p:text>
      </p:cm>`;
      })
      .join('\n');

    zip.file(
      `ppt/comments/comment${slideNumber}.xml`,
      `<?xml version="1.0" encoding="UTF-8"?>
<p:cmLst xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  ${commentElements}
</p:cmLst>`,
    );
  }

  const arrayBuffer = await zip.generateAsync({ type: 'arraybuffer' });
  return Buffer.from(arrayBuffer);
}

describe('extractPptxComments', () => {
  it('should extract a single comment from one slide', async () => {
    const buffer = await createPptxWithComments(
      [{ id: '1', name: 'Presenter A' }],
      [
        {
          slideNumber: 1,
          authorId: '1',
          idx: '1',
          date: '2024-02-10T15:00:00Z',
          text: 'Add more details here',
        },
      ],
    );

    const result = await extractPptxComments(buffer);

    expect(result.error).toBeUndefined();
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]).toMatchObject({
      id: '1',
      author: 'Presenter A',
      date: '2024-02-10T15:00:00Z',
      text: 'Add more details here',
      location: 'Slide 1',
    });
  });

  it('should extract comments from multiple slides', async () => {
    const buffer = await createPptxWithComments(
      [
        { id: '1', name: 'Alice' },
        { id: '2', name: 'Bob' },
      ],
      [
        { slideNumber: 1, authorId: '1', idx: '1', text: 'Slide 1 comment' },
        { slideNumber: 2, authorId: '2', idx: '1', text: 'Slide 2 comment' },
        { slideNumber: 3, authorId: '1', idx: '1', text: 'Slide 3 comment' },
      ],
    );

    const result = await extractPptxComments(buffer);

    expect(result.error).toBeUndefined();
    expect(result.comments).toHaveLength(3);

    // Verify we got comments from different slides
    const locations = result.comments.map((c) => c.location);
    expect(locations).toContain('Slide 1');
    expect(locations).toContain('Slide 2');
    expect(locations).toContain('Slide 3');
  });

  it('should extract multiple comments from the same slide', async () => {
    const buffer = await createPptxWithComments(
      [{ id: '1', name: 'Reviewer' }],
      [
        { slideNumber: 1, authorId: '1', idx: '1', text: 'First comment' },
        { slideNumber: 1, authorId: '1', idx: '2', text: 'Second comment' },
      ],
    );

    const result = await extractPptxComments(buffer);

    expect(result.error).toBeUndefined();
    expect(result.comments).toHaveLength(2);
    expect(result.comments.every((c) => c.location === 'Slide 1')).toBe(true);
  });

  it('should return empty array when no comments exist', async () => {
    const buffer = await createPptxWithComments([], []);

    const result = await extractPptxComments(buffer);

    expect(result.error).toBeUndefined();
    expect(result.comments).toHaveLength(0);
  });

  it('should handle comment without date', async () => {
    const buffer = await createPptxWithComments(
      [{ id: '1', name: 'Author' }],
      [{ slideNumber: 1, authorId: '1', text: 'Comment without date' }],
    );

    const result = await extractPptxComments(buffer);

    expect(result.error).toBeUndefined();
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].date).toBeUndefined();
  });

  it('should handle unknown author gracefully', async () => {
    const buffer = await createPptxWithComments(
      [{ id: '1', name: 'Known Author' }],
      [{ slideNumber: 1, authorId: '99', text: 'Comment from unknown' }],
    );

    const result = await extractPptxComments(buffer);

    expect(result.error).toBeUndefined();
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].author).toBe('Unknown');
  });

  it('should return error for invalid buffer', async () => {
    const invalidBuffer = Buffer.from('not a valid zip file');

    const result = await extractPptxComments(invalidBuffer);

    expect(result.error).toBeDefined();
    expect(result.comments).toHaveLength(0);
  });

  it('should handle presentation without commentAuthors.xml', async () => {
    const zip = new JSZip();
    zip.file(
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`,
    );

    // Create comment file without authors file
    zip.file(
      'ppt/comments/comment1.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
<p:cmLst xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cm authorId="1"><p:text>Orphan comment</p:text></p:cm>
</p:cmLst>`,
    );

    const arrayBuffer = await zip.generateAsync({ type: 'arraybuffer' });
    const buffer = Buffer.from(arrayBuffer);

    const result = await extractPptxComments(buffer);

    expect(result.error).toBeUndefined();
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].author).toBe('Unknown');
  });
});
