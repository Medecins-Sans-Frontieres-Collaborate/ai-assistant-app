import { extractPendingApprovalIds } from '@/lib/utils/server/foundryErrors';

import { describe, expect, it } from 'vitest';

describe('extractPendingApprovalIds', () => {
  it('returns empty array for non-error input', () => {
    expect(extractPendingApprovalIds(null)).toEqual([]);
    expect(extractPendingApprovalIds(undefined)).toEqual([]);
    expect(extractPendingApprovalIds({})).toEqual([]);
  });

  it('returns empty array for non-400 errors', () => {
    expect(
      extractPendingApprovalIds({
        status: 500,
        message: 'do not have an approval: mcpr_abc',
      }),
    ).toEqual([]);
  });

  it('returns empty array when 400 message does not match the marker phrase', () => {
    expect(
      extractPendingApprovalIds({
        status: 400,
        message: 'Some other validation failure mcpr_abc',
      }),
    ).toEqual([]);
  });

  it('extracts a single id from err.message', () => {
    const ids = extractPendingApprovalIds({
      status: 400,
      message:
        'The following MCP approval requests do not have an approval: mcpr_abc123',
    });
    expect(ids).toEqual(['mcpr_abc123']);
  });

  it('extracts multiple ids and dedupes', () => {
    const ids = extractPendingApprovalIds({
      status: 400,
      message:
        'do not have an approval: mcpr_aaa, mcpr_bbb, mcpr_aaa, mcpr_ccc',
    });
    expect(ids.sort()).toEqual(['mcpr_aaa', 'mcpr_bbb', 'mcpr_ccc']);
  });

  it('reads from err.error.message when err.message is missing', () => {
    const ids = extractPendingApprovalIds({
      status: 400,
      error: {
        message: 'do not have an approval: mcpr_x',
      },
    });
    expect(ids).toEqual(['mcpr_x']);
  });

  it('reads from err.response.body when other sources are missing', () => {
    const ids = extractPendingApprovalIds({
      response: {
        status: 400,
        body: 'do not have an approval: mcpr_zzz',
      },
    });
    expect(ids).toEqual(['mcpr_zzz']);
  });

  it('respects err.statusCode in addition to err.status', () => {
    const ids = extractPendingApprovalIds({
      statusCode: 400,
      message: 'do not have an approval: mcpr_a',
    });
    expect(ids).toEqual(['mcpr_a']);
  });

  it('only matches mcpr_ prefixed IDs (not arbitrary strings)', () => {
    const ids = extractPendingApprovalIds({
      status: 400,
      message:
        'do not have an approval: req_other, abc_something, mcpr_only_this',
    });
    expect(ids).toEqual(['mcpr_only_this']);
  });
});
