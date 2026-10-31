/**
 * lib/services/limits/groupLabels.ts — display names stored next to group
 * ids so history snapshots stay readable after a rename/deletion.
 */
import { NextRequest } from 'next/server';

import {
  collectGroupIds,
  pruneGroupLabels,
  refreshGroupLabels,
} from '@/lib/services/limits/groupLabels';
import { fetchGroupNames } from '@/lib/services/m365/groupDirectory';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/m365/groupDirectory', () => ({
  fetchGroupNames: vi.fn(),
}));

const G1 = '11111111-1111-4111-8111-111111111111';
const G2 = '22222222-2222-4222-8222-222222222222';
const G3 = '33333333-3333-4333-8333-333333333333';
const req = new NextRequest('http://localhost/api/limits/policy');

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('collectGroupIds', () => {
  it('gathers group-scoped override targets, group jurisdiction predicates and model-access group grants; ignores other scopes and malformed ids', () => {
    expect(
      collectGroupIds({
        overrides: [
          { scope: 'group', targets: [G2.toUpperCase(), 'not-a-guid'] },
          { scope: 'domain', targets: [G1] },
        ],
        delegations: [
          {
            jurisdiction: [
              { scope: 'group', targets: [G1] },
              { scope: 'user', targets: ['a@x.org'] },
            ],
          },
        ],
        modelAccess: [{ groups: [{ target: G3, requests: null }] }],
      }),
    ).toEqual([G1, G2, G3]);
  });
});

describe('pruneGroupLabels', () => {
  it('keeps only referenced ids, sorted, and answers undefined when nothing is left', () => {
    expect(
      pruneGroupLabels({ [G3]: 'Three', [G1]: 'One', [G2]: '' }, [G1, G3]),
    ).toEqual({ [G1]: 'One', [G3]: 'Three' });
    expect(pruneGroupLabels({ [G1]: 'One' }, [G2])).toBeUndefined();
    expect(pruneGroupLabels(undefined, [G1])).toBeUndefined();
  });
});

describe('refreshGroupLabels', () => {
  it('merges fresh names over stored ones and keeps a stored name the directory no longer answers for', async () => {
    vi.mocked(fetchGroupNames).mockResolvedValue(
      new Map([[G1, 'One (renamed)']]),
    );
    const labels = await refreshGroupLabels(req, [G1, G2], {
      [G1]: 'One',
      [G2]: 'Two (deleted)',
      [G3]: 'Three (no longer referenced)',
    });
    expect(labels).toEqual({ [G1]: 'One (renamed)', [G2]: 'Two (deleted)' });
    expect(vi.mocked(fetchGroupNames).mock.calls[0][1]).toEqual([G1, G2]);
  });

  it('never throws: a Graph failure keeps the stored labels', async () => {
    vi.mocked(fetchGroupNames).mockRejectedValue(new Error('down'));
    expect(await refreshGroupLabels(req, [G1], { [G1]: 'One' })).toEqual({
      [G1]: 'One',
    });
    expect(await refreshGroupLabels(req, [G1], undefined)).toBeUndefined();
  });

  it('asks nothing when the document references no group', async () => {
    expect(
      await refreshGroupLabels(req, [], { [G1]: 'stale' }),
    ).toBeUndefined();
    expect(fetchGroupNames).not.toHaveBeenCalled();
  });
});
