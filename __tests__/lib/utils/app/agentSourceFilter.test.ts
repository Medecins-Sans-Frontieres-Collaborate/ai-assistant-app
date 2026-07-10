import type { DiscoveredAgent } from '@/lib/services/agents/AgentDiscoveryService';

import { filterAgentsBySourceSelection } from '@/lib/utils/app/agentSourceFilter';

import { describe, expect, it } from 'vitest';

const PATH_A =
  '/subscriptions/a/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/acct-a/projects/proj';
const PATH_B =
  '/subscriptions/b/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/acct-b/projects/proj';
const REGIONAL_PATH =
  '/subscriptions/org/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/regional/projects/default';

function agent(agentName: string, source?: string): DiscoveredAgent {
  return {
    id: agentName,
    name: agentName,
    description: '',
    agentName,
    type: 'foundry',
    source,
  };
}

describe('filterAgentsBySourceSelection', () => {
  it('keeps everything when there are no custom sources', () => {
    const agents = [agent('x', REGIONAL_PATH), agent('y')];
    expect(filterAgentsBySourceSelection(agents, [])).toEqual(agents);
  });

  it('passes through agents from non-custom sources untouched', () => {
    const agents = [agent('regional-agent', REGIONAL_PATH), agent('untagged')];
    const filtered = filterAgentsBySourceSelection(agents, [
      {
        resourcePath: PATH_A,
        autoAddNewAgents: false,
        selectedAgentNames: [],
      },
    ]);
    expect(filtered).toEqual(agents);
  });

  it('auto-add ON: keeps all except excluded names', () => {
    const agents = [
      agent('keep-me', PATH_A),
      agent('drop-me', PATH_A),
      agent('brand-new', PATH_A),
    ];
    const filtered = filterAgentsBySourceSelection(agents, [
      {
        resourcePath: PATH_A,
        autoAddNewAgents: true,
        excludedAgentNames: ['drop-me'],
        selectedAgentNames: [],
      },
    ]);
    expect(filtered.map((a) => a.agentName)).toEqual(['keep-me', 'brand-new']);
  });

  it('auto-add OFF: keeps only explicitly selected names', () => {
    const agents = [
      agent('picked', PATH_A),
      agent('not-picked', PATH_A),
      agent('appeared-later', PATH_A),
    ];
    const filtered = filterAgentsBySourceSelection(agents, [
      {
        resourcePath: PATH_A,
        autoAddNewAgents: false,
        excludedAgentNames: [],
        selectedAgentNames: ['picked'],
      },
    ]);
    expect(filtered.map((a) => a.agentName)).toEqual(['picked']);
  });

  it('treats missing selection fields as auto-add-all (un-migrated blob)', () => {
    const agents = [agent('x', PATH_A)];
    const filtered = filterAgentsBySourceSelection(agents, [
      { resourcePath: PATH_A },
    ]);
    expect(filtered).toEqual(agents);
  });

  it('scopes selection per source: same agentName filtered independently', () => {
    const agents = [agent('shared-name', PATH_A), agent('shared-name', PATH_B)];
    const filtered = filterAgentsBySourceSelection(agents, [
      {
        resourcePath: PATH_A,
        autoAddNewAgents: true,
        excludedAgentNames: ['shared-name'],
        selectedAgentNames: [],
      },
      {
        resourcePath: PATH_B,
        autoAddNewAgents: true,
        excludedAgentNames: [],
        selectedAgentNames: [],
      },
    ]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].source).toBe(PATH_B);
  });

  it('auto-add OFF with no selected list hides all agents from that source', () => {
    const agents = [agent('x', PATH_A)];
    const filtered = filterAgentsBySourceSelection(agents, [
      { resourcePath: PATH_A, autoAddNewAgents: false },
    ]);
    expect(filtered).toEqual([]);
  });

  it('stale excluded names that no longer exist are harmless', () => {
    const agents = [agent('still-here', PATH_A)];
    const filtered = filterAgentsBySourceSelection(agents, [
      {
        resourcePath: PATH_A,
        autoAddNewAgents: true,
        excludedAgentNames: ['vanished-agent'],
        selectedAgentNames: [],
      },
    ]);
    expect(filtered).toEqual(agents);
  });
});
