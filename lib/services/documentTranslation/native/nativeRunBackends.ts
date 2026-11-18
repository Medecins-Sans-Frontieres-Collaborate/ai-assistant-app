import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import { resolveDriveNamespace } from '@/lib/services/backup/server/backupDriveStore';
import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';
import {
  GRAPH_V1,
  M365Error,
  graphErrorFromResponse,
  mintGraphToken,
} from '@/lib/services/m365/graphApi';
import {
  SIMPLE_UPLOAD_MAX,
  uploadSessionFragments,
} from '@/lib/services/m365/graphUpload';

import { getUserIdFromSession } from '@/lib/utils/app/user/session';
import { BlobProperty, BlobStorage } from '@/lib/utils/server/blob/blob';
import { isBlobNotFoundError } from '@/lib/utils/server/blob/storageErrors';

/**
 * The two places a translation run's folder can live (see BACKENDS in
 * nativeRunStorage.ts). Both hold opaque bytes under plain names; naming,
 * encryption and expiry are decided one level up, in nativePdfStorage.ts.
 */

/** One stored file of a run. */
export interface RunFolderEntry {
  name: string;
  /** When the file was last written; absent where files do not expire. */
  lastModified?: Date;
}

/** A run's folder in one backend. */
export interface RunFolder {
  /** Whether files here are deleted some days after their last write. */
  readonly expires: boolean;
  /** Writes a file, replacing one of the same name. */
  write(name: string, data: Buffer, contentType: string): Promise<void>;
  /** Reads a file; null when it does not exist. */
  read(name: string): Promise<Buffer | null>;
  /** Lists the folder's files; empty when the folder does not exist. */
  list(): Promise<RunFolderEntry[]>;
  /** Deletes a file; absent files are not an error. */
  remove(name: string): Promise<void>;
  /** Marks a file as written now, where files expire. */
  touch(name: string): Promise<void>;
  /** Deletes the whole folder. */
  removeAll(): Promise<void>;
}

// ── app storage ─────────────────────────────────────────────────────────────

/**
 * A run's folder in the app's blob storage, under the person's own prefix:
 * `<user>/translation-runs/<run>/<name>`. The container's lifecycle rule
 * deletes each blob some days after its last modification.
 */
export class BlobRunFolder implements RunFolder {
  readonly expires = true;
  private readonly prefix: string;

  constructor(
    private readonly storage: BlobStorage,
    userId: string,
    runId: string,
  ) {
    this.prefix = `${userId}/translation-runs/${runId}/`;
  }

  /** The folder of a signed-in person's run. */
  static open(session: Session, runId: string): BlobRunFolder {
    return new BlobRunFolder(
      createBlobStorageClient(session),
      getUserIdFromSession(session),
      runId,
    );
  }

  async write(name: string, data: Buffer, contentType: string): Promise<void> {
    await this.storage.upload(this.prefix + name, data, {
      blobHTTPHeaders: { blobContentType: contentType },
    });
  }

  async read(name: string): Promise<Buffer | null> {
    try {
      return (await this.storage.get(
        this.prefix + name,
        BlobProperty.BLOB,
      )) as Buffer;
    } catch (error) {
      if (isBlobNotFoundError(error)) return null;
      throw error;
    }
  }

  async list(): Promise<RunFolderEntry[]> {
    const blobs = await this.storage.listBlobsDetailed(this.prefix);
    return blobs.map((blob) => ({
      name: blob.name.slice(this.prefix.length),
      lastModified: blob.lastModified,
    }));
  }

  async remove(name: string): Promise<void> {
    await this.storage.deleteIfExists(this.prefix + name);
  }

  async touch(name: string): Promise<void> {
    await this.storage.touch(this.prefix + name);
  }

  async removeAll(): Promise<void> {
    const entries = await this.list();
    await Promise.all(entries.map((entry) => this.remove(entry.name)));
  }
}

// ── OneDrive ────────────────────────────────────────────────────────────────

const DRIVE_SCOPES = ['Files.ReadWrite.All'];
export const DRIVE_RUNS_FOLDER = 'Apps/AI Assistant/Translations';

interface DriveChildren {
  value?: Array<{ name?: string }>;
  '@odata.nextLink'?: string;
}

/**
 * A run's folder in the person's own OneDrive:
 * `Apps/AI Assistant/Translations/<deployment>/<run>/<name>`. The
 * deployment segment keeps localhost, dev and production runs apart in the
 * one drive they share (see resolveDriveNamespace). Files stay until the
 * person deletes them.
 */
