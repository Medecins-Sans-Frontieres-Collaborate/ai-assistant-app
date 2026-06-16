/**
 * Tests for the batch transcription job ownership registry.
 *
 * Uses the real filesystem (/tmp/batch-transcription-jobs) with random
 * UUIDs per test, mirroring how the registry runs in production.
 */
import {
  deleteBatchJobRecord,
  getBatchJobOwner,
  recordBatchJobOwner,
  userOwnsBatchJob,
} from '@/lib/services/transcription/batchJobRegistry';

import { randomUUID } from 'crypto';
import { afterEach, describe, expect, it } from 'vitest';

describe('batchJobRegistry', () => {
  const created: string[] = [];

  function freshJobId(): string {
    const jobId = randomUUID();
    created.push(jobId);
    return jobId;
  }

  afterEach(() => {
    for (const jobId of created.splice(0)) {
      deleteBatchJobRecord(jobId);
    }
  });

  it('round-trips owner records', () => {
    const jobId = freshJobId();
    recordBatchJobOwner(jobId, 'user-a');
    expect(getBatchJobOwner(jobId)).toBe('user-a');
  });

  it('grants access only to the recorded owner', () => {
    const jobId = freshJobId();
    recordBatchJobOwner(jobId, 'user-a');
    expect(userOwnsBatchJob(jobId, 'user-a')).toBe(true);
    expect(userOwnsBatchJob(jobId, 'user-b')).toBe(false);
  });

  it('denies access to unregistered jobs (deny-unknown policy)', () => {
    // An unknown GUID is more likely a probe than a legitimate pre-registry
    // job; routes turn this denial into an indistinguishable 404.
    expect(userOwnsBatchJob(randomUUID(), 'user-a')).toBe(false);
  });

  it('removes records on delete', () => {
    const jobId = freshJobId();
    recordBatchJobOwner(jobId, 'user-a');
    deleteBatchJobRecord(jobId);
    expect(getBatchJobOwner(jobId)).toBeUndefined();
  });

  it('never throws on malformed job IDs (registry is best-effort)', () => {
    expect(() => recordBatchJobOwner('../escape', 'user-a')).not.toThrow();
    expect(getBatchJobOwner('../escape')).toBeUndefined();
    expect(userOwnsBatchJob('../escape', 'user-a')).toBe(false);
  });
});
