/**
 * A person's one active presentation run (THE JOB CONVENTION in
 * deckRunJob.ts), kept in app storage under their own prefix whatever
 * backend the run's files use, so every instance sees the same slot.
 */
import { Session } from 'next-auth';

import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';

import { getUserIdFromSession } from '@/lib/utils/app/user/session';
import { BlobProperty, BlobStorage } from '@/lib/utils/server/blob/blob';
import { isBlobNotFoundError } from '@/lib/utils/server/blob/storageErrors';

import { DeckRunSlot, DeckRunSlotRecord } from './deckRunJob';

/** The slot's blob, beside the person's run folders. */
const SLOT_NAME = 'translation-runs/active-deck-run.json';

/** The slot in a person's app storage. */
export class BlobDeckRunSlot implements DeckRunSlot {
  private readonly name: string;

  constructor(
    private readonly storage: BlobStorage,
    userId: string,
  ) {
    this.name = `${userId}/${SLOT_NAME}`;
  }

  /** The signed-in person's slot. */
  static open(session: Session): BlobDeckRunSlot {
    return new BlobDeckRunSlot(
      createBlobStorageClient(session),
      getUserIdFromSession(session),
    );
  }

  async read(): Promise<DeckRunSlotRecord | null> {
    try {
      const data = (await this.storage.get(
        this.name,
        BlobProperty.BLOB,
      )) as Buffer;
      const record = JSON.parse(data.toString('utf-8')) as DeckRunSlotRecord;
      return typeof record?.runId === 'string' &&
        typeof record.heartbeatAt === 'number'
        ? record
        : null;
    } catch (error) {
      if (isBlobNotFoundError(error) || error instanceof SyntaxError) {
        return null;
      }
      throw error;
    }
  }

  async write(record: DeckRunSlotRecord): Promise<void> {
    await this.storage.upload(this.name, Buffer.from(JSON.stringify(record)), {
      blobHTTPHeaders: { blobContentType: 'application/json' },
    });
  }

  async release(runId: string): Promise<void> {
    const held = await this.read();
    if (held?.runId === runId) await this.storage.deleteIfExists(this.name);
  }
}
