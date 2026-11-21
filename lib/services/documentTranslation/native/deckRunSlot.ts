/**
 * A person's one active presentation run (THE JOB CONVENTION in
 * lib/services/backgroundJobs/backgroundJobs.ts), kept in app storage
 * under their own prefix whatever backend the run's files use, so every
 * instance sees the same slot. Stored as the runner's slots
 * (BlobJobSlots), which also read the single record kept here before.
 */
import { Session } from 'next-auth';

import { BlobJobSlots } from '@/lib/services/backgroundJobs/blobJobSlots';
import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';

import { getUserIdFromSession } from '@/lib/utils/app/user/session';
import { BlobStorage } from '@/lib/utils/server/blob/blob';
import { NativeRunBackend } from '@/lib/utils/shared/translation/nativeRunStorage';

import { DeckRunSlot, DeckRunSlotRecord } from './deckRunJob';

/** The slot's blob, beside the person's run folders. */
const SLOT_NAME = 'translation-runs/active-deck-run.json';

/** The slot in a person's app storage. */
export class BlobDeckRunSlot implements DeckRunSlot {
  private readonly slots: BlobJobSlots;

  constructor(storage: BlobStorage, userId: string) {
    this.slots = new BlobJobSlots(storage, userId, SLOT_NAME);
  }

  /** The signed-in person's slot. */
  static open(session: Session): BlobDeckRunSlot {
    return new BlobDeckRunSlot(
      createBlobStorageClient(session),
      getUserIdFromSession(session),
    );
  }

  async read(): Promise<DeckRunSlotRecord | null> {
    const [held] = await this.slots.read();
    if (!held) return null;
    return {
      runId: held.key,
      backend: (held.data?.backend as NativeRunBackend | undefined) ?? 'app',
      sourceName: held.label,
      heartbeatAt: held.heartbeatAt,
    };
  }

  async write(record: DeckRunSlotRecord): Promise<void> {
    // One deck run per person: the record replaces any other.
    const others = await this.slots.read();
    for (const other of others) {
      if (other.key !== record.runId) await this.slots.release(other.key);
    }
    await this.slots.write({
      key: record.runId,
      label: record.sourceName,
      heartbeatAt: record.heartbeatAt,
      data: { backend: record.backend },
    });
  }

  async release(runId: string): Promise<void> {
    await this.slots.release(runId);
  }
}
