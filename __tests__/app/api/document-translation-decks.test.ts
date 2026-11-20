import { NextRequest } from 'next/server';

import { readDeckSlides } from '@/lib/services/documentTranslation/deck/deckText';
import {
  readPackageDirectory,
  readPackagePart,
} from '@/lib/services/presentationRender/ooxmlPackage';

import { TRANSLATION_PAGES_LIMIT_KEY } from '@/types/documentTranslation';

import {
  createMockRequest,
  createMockSession,
  parseJsonResponse,
} from './helpers';

import { GET } from '@/app/api/document-translation/status/[jobId]/route';
import { POST } from '@/app/api/document-translation/translate/route';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

/**
 * A presentation through Text only, end to end on the server: submitted
 * (checked, a .ppt converted, a plain .pptx copy staged), then finished
 * (the service's translation merged into the person's own package). The
 * service's output is its real French translation of rich.pptx.
 */

const mockAuth = vi.hoisted(() => vi.fn());
const mockSubmitBatch = vi.hoisted(() => vi.fn());
const mockBatchStatus = vi.hoisted(() => vi.fn());
const mockConvert = vi.hoisted(() => vi.fn());
const mockGuardLimit = vi.hoisted(() => vi.fn());
const mockRollback = vi.hoisted(() => vi.fn());
/** Blobs by container, then path. */
const containers = vi.hoisted(() => new Map<string, Map<string, Buffer>>());

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/lib/services/limits/routeGuard', () => ({
  guardLimit: mockGuardLimit,
}));
vi.mock('@/config/environment', () => ({ env: {} }));
vi.mock('@/lib/utils/app/env', () => ({
  getEnvVariable: () => 'test-storage',
}));
vi.mock('@/lib/utils/server/observability', () => ({
  createApiLoggingContext: () => ({
    logger: { logTranslationSuccess: vi.fn(), logTranslationError: vi.fn() },
    timer: { elapsed: () => 1 },
    getErrorMessage: (e: unknown) => String(e),
  }),
}));
vi.mock(
  '@/lib/services/documentTranslation/documentTranslationService',
  () => ({
    DocumentTranslationService: class {
      submitBatchTranslation = mockSubmitBatch;
      getBatchTranslationStatus = mockBatchStatus;
    },
  }),
);
// The render service converts a .ppt; here it hands back a .pptx fixture.
vi.mock('@/lib/services/presentationRender/renderService', () => ({
  getRenderService: () => ({ convert: mockConvert }),
}));
vi.mock('@/lib/utils/server/blob/blob', async (importOriginal) => {
  const original = await importOriginal<object>();
  return {
    ...original,
    AzureBlobStorage: class {
      private blobs: Map<string, Buffer>;
      constructor(_name: string, container: string) {
        if (!containers.has(container)) containers.set(container, new Map());
        this.blobs = containers.get(container)!;
      }
      upload = async (name: string, content: string | Buffer) => {
        this.blobs.set(name, Buffer.from(content));
        return name;
      };
      get = async (name: string) => {
        const blob = this.blobs.get(name);
        if (!blob) throw new Error(`BlobNotFound: ${name}`);
        return blob;
      };
      blobExists = async (name: string) => this.blobs.has(name);
      deleteIfExists = async (name: string) => this.blobs.delete(name);
      generateContainerScopedSasUrl = async (name: string) =>
        `https://staging.example.com/${name}?sig=sas`;
    },
  };
});

const FIXTURES = path.join(__dirname, '../../fixtures/pptx');
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name));
const USER = 'test-user-id';
const user = () => containers.get('test-storage')!;
const staging = () => containers.get('doc-translation-staging')!;

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-route-test-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function submit(
  filename: string,
  body: Buffer,
  extra: Record<string, string> = {},
) {
  const form = new FormData();
  form.append('document', new File([new Uint8Array(body)], filename));
  form.append('targetLanguage', 'fr');
  for (const [key, value] of Object.entries(extra)) form.append(key, value);
  return POST(
    new NextRequest(
      'http://localhost:3000/api/document-translation/translate',
      {
        method: 'POST',
        body: form,
      },
    ),
  );
}

