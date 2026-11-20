/**
 * A person's slots for one kind of background job (THE JOB CONVENTION in
 * backgroundJobs.ts), kept in app storage under their own prefix, so every
 * instance sees the same slots.
 */
import { BlobProperty, BlobStorage } from '@/lib/utils/server/blob/blob';
import { overwriteBlob } from '@/lib/utils/server/blob/overwriteBlob';
import { isBlobNotFoundError } from '@/lib/utils/server/blob/storageErrors';

import { JobSlotRecord, JobSlots } from './backgroundJobs';

/**
 * Reads one stored record: the runner's shape, or the single-record shape
 * presentation runs were kept in before (`{runId, sourceName, ...}`).
 */
function recordOf(value: unknown): JobSlotRecord | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.heartbeatAt !== 'number') return null;
  if (typeof raw.key === 'string') {
    return {
      key: raw.key,
      label: typeof raw.label === 'string' ? raw.label : '',
      heartbeatAt: raw.heartbeatAt,
      ...(raw.data && typeof raw.data === 'object'
        ? { data: raw.data as Record<string, unknown> }
        : {}),
    };
  }
  if (typeof raw.runId === 'string') {
    const { runId, sourceName, heartbeatAt, ...data } = raw;
    return {
      key: runId,
      label: typeof sourceName === 'string' ? sourceName : '',
      heartbeatAt: heartbeatAt as number,
      data,
    };
  }
  return null;
}

/** The slots in one blob of a person's app storage. */
export class BlobJobSlots implements JobSlots {
  private readonly name: string;

  /**
   * @param storage - The person's app storage.
   * @param userId - Their id: the blob is under their prefix.
   * @param blobName - The blob, relative to their prefix (one per kind).
   */
  constructor(
    private readonly storage: BlobStorage,
    userId: string,
    blobName: string,
  ) {
    this.name = `${userId}/${blobName}`;
  }

  async read(): Promise<JobSlotRecord[]> {
    let parsed: unknown;
    try {
      const data = (await this.storage.get(
        this.name,
        BlobProperty.BLOB,
      )) as Buffer;
      parsed = JSON.parse(data.toString('utf-8'));
    } catch (error) {
      if (isBlobNotFoundError(error) || error instanceof SyntaxError) {
        return [];
      }
      throw error;
    }
    const values = Array.isArray(parsed) ? parsed : [parsed];
    return values
      .map(recordOf)
      .filter((record): record is JobSlotRecord => record !== null);
  }

  async write(record: JobSlotRecord): Promise<void> {
    const others = (await this.read()).filter(
      (held) => held.key !== record.key,
    );
    await this.save([...others, record]);
  }

  async release(key: string): Promise<void> {
    const held = await this.read();
    const kept = held.filter((record) => record.key !== key);
    if (kept.length === held.length) return;
    if (kept.length === 0) {
      await this.storage.deleteIfExists(this.name);
    } else {
      await this.save(kept);
    }
  }

  private async save(records: JobSlotRecord[]): Promise<void> {
    await overwriteBlob(
      this.storage,
      this.name,
      Buffer.from(JSON.stringify(records)),
      'application/json',
    );
  }
}
