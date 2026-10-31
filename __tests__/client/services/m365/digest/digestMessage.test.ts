import {
  buildDigestMessages,
  patchDigestMessage,
} from '@/client/services/m365/digest/digestMessage';

import type { DigestRequest } from '@/types/m365Digest';

import { describe, expect, it } from 'vitest';

const request: DigestRequest = {
  window: { startIso: 'a', endIso: 'b', preset: '7d' },
  sources: ['mail'],
  channels: [],
};

describe('digest messages', () => {
  it('builds a user line and a pending assistant group carrying the job', () => {
    const [user, assistant] = buildDigestMessages(
      'Daily digest',
      'Working…',
      'job-1',
      request,
    );
    expect(user).toMatchObject({ role: 'user', content: 'Daily digest' });
    expect(assistant.versions[0].digest).toEqual({
      jobId: 'job-1',
      status: 'pending',
      request,
    });
    expect(assistant.versions[0].content).toBe('Working…');
  });

  it('patches only the message with the matching job and rewrites its content', () => {
    const [user, assistant] = buildDigestMessages('x', 'y', 'job-1', request);
    const [, other] = buildDigestMessages('x', 'y', 'job-2', request);
    const patched = patchDigestMessage(
      { messages: [user, assistant, other] },
      'job-1',
      (state) => ({
        digest: { ...state, status: 'failed', error: 'boom' },
        content: 'failed: boom',
      }),
    );
    expect(patched).not.toBeNull();
    const target = patched![1];
    expect('versions' in target && target.versions[0].digest?.status).toBe(
      'failed',
    );
    expect('versions' in target && target.versions[0].content).toBe(
      'failed: boom',
    );
    const untouched = patched![2];
    expect(
      'versions' in untouched && untouched.versions[0].digest?.status,
    ).toBe('pending');
  });

  it('returns null when the digest message is gone', () => {
    expect(
      patchDigestMessage({ messages: [] }, 'job-1', (s) => ({ digest: s })),
    ).toBeNull();
  });
});