const poll = (jobId: string) =>
  GET(createMockRequest({ method: 'GET' }), {
    params: Promise.resolve({ jobId }),
  });

/** Writes a blob to disk and reads its slides. */
async function slidesOf(blob: Buffer, name: string) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, blob);
  return readDeckSlides(file);
}

/** Plays the service: writes its French translation where it was told. */
function serviceTranslates() {
  const target = mockSubmitBatch.mock.calls.at(-1)![0].targetUrl as string;
  const name = new URL(target).pathname.slice(1);
  staging().set(name, fixture('rich.fr.pptx'));
  mockBatchStatus.mockResolvedValue({ status: 'Succeeded' });
}

beforeEach(() => {
  vi.clearAllMocks();
  containers.clear();
  mockAuth.mockResolvedValue(createMockSession(USER));
  mockSubmitBatch.mockResolvedValue('op-1');
  mockGuardLimit.mockResolvedValue({ allowed: true, rollback: mockRollback });
});

describe('the daily allowance', () => {
  it('charges a presentation its slides, hidden ones included', async () => {
    const res = await submit('deck.pptx', fixture('rich.pptx'));
    expect(res.status).toBe(202);
    const pages = mockGuardLimit.mock.calls.find(
      ([, key]) => key === TRANSLATION_PAGES_LIMIT_KEY,
    );
    expect(pages?.[2]).toMatchObject({ amount: 5 });
  });

  it('gives back what it reserved when the deck cannot be read', async () => {
    const res = await submit('deck.pptx', Buffer.from('not a zip at all'));
    expect(res.status).toBe(422);
    expect(
      mockGuardLimit.mock.calls.some(
        ([, key]) => key === TRANSLATION_PAGES_LIMIT_KEY,
      ),
    ).toBe(false);
    expect(mockRollback).toHaveBeenCalled();
  });
});

describe('submitting a presentation', () => {
  it('stages a plain .pptx copy of a .pptm and keeps the .pptm itself', async () => {
    const res = await submit('deck.pptm', fixture('rich.pptm'), {
      translateNotes: 'false',
    });
    const json = await parseJsonResponse(res);
    expect(res.status).toBe(202);
    const { jobId } = json.data;
    expect(json.data.fileExtension).toBe('pptm');

    const base = `${USER}/translations/${jobId}`;
    expect(user().get(`${base}_original.pptm`)).toEqual(fixture('rich.pptm'));
    const sent = staging().get(`${base}_original.pptx`)!;
    expect(sent).toBeDefined();
    const sentNames = (await readPackageDirectory(writeTemp(sent))).map(
      (entry) => entry.name,
    );
    expect(sentNames).not.toContain('ppt/vbaProject.bin');

    const batch = mockSubmitBatch.mock.calls[0][0];
    expect(batch.sourceUrl).toContain(`${base}_original.pptx`);
    expect(batch.targetUrl).toContain(`${base}.pptx`);

    const job = JSON.parse(
      user().get(`${USER}/translations/jobs/${jobId}.json`)!.toString(),
    );
    expect(job).toMatchObject({
      ext: 'pptm',
      serviceExt: 'pptx',
      translateNotes: false,
    });
    expect(job.convertedFrom).toBeUndefined();
  });

  it('converts a .ppt to .pptx first and names the translation .pptx', async () => {
    mockConvert.mockImplementation(async (request: { outputDir: string }) => {
      fs.mkdirSync(request.outputDir, { recursive: true });
      const out = path.join(request.outputDir, 'upload.pptx');
      fs.writeFileSync(out, fixture('rich.pptx'));
      return out;
    });
    const res = await submit('old deck.ppt', fixture('rich.ppt'));
    const json = await parseJsonResponse(res);
    expect(res.status).toBe(202);
    expect(mockConvert.mock.calls[0][0]).toMatchObject({
      type: 'ppt',
      lane: 'translation',
    });
    expect(json.data.originalFilename).toBe('old deck.pptx');
    expect(json.data.fileExtension).toBe('pptx');
    const job = JSON.parse(
      user()
        .get(`${USER}/translations/jobs/${json.data.jobId}.json`)!
        .toString(),
    );
    expect(job).toMatchObject({
      ext: 'pptx',
      convertedFrom: 'ppt',
      translateNotes: true,
    });
  });

  it('refuses a file that is not a presentation, and one that is protected', async () => {
    const garbage = await submit('deck.pptx', Buffer.from('not a zip at all'));
    expect(garbage.status).toBe(422);

    // A password-protected .pptx is a compound file, as a .ppt is.
    const protectedDeck = await submit('locked.pptx', fixture('rich.ppt'));
    expect(protectedDeck.status).toBe(422);
    const body = JSON.stringify(await parseJsonResponse(protectedDeck));
    expect(body).toContain('DOCUMENT_PROTECTED');

    expect(mockSubmitBatch).not.toHaveBeenCalled();
    expect(staging()?.size ?? 0).toBe(0);
  });

  it('answers busy, with a time to retry, when the render queue is full', async () => {
    const { RenderBusyError } =
      await import('@/lib/services/presentationRender/renderQueue');
    mockConvert.mockRejectedValue(new RenderBusyError(200));
    const res = await submit('old.ppt', fixture('rich.ppt'));
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    expect(mockSubmitBatch).not.toHaveBeenCalled();
  });
});

