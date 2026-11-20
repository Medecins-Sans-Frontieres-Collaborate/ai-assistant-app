/**
 * One person's jobs of one kind (THE JOB CONVENTION, backgroundJobs.ts),
 * kept in their own storage: each job's state under
 * `<user>/<folder>/<key>/`, and their running jobs in
 * `<user>/<folder>/active.json`.
 *
 * Features with jobs a person starts and comes back to (brand reviews,
 * deck builds) use this rather than placing their jobs themselves.
 */
import { Session } from 'next-auth';

import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';

import { getUserIdFromSession } from '@/lib/utils/app/user/session';

import {
  JobKind,
  JobStateBase,
  isStalled,
  readJob,
  resumeJob,
  startJob,
  stopJob,
} from './backgroundJobs';
import { BlobJobSlots } from './blobJobSlots';
import { BlobJobStore } from './blobJobStore';

/** Starting, reading, stopping and removing a person's jobs of a kind. */
export interface PersonJobs<R, S extends JobStateBase & { request: R }> {
  /**
   * Starts a job under a key the caller chose (unguessable).
   *
   * @throws JobActiveError when the person's slots for the kind are full.
   */
  start(session: Session, key: string, request: R): Promise<S>;
  /**
   * A job as stored, picked up again when its runner has gone quiet (a
   * restarted server).
   *
   * @returns The state, or null when the person has no such job.
   */
  read(session: Session, key: string): Promise<S | null>;
  /** Asks a running job to stop; it keeps what it did. Null when none. */
  stop(session: Session, key: string): Promise<S | null>;
  /** Stops a job if it runs and deletes what is stored of it. */
  remove(session: Session, key: string): Promise<boolean>;
}

/**
 * The person's jobs of a kind.
 *
 * @param kind - The job kind.
 * @param folder - Their folder in the person's storage (`brand-reviews`).
 * @param contextFor - What a job does its work with, for this person
 *   (built again when a job is picked up after a restart).
 */
export function personJobs<R, S extends JobStateBase & { request: R }, C>(
  kind: JobKind<R, S, C>,
  folder: string,
  contextFor: (session: Session, request: R) => C,
): PersonJobs<R, S> {
  const placeOf = (session: Session, key: string) => {
    const storage = createBlobStorageClient(session);
    const userId = getUserIdFromSession(session);
    return {
      store: new BlobJobStore(storage, `${userId}/${folder}/${key}/`),
      slots: new BlobJobSlots(storage, userId, `${folder}/active.json`),
      key,
    };
  };
  return {
    start: (session, key, request) =>
      startJob(
        kind,
        { ...placeOf(session, key), context: contextFor(session, request) },
        request,
      ),
    async read(session, key) {
      const place = placeOf(session, key);
      const state = await readJob<S>(kind, place.store);
      if (!state) return null;
      if (isStalled(kind.kind, key, state, Date.now())) {
        return resumeJob(
          kind,
          { ...place, context: contextFor(session, state.request) },
          state,
        );
      }
      return state;
    },
    async stop(session, key) {
      const place = placeOf(session, key);
      const state = await readJob<S>(kind, place.store);
      if (!state) return null;
      return stopJob(kind, key, place.store, state);
    },
    async remove(session, key) {
      const place = placeOf(session, key);
      const state = await readJob<S>(kind, place.store);
      if (!state) return false;
      await stopJob(kind, key, place.store, state);
      await place.slots.release(key);
      await place.store.remove();
      return true;
    },
  };
}
