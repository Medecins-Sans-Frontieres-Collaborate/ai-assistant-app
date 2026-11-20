import { Session } from 'next-auth';

import {
  UnknownDocumentSourceError,
  readDocumentSource,
  storeUploadedFile,
  storedUploadBytes,
} from '@/lib/services/documents/sources/documentSources';

import { createHash } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Reading a person's uploads, and keeping files made for them as uploads. */

const blobs = vi.hoisted(() => new Map<string, Buffer>());
const uploads = vi.hoisted(
  () => [] as Array<{ name: string; contentType: string }>,
);

vi.mock('@/lib/services/blobStorageFactory', () => ({
  createBlobStorageClient: () => ({
    get: async (name: string) => {
      if (name.includes('broken')) throw new Error('store down');
      const found = blobs.get(name);
      if (!found) {
        throw Object.assign(new Error('missing'), {
          statusCode: 404,
          code: 'BlobNotFound',
        });
      }
      return found;
    },
    upload: async (
      name: string,
      data: Buffer,
      options: { blobHTTPHeaders: { blobContentType: string } },
    ) => {
      blobs.set(name, data);
      uploads.push({
        name,
        contentType: options.blobHTTPHeaders.blobContentType,
      });
      return name;
    },
  }),
}));
vi.mock('@/lib/utils/app/user/session', () => ({
  getUserIdFromSession: (session: Session) => session.user?.id,
}));

const SESSION = { user: { id: 'u1' } } as Session;
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const PDF = Buffer.from('%PDF-1.7 a document');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);

describe('the upload source', () => {
  beforeEach(() => {
    blobs.clear();
    uploads.length = 0;
    blobs.set(`u1/uploads/files/${sha(PDF)}.pdf`, PDF);
    blobs.set(
      `u1/uploads/files/${sha(PNG)}.png`,
      Buffer.from(`data:image/png;base64,${PNG.toString('base64')}`),
    );
  });

  it('reads the person’s own upload by its id and type', async () => {
    const file = await readDocumentSource(SESSION, {
      kind: 'upload',
      id: `${sha(PDF)}.pdf`,
      type: 'pdf',
    });
    expect(file?.data.equals(PDF)).toBe(true);
    expect(file?.type).toBe('pdf');
  });

  it('gives an image’s bytes, not the data URL it is stored as', async () => {
    const file = await readDocumentSource(SESSION, {
      kind: 'upload',
      id: `${sha(PNG)}.png`,
      type: 'png',
    });
    expect(file?.data.equals(PNG)).toBe(true);
  });

  it('answers null for a missing file, another type, or another person', async () => {
    const read = (id: string, type: string, session = SESSION) =>
      readDocumentSource(session, { kind: 'upload', id, type });
    expect(await read(`${'b'.repeat(64)}.pdf`, 'pdf')).toBeNull();
    expect(await read(`${sha(PDF)}.pdf`, 'docx')).toBeNull();
    expect(await read('../secret.pdf', 'pdf')).toBeNull();
    expect(
      await read(`${sha(PDF)}.pdf`, 'pdf', { user: { id: 'u2' } } as Session),
    ).toBeNull();
  });

  it('lets a store failure through, and refuses an unknown kind', async () => {
    blobs.set('x', Buffer.alloc(0));
    await expect(
      readDocumentSource({ user: { id: 'broken' } } as Session, {
        kind: 'upload',
        id: `${sha(PDF)}.pdf`,
        type: 'pdf',
      }),
    ).rejects.toThrow('store down');
    await expect(
      readDocumentSource(SESSION, { kind: 'nowhere', id: 'x', type: 'pdf' }),
    ).rejects.toBeInstanceOf(UnknownDocumentSourceError);
  });
});

describe('storeUploadedFile', () => {
  beforeEach(() => {
    blobs.clear();
    uploads.length = 0;
  });

  it('keeps a made file as an upload by its hash, readable as one', async () => {
    const deck = Buffer.from('PK a deck');
    const ref = await storeUploadedFile(
      SESSION,
      deck,
      'pptx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
    expect(ref).toBe(`/api/file/${sha(deck)}.pptx`);
    expect(uploads[0]).toEqual({
      name: `u1/uploads/files/${sha(deck)}.pptx`,
      contentType:
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    });
    const read = await readDocumentSource(SESSION, {
      kind: 'upload',
      id: `${sha(deck)}.pptx`,
      type: 'pptx',
    });
    expect(read?.data.equals(deck)).toBe(true);
  });
});

describe('storedUploadBytes', () => {
  it('decodes a stored data URL and leaves other files as they are', () => {
    expect(
      storedUploadBytes(
        Buffer.from(
          `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`,
        ),
      ).toString(),
    ).toBe('<svg/>');
    expect(storedUploadBytes(PDF)).toBe(PDF);
  });
});