/** Writes a buffer to a fresh temp file and returns its path. */
function writeTemp(buffer: Buffer): string {
  const file = path.join(dir, `blob-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(file, buffer);
  return file;
}

describe('finishing a presentation', () => {
  it('delivers the person’s .pptm with the translation in it, macros kept', async () => {
    const json = await parseJsonResponse(
      await submit('deck.pptm', fixture('rich.pptm')),
    );
    const { jobId } = json.data;
    serviceTranslates();

    const status = await parseJsonResponse(await poll(jobId));
    expect(status.data.status).toBe('Succeeded');

    const delivered = user().get(`${USER}/translations/${jobId}.pptm`)!;
    const slides = await slidesOf(delivered, 'delivered.pptm');
    expect(slides[0].text).toBe(
      'Rapport annuel\nLa clinique a ouvert en mars.',
    );
    expect(slides[0].notes).toBe("N'oubliez pas de remercier les bénévoles.");
    const file = writeTemp(delivered);
    const entries = await readPackageDirectory(file);
    expect(
      await readPackagePart(file, entries, 'ppt/vbaProject.bin', 1e6),
    ).toEqual(
      await readPackagePart(
        writeTemp(fixture('rich.pptm')),
        await readPackageDirectory(writeTemp(fixture('rich.pptm'))),
        'ppt/vbaProject.bin',
        1e6,
      ),
    );
    // Staging is cleared once the result is in the person's storage.
    expect(staging().size).toBe(0);
  });

  it('keeps the original speaker notes when they were not to be translated', async () => {
    const json = await parseJsonResponse(
      await submit('deck.pptx', fixture('rich.pptx'), {
        translateNotes: 'false',
      }),
    );
    serviceTranslates();
    await poll(json.data.jobId);
    const slides = await slidesOf(
      user().get(`${USER}/translations/${json.data.jobId}.pptx`)!,
      'no-notes.pptx',
    );
    expect(slides[0].text).toContain('Rapport annuel');
    expect(slides[0].notes).toBe('Remember to thank the volunteers.');
  });

  it('fails the job, instead of polling forever, when the translation cannot be merged', async () => {
    const json = await parseJsonResponse(
      await submit('deck.pptx', fixture('rich.pptx')),
    );
    const target = new URL(
      mockSubmitBatch.mock.calls[0][0].targetUrl,
    ).pathname.slice(1);
    // What came back is not a package.
    staging().set(target, Buffer.from('truncated download'));
    mockBatchStatus.mockResolvedValue({ status: 'Succeeded' });
    const status = await parseJsonResponse(await poll(json.data.jobId));
    expect(status.data.status).toBe('Failed');
    expect(user().has(`${USER}/translations/${json.data.jobId}.pptx`)).toBe(
      false,
    );
  });
});
