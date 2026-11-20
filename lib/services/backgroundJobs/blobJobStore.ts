/**
 * A background job's state in app storage (THE JOB CONVENTION in
 * backgroundJobs.ts): `<prefix>job.json` holds the state and
 * `<prefix>stop.json` exists while a stop is asked for. The prefix is the
 * caller's, normally under the person's own folder.
 */
import { BlobProperty, BlobStorage } from '@/lib/utils/server/blob/blob';
import { isBlobNotFoundError } from '@/lib/utils/server/blob/storageErrors';

import { JobStore } from './backgroundJobs';

const JOB_FILE = 'job.json';
const STOP_FILE = 'stop.json';
const JSON_TYPE = 'application/json';

export class BlobJobStore implements JobStore {
  /**
   * @param storage - The app storage client.
   * @param prefix - The job's folder, ending in `/`.
   * @throws Error when the prefix is not a folder.
   */
  constructor(
    private readonly storage: BlobStorage,
    readonly prefix: string,
  ) {
    if (!prefix.endsWith('/')) {
      throw new Error(`A job folder must end in "/": ${prefix}`);
    }
  }

  private async read(name: string): Promise<Buffer | null> {
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

  private async write(name: string, data: unknown): Promise<void> {
    await this.storage.upload(
      this.prefix + name,
      Buffer.from(JSON.stringify(data), 'utf-8'),
      { blobHTTPHeaders: { blobContentType: JSON_TYPE } },
    );
  }

  async getJob(): Promise<unknown | null> {
    const stored = await this.read(JOB_FILE);
    return stored ? (JSON.parse(stored.toString('utf-8')) as unknown) : null;
  }

  async putJob(state: unknown): Promise<void> {
    await this.write(JOB_FILE, state);
  }

  async stopRequested(): Promise<boolean> {
    return (await this.read(STOP_FILE)) !== null;
  }

  async requestStop(): Promise<void> {
    await this.write(STOP_FILE, {});
  }

  async clearStop(): Promise<void> {
    await this.storage.deleteIfExists(this.prefix + STOP_FILE);
  }

  /** Deletes the job's folder: its state and any stop request. */
  async remove(): Promise<void> {
    await Promise.all([
      this.storage.deleteIfExists(this.prefix + JOB_FILE),
      this.storage.deleteIfExists(this.prefix + STOP_FILE),
    ]);
  }
}