export class DriveRunFolder implements RunFolder {
  readonly expires = false;
  private readonly folder: string;

  constructor(
    private readonly req: NextRequest,
    runId: string,
  ) {
    const namespace = resolveDriveNamespace(req.nextUrl.hostname || null);
    this.folder = `${DRIVE_RUNS_FOLDER}/${namespace}/${runId}`
      .split('/')
      .map(encodeURIComponent)
      .join('/');
  }

  /**
   * The folder of a run in the signed-in person's OneDrive.
   *
   * @throws M365Error when the person has not granted file access.
   */
  static async open(req: NextRequest, runId: string): Promise<DriveRunFolder> {
    // Minted up front so a missing grant fails before any work is done.
    await mintGraphToken(req, DRIVE_SCOPES);
    return new DriveRunFolder(req, runId);
  }

  private url(name = '', suffix = ''): string {
    const path = name
      ? `${this.folder}/${encodeURIComponent(name)}`
      : this.folder;
    return `${GRAPH_V1}/me/drive/root:/${path}:${suffix}`;
  }

  private async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await mintGraphToken(this.req, DRIVE_SCOPES);
    return fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
    });
  }

  async write(name: string, data: Buffer, contentType: string): Promise<void> {
    // A fresh copy: a Buffer may be a view over a shared pool.
    const bytes = new Uint8Array(data);
    if (bytes.length <= SIMPLE_UPLOAD_MAX) {
      const response = await this.fetch(
        this.url(name, '/content?@microsoft.graph.conflictBehavior=replace'),
        {
          method: 'PUT',
          headers: { 'Content-Type': contentType },
          body: bytes,
        },
      );
      if (!response.ok) {
        throw await graphErrorFromResponse(response, 'Saving the file failed');
      }
      return;
    }
    const sessionResponse = await this.fetch(
      this.url(name, '/createUploadSession'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          item: { '@microsoft.graph.conflictBehavior': 'replace' },
        }),
      },
    );
    if (!sessionResponse.ok) {
      throw await graphErrorFromResponse(
        sessionResponse,
        'Starting the upload failed',
      );
    }
    const { uploadUrl } = (await sessionResponse.json()) as {
      uploadUrl?: string;
    };
    if (!uploadUrl) {
      throw new M365Error('Upload session was not created', 'graph_error', 502);
    }
    await uploadSessionFragments(uploadUrl, bytes, contentType, {
      requireItem: false,
    });
  }

  async read(name: string): Promise<Buffer | null> {
    // The item's metadata carries a short-lived, pre-authenticated link to
    // its content; the content endpoint itself answers with a redirect.
    const meta = await this.fetch(this.url(name));
    if (meta.status === 404) return null;
    if (!meta.ok) {
      throw await graphErrorFromResponse(meta, 'Reading the file failed');
    }
    const item = (await meta.json()) as {
      '@microsoft.graph.downloadUrl'?: string;
    };
    const downloadUrl = item['@microsoft.graph.downloadUrl'];
    if (!downloadUrl) {
      throw new M365Error('The file has no content', 'graph_error', 502);
    }
    const content = await fetch(downloadUrl);
    if (!content.ok) {
      throw new M365Error(
        `Downloading the file failed (${content.status})`,
        'graph_error',
        502,
      );
    }
    return Buffer.from(await content.arrayBuffer());
  }

  async list(): Promise<RunFolderEntry[]> {
    const entries: RunFolderEntry[] = [];
    let next: string | undefined = this.url(
      '',
      '/children?$select=name&$top=200',
    );
    while (next) {
      const response = await this.fetch(next);
      if (response.status === 404) return [];
      if (!response.ok) {
        throw await graphErrorFromResponse(response, 'Listing the run failed');
      }
      const page = (await response.json()) as DriveChildren;
      for (const child of page.value ?? []) {
        if (child.name) entries.push({ name: child.name });
      }
      next = page['@odata.nextLink'];
    }
    return entries;
  }

  async remove(name: string): Promise<void> {
    const response = await this.fetch(this.url(name), { method: 'DELETE' });
    if (!response.ok && response.status !== 404) {
      throw await graphErrorFromResponse(response, 'Deleting the file failed');
    }
  }

  /** Nothing expires here, so there is nothing to keep alive. */
  async touch(): Promise<void> {}

  async removeAll(): Promise<void> {
    const response = await this.fetch(this.url(), { method: 'DELETE' });
    if (!response.ok && response.status !== 404) {
      throw await graphErrorFromResponse(response, 'Deleting the run failed');
    }
  }
}
