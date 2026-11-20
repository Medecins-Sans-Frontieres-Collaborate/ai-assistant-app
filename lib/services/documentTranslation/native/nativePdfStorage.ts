import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import Hasher from '@/lib/utils/app/hash';
import {
  NATIVE_PDF_EXPORT_FORMATS,
  NativePdfExportFormat,
  NativePdfExportUrls,
} from '@/lib/utils/shared/translation/nativePdf';
import {
  NativeRunBackend,
  RUN_KEY_BYTES,
  RUN_KEY_HEADER,
  RUN_RECORD_ID,
  RUN_TOUCH_INTERVAL_HOURS,
  base64ToBytes,
  decryptRunFile,
  encryptRunFile,
  isEncryptedRunFile,
  isRunBackend,
  isRunFileId,
  isRunId,
  runExpiry,
  runFileUrl,
} from '@/lib/utils/shared/translation/nativeRunStorage';

import { NativePdfPageOutput } from './nativePdfPipeline';
import {
  BlobRunFolder,
  DriveRunFolder,
  RunFolder,
  RunFolderKind,
} from './nativeRunBackends';

/**
 * A translation run's files, on the server (see the conventions in
 * nativeRunStorage.ts). A {@link NativeRunStore} is one run's folder in its
 * backend, with naming, encryption and expiry applied: what the routes
 * read and write through.
 */

const CONTENT_TYPES = {
  pdf: 'application/pdf',
  json: 'application/json',
  png: 'image/png',
  pptx: NATIVE_PDF_EXPORT_FORMATS.pptx.contentType,
} as const;
const OPAQUE = 'application/octet-stream';

export type NativePdfFileKind = keyof typeof CONTENT_TYPES;

export interface StoredNativeFile {
  /** `<sha256>.<kind>`: what a later request sends back to name this file. */
  id: string;
  /** Path the browser loads it from. */
  url: string;
}

export interface StoredNativePage {
  page: number;
  /** PNG of the translated page. */
  previewUrl: string;
  /** PNG of the original beside the translated page. */
  checkUrl: string;
}

/** Where a request says its run is, and the key to its files if encrypted. */
export interface NativeRunLocation {
  runId: string;
  backend: NativeRunBackend;
  key?: Uint8Array;
}

/** A file of the run is not in storage: expired, deleted or never written. */
export class NativeRunFileMissingError extends Error {
  constructor(readonly fileId: string) {
    super(`The file ${fileId} of this translation run is no longer stored`);
    this.name = 'NativeRunFileMissingError';
  }
}

/** A file is encrypted and the request did not carry the run's key. */
export class NativeRunLockedError extends Error {
  constructor() {
    super('This translation run is encrypted and no key was sent');
    this.name = 'NativeRunLockedError';
  }
}

/** What keeping a run in step with the browser found. */
export interface NativeRunSync {
  /** ISO time the run's first file expires; null where files do not expire. */
  expiresAt: string | null;
  /** Files the run holds after the sync. */
  files: number;
}

/** Whether a value names a stored file of the given kind. */
export function isNativeFileId(
  id: unknown,
  kind: NativePdfFileKind,
): id is string {
  return isRunFileId(id) && id.endsWith(`.${kind}`) && id !== RUN_RECORD_ID;
}

/** The content type a stored file is served with. */
export function runFileContentType(fileId: string, stored: Uint8Array): string {
  if (isEncryptedRunFile(stored)) return OPAQUE;
  const kind = fileId.slice(fileId.lastIndexOf('.') + 1);
  return CONTENT_TYPES[kind as NativePdfFileKind] ?? OPAQUE;
}

/**
 * Reads where a run is from a request's fields and its key header.
 *
 * @param fields - The request's `runId` and `storage`.
 * @param req - The request, for the key header.
 * @returns The location, or the reason the fields are not acceptable.
 */
export function parseRunLocation(
  fields: { runId: unknown; storage: unknown },
  req: NextRequest,
): { ok: true; location: NativeRunLocation } | { ok: false; error: string } {
  if (!isRunId(fields.runId)) {
    return { ok: false, error: 'runId must be the id of a translation run' };
  }
  if (!isRunBackend(fields.storage)) {
    return { ok: false, error: 'storage must be "app" or "onedrive"' };
  }
  const header = req.headers.get(RUN_KEY_HEADER);
  let key: Uint8Array | undefined;
  if (header) {
    const bytes = base64ToBytes(header);
    if (!bytes || bytes.length !== RUN_KEY_BYTES) {
      return { ok: false, error: 'The run key is not valid' };
    }
    key = bytes;
  }
  return {
    ok: true,
    location: { runId: fields.runId, backend: fields.storage, key },
  };
}

/** One run's files (see the module comment). */
export class NativeRunStore {
  constructor(
    readonly location: NativeRunLocation,
    private readonly folder: RunFolder,
  ) {}

  /**
   * Stores a file the server made, encrypted when the run has a key.
   *
   * @param data - The file's bytes.
   * @param kind - What the file is.
   * @returns The file's id and the path the browser loads it from.
   */
  async put(
    data: Uint8Array,
    kind: NativePdfFileKind,
  ): Promise<StoredNativeFile> {
    const id = `${Hasher.sha256(Buffer.from(data))}.${kind}`;
    const { runId, key } = this.location;
    const stored = key ? await encryptRunFile(key, runId, id, data) : data;
    await this.folder.write(
      id,
      Buffer.from(stored),
      key ? OPAQUE : CONTENT_TYPES[kind],
    );
    return { id, url: runFileUrl(this.location, id) };
  }

