import { applyMcpPin } from '@/lib/utils/shared/chat/mcpPin';

import { describe, expect, it } from 'vitest';

const servers = [
  { id: 'github-1', name: 'GitHub' },
  { id: 'netsuite-1', name: 'NetSuite' },
  { id: 'asana-1', name: 'Asana' },
];

describe('applyMcpPin', () => {
  it('passes everything through when nothing is pinned', () => {
    expect(applyMcpPin(servers, undefined)).toEqual(servers);
  });

  it('narrows to exactly the pinned server', () => {
    expect(applyMcpPin(servers, 'netsuite-1')).toEqual([
      { id: 'netsuite-1', name: 'NetSuite' },
    ]);
  });

  it('FAILS OPEN on a stale pin — a removed server must not strip all tools', () => {
    expect(applyMcpPin(servers, 'deleted-id')).toEqual(servers);
  });

  it('returns an empty list unchanged', () => {
    expect(applyMcpPin([], 'anything')).toEqual([]);
  });
});
