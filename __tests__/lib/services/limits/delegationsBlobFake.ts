/**
 * Test fake for the two-document read the limits store now performs: the
 * policy blob, then the shared delegations blob composed into it
 * (lib/services/limits/limitsStore.ts `readPolicy`).
 *
 * Tests keep scripting ONE thing — the policy blob, through `policyBlob` —
 * and the delegations document is derived from whichever policy was served
 * last, exactly as the one-time migration would have produced it. So a test
 * that changes `policy.delegations` between CAS rounds still sees that change
 * in the composed policy, and `policyBlob` call counts stay "one per policy
 * read".
 */
import { downloadBlob } from '@/lib/services/agentAccess/blobCas';
import {
  DELEGATIONS_DOCUMENT_PATH,
  fromLegacyLimitDelegations,
} from '@/lib/services/delegations/types';

import { Mock, vi } from 'vitest';

type BlobResult = Awaited<ReturnType<typeof downloadBlob>>;

export function installPolicyBlobFake(
  policyBlob: Mock<(...args: unknown[]) => Promise<BlobResult>>,
): void {
  let last: BlobResult = null;
  vi.mocked(downloadBlob).mockImplementation(async (...args) => {
    const path = args[1];
    if (path === DELEGATIONS_DOCUMENT_PATH) {
      let legacy: unknown[] = [];
      try {
        const parsed = JSON.parse(last?.buffer.toString('utf8') ?? '{}');
        if (Array.isArray(parsed.delegations)) legacy = parsed.delegations;
      } catch {
        // An unparseable policy never reaches the delegations read.
      }
      return {
        buffer: Buffer.from(
          JSON.stringify(
            fromLegacyLimitDelegations(
              legacy as Parameters<typeof fromLegacyLimitDelegations>[0],
              'test',
              '2026-01-01T00:00:00.000Z',
            ),
          ),
          'utf8',
        ),
        etag: '"d1"',
      };
    }
    last = await policyBlob(...args);
    return last;
  });
}