  /**
   * Reads a file's content, decrypting it when it is stored encrypted.
   *
   * @throws NativeRunFileMissingError when the file is not in storage.
   * @throws NativeRunLockedError when it is encrypted and no key was sent.
   * @throws RunFileIntegrityError when the key is not the run's.
   */
  async get(id: string): Promise<Buffer> {
    const stored = await this.getStored(id);
    if (!isEncryptedRunFile(stored)) return stored;
    const { runId, key } = this.location;
    if (!key) throw new NativeRunLockedError();
    return Buffer.from(await decryptRunFile(key, runId, id, stored));
  }

  /**
   * Reads a file exactly as stored, for the browser to decrypt itself.
   *
   * @throws NativeRunFileMissingError when the file is not in storage.
   */
  async getStored(id: string): Promise<Buffer> {
    const stored = await this.folder.read(id);
    if (!stored) throw new NativeRunFileMissingError(id);
    return stored;
  }

  /**
   * Stores the run's record as the browser sent it. The server never reads
   * a record, so an encrypted one is encrypted by the browser.
   */
  async putRecord(stored: Uint8Array): Promise<void> {
    await this.folder.write(
      RUN_RECORD_ID,
      Buffer.from(stored),
      isEncryptedRunFile(stored) ? OPAQUE : CONTENT_TYPES.json,
    );
  }

  /**
   * Brings the run's folder in step with what the browser still uses:
   * files it no longer names are deleted, and where files expire, those
   * not written for {@link RUN_TOUCH_INTERVAL_HOURS} are touched.
   *
   * @param keep - Ids of the files still in use; absent keeps everything.
   *   The record is always kept.
   * @param touch - False only reports when the run expires, extending nothing.
   * @throws NativeRunFileMissingError when the run holds no files at all,
   *   or a file named in `keep` is gone.
   */
  async sync(keep?: readonly string[], touch = true): Promise<NativeRunSync> {
    const now = Date.now();
    const kept = keep && new Set([...keep, RUN_RECORD_ID]);
    const entries = await this.folder.list();
    const live = entries.filter((entry) => !kept || kept.has(entry.name));
    await Promise.all(
      entries
        .filter((entry) => !live.includes(entry))
        .map((entry) => this.folder.remove(entry.name)),
    );
    if (live.length === 0) throw new NativeRunFileMissingError(RUN_RECORD_ID);
    const present = new Set(live.map((entry) => entry.name));
    const lost = keep?.find((id) => !present.has(id));
    if (lost) throw new NativeRunFileMissingError(lost);
    if (!this.folder.expires) return { expiresAt: null, files: live.length };

    const stale = now - RUN_TOUCH_INTERVAL_HOURS * 60 * 60 * 1000;
    let oldest = now;
    await Promise.all(
      live.map(async (entry) => {
        const written = entry.lastModified?.getTime() ?? 0;
        if (!touch || written > stale) {
          oldest = Math.min(oldest, written);
          return;
        }
        await this.folder.touch(entry.name);
      }),
    );
    return {
      expiresAt: runExpiry(new Date(oldest)).toISOString(),
      files: live.length,
    };
  }

  /** Deletes the run and everything in it. */
  async remove(): Promise<void> {
    await this.folder.removeAll();
  }

  /**
   * Stores a rebuild's PDF, page images and editable files.
   *
   * @param built - The rebuild's PDF and per-page images.
   * @returns Where the PDF, each page's images and each editable file are
   *   served from.
   */
  async putRebuild(built: {
    pdf: Uint8Array;
    outputs: NativePdfPageOutput[];
    /** Editable files built with the PDF (see EDITABLE DOWNLOADS). */
    exports?: Partial<Record<NativePdfExportFormat, Uint8Array>>;
  }): Promise<{
    pdfUrl: string;
    pageImages: StoredNativePage[];
    exportUrls?: NativePdfExportUrls;
  }> {
    const formats = Object.entries(built.exports ?? {}) as Array<
      [NativePdfExportFormat, Uint8Array]
    >;
    const [pdf, pageImages, exported] = await Promise.all([
      this.put(built.pdf, 'pdf'),
      Promise.all(
        built.outputs.map(async (output) => {
          const [preview, check] = await Promise.all([
            this.put(output.preview, 'png'),
            this.put(output.check, 'png'),
          ]);
          return {
            page: output.page,
            previewUrl: preview.url,
            checkUrl: check.url,
          };
        }),
      ),
      Promise.all(
        formats.map(
          async ([format, data]) =>
            [format, (await this.put(data, format)).url] as const,
        ),
      ),
    ]);
    return {
      pdfUrl: pdf.url,
      pageImages,
      ...(exported.length ? { exportUrls: Object.fromEntries(exported) } : {}),
    };
  }
}

/**
 * Opens a run's folder in the backend the request names.
 *
 * @param req - The request; OneDrive is reached with its delegated token.
 * @param session - The signed-in person; app storage uses their prefix.
 * @param location - The run, its backend and its key.
 * @param kind - What the folder holds; a run unless said otherwise.
 * @throws M365Error when OneDrive is named and file access is not granted.
 */
export async function openNativeRunStore(
  req: NextRequest,
  session: Session,
  location: NativeRunLocation,
  kind: RunFolderKind = 'runs',
): Promise<NativeRunStore> {
  const folder =
    location.backend === 'onedrive'
      ? await DriveRunFolder.open(req, location.runId, kind)
      : BlobRunFolder.open(session, location.runId, kind);
  return new NativeRunStore(location, folder);
}
