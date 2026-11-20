import {
  BrandFileError,
  BrandFileStore,
  parseBrandFileRef,
  settleBrandBookFiles,
  storedBrandFileRef,
  uploadBytes,
} from '@/lib/services/brand/brandBooks';

import { parseBrandBookBody } from '@/lib/utils/shared/brand/brandBook';

import { createHash } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE BRAND FILE CONVENTION (brandBooks.ts): an admin's uploads are copied
 * into the book on save and their references rewritten; a reference of the
 * wrong shape, type or book is refused.
 */

vi.mock('@/config/environment', () => ({ env: {} }));
vi.mock('@/lib/services/blobStorageFactory', () => ({
  createBlobStorageClient: vi.fn(),
}));

const BOOK = 'brand-aaaaaaaaaaaa';
const OTHER = 'brand-bbbbbbbbbbbb';
const HASH = 'c'.repeat(64);
const session = { user: { id: 'u1' } } as never;

function memoryStore(stored: string[] = []) {
  const uploads = new Map<string, Buffer>([
    [`${HASH}.png`, Buffer.from('png bytes')],
  ]);
  const written = new Map<string, Buffer>();
  const store: BrandFileStore = {
    readUpload: vi.fn(async (_session, blobName: string) => {
      const data = uploads.get(blobName);
      if (!data) throw new Error('not found');
      return data;
    }),
    storedExists: vi.fn(async (_book, name: string) => stored.includes(name)),
    writeStored: vi.fn(async (book: string, name: string, data: Buffer) => {
      written.set(`${book}/${name}`, data);
    }),
  };
  return { store, written };
}

function book(changes: Record<string, unknown>) {
  const parsed = parseBrandBookBody({ name: 'Northwind', ...changes });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.body;
}

describe('parseBrandFileRef', () => {
  it('reads an upload and a stored file, and nothing else', () => {
    expect(parseBrandFileRef(`/api/file/${HASH}.png`)).toEqual({
      kind: 'upload',
      blobName: `${HASH}.png`,
      ext: 'png',
    });
    expect(
      parseBrandFileRef(`admin:${BOOK}/${'d'.repeat(32)}.pdf`),
    ).toMatchObject({
      kind: 'stored',
      bookId: BOOK,
      ext: 'pdf',
    });
    for (const bad of [
      '/api/file/../secret.png',
      `admin:${BOOK}/../x.png`,
      `admin:formtpl-aaaaaaaaaaaa/${'d'.repeat(32)}.pdf`,
      'https://example.com/logo.png',
    ]) {
      expect(parseBrandFileRef(bad)).toBeNull();
    }
  });
});

describe('settleBrandBookFiles', () => {
  let memory: ReturnType<typeof memoryStore>;
  beforeEach(() => {
    memory = memoryStore();
  });

  it('copies an upload into the book under its hash and rewrites every use', async () => {
    const upload = `/api/file/${HASH}.png`;
    const settled = await settleBrandBookFiles(
      session,
      BOOK,
      book({
        logos: [
          { id: 'main', name: 'Logo', file: upload },
          { id: 'small', name: 'Small', file: upload },
        ],
      }),
      memory.store,
    );
    const name = `${createHash('sha256').update('png bytes').digest('hex').slice(0, 32)}.png`;
    expect(settled.logos.map((logo) => logo.file)).toEqual([
      storedBrandFileRef(BOOK, name),
      storedBrandFileRef(BOOK, name),
    ]);
    // Read and written once, though used twice.
    expect(memory.store.readUpload).toHaveBeenCalledTimes(1);
    expect([...memory.written.keys()]).toEqual([`${BOOK}/${name}`]);
  });

  it('keeps a stored file of the same book that still exists', async () => {
    const name = `${'d'.repeat(32)}.pdf`;
    const { store } = memoryStore([name]);
    const ref = storedBrandFileRef(BOOK, name);
    const settled = await settleBrandBookFiles(
      session,
      BOOK,
      book({ source: { file: ref, name: 'Guide.pdf' } }),
      store,
    );
    expect(settled.source?.file).toBe(ref);
    expect(store.writeStored).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a file of another book',
      { source: { file: `admin:${OTHER}/${'d'.repeat(32)}.pdf`, name: 'G' } },
      'another brand book',
    ],
    [
      'a stored file that is gone',
      { source: { file: `admin:${BOOK}/${'e'.repeat(32)}.pdf`, name: 'G' } },
      'missing',
    ],
    [
      'a type the place does not take',
      { logos: [{ id: 'main', name: 'Logo', file: `/api/file/${HASH}.docx` }] },
      'A logo must be',
    ],
    [
      'something that is no reference',
      {
        logos: [
          { id: 'main', name: 'Logo', file: 'https://example.com/l.png' },
        ],
      },
      'not a file reference',
    ],
  ])('refuses %s', async (_label, change, message) => {
    await expect(
      settleBrandBookFiles(session, BOOK, book(change), memory.store),
    ).rejects.toThrow(BrandFileError);
    await expect(
      settleBrandBookFiles(session, BOOK, book(change), memory.store),
    ).rejects.toThrow(message);
    expect(memory.store.writeStored).not.toHaveBeenCalled();
  });
});

describe('uploadBytes', () => {
  it('decodes an image the upload route kept as its data URL', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
    const stored = Buffer.from(
      `data:image/png;base64,${png.toString('base64')}`,
    );
    expect(uploadBytes(stored).equals(png)).toBe(true);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    expect(
      uploadBytes(
        Buffer.from(
          `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
        ),
      ).toString(),
    ).toBe(svg);
  });

  it('keeps any other file as it is, even one that mentions a data URL', () => {
    const pdf = Buffer.from('%PDF-1.7 data:image/png;base64,AAAA');
    expect(uploadBytes(pdf)).toBe(pdf);
    const docx = Buffer.from([0x50, 0x4b, 3, 4]);
    expect(uploadBytes(docx)).toBe(docx);
  });
});
