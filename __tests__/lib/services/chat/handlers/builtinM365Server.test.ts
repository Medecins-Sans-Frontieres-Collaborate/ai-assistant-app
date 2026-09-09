import {
  buildBuiltinM365Server,
  partitionBuiltinMcpEntries,
} from '@/lib/services/chat/handlers/builtinM365Server';

import { McpServerRequestEntry } from '@/types/mcp';

import { describe, expect, it } from 'vitest';

describe('partitionBuiltinMcpEntries', () => {
  const builtin: McpServerRequestEntry = {
    id: 'builtin-m365',
    name: 'Microsoft 365',
    builtin: true,
  };
  const github: McpServerRequestEntry = {
    id: 'github',
    name: 'GitHub',
    catalogKey: 'github',
    authToken: 'github_pat_x',
  };

  it('splits the builtin marker from network entries', () => {
    const result = partitionBuiltinMcpEntries([github, builtin]);
    expect(result.builtinRequested).toBe(true);
    expect(result.rest).toEqual([github]);
  });

  it('handles absent/empty entry lists', () => {
    expect(partitionBuiltinMcpEntries(undefined)).toEqual({
      builtinRequested: false,
      rest: [],
    });
    expect(partitionBuiltinMcpEntries([])).toEqual({
      builtinRequested: false,
      rest: [],
    });
  });

  it('drops builtin-flagged entries with an unknown id entirely', () => {
    // Never fall through to network resolution: there is exactly one
    // builtin toolset.
    const rogue: McpServerRequestEntry = {
      id: 'builtin-evil',
      name: 'Evil',
      builtin: true,
      url: 'https://evil.example',
    };
    const result = partitionBuiltinMcpEntries([rogue, github]);
    expect(result.builtinRequested).toBe(false);
    expect(result.rest).toEqual([github]);
  });

  it('keeps non-builtin entries even when their id collides with builtin-m365', () => {
    const impostor: McpServerRequestEntry = {
      id: 'builtin-m365',
      name: 'Impostor',
      url: 'https://evil.example',
    };
    const result = partitionBuiltinMcpEntries([impostor]);
    // No builtin flag → not a builtin request; the entry goes to normal
    // resolution where it needs the custom-URL gate like anything else.
    expect(result.builtinRequested).toBe(false);
    expect(result.rest).toEqual([impostor]);
  });
});

describe('buildBuiltinM365Server', () => {
  it('constructs the url-less trusted synthetic server', () => {
    expect(buildBuiltinM365Server()).toEqual({
      id: 'builtin-m365',
      label: 'Microsoft 365',
      url: '',
      transport: 'streamable-http',
      auth: { style: 'none' },
      trusted: true,
      provenance: 'builtin',
    });
  });
});
