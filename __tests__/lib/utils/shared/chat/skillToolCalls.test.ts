import {
  partitionSkillToolCalls,
  skillUsageHasIssue,
  summarizeSkillToolCalls,
} from '@/lib/utils/shared/chat/skillToolCalls';

import type { ToolCallRecord } from '@/types/chat';

import { describe, expect, it } from 'vitest';

const record = (overrides: Partial<ToolCallRecord>): ToolCallRecord =>
  ({
    id: 'r',
    name: 'use_skills',
    server_label: 'Skills',
    arguments: null,
    status: 'completed',
    output: null,
    error: null,
    ...overrides,
  }) as ToolCallRecord;

describe('skillToolCalls', () => {
  it('partitions skill records (by label or builtin server id) from MCP calls', () => {
    const skills = record({ id: 'a' });
    const agentSkill = record({
      id: 'b',
      name: 'load_skill',
      server_label: null,
      server_id: 'builtin-skills',
    });
    const mcp = record({
      id: 'c',
      name: 'search_tasks',
      server_label: 'Asana',
    });
    const { skillCalls, otherCalls } = partitionSkillToolCalls([
      skills,
      mcp,
      agentSkill,
    ]);
    expect(skillCalls.map((c) => c.id)).toEqual(['a', 'b']);
    expect(otherCalls.map((c) => c.id)).toEqual(['c']);
  });

  it('does not capture an MCP connector that happens to be labelled "Skills"', () => {
    const lookalike = record({
      id: 'x',
      name: 'search_tasks',
      server_label: 'Skills',
    });
    const preload = record({
      id: 'y',
      name: 'load_skill (requested)',
      server_label: 'Skills',
    });
    const { skillCalls, otherCalls } = partitionSkillToolCalls([
      lookalike,
      preload,
    ]);
    expect(skillCalls.map((c) => c.id)).toEqual(['y']);
    expect(otherCalls.map((c) => c.id)).toEqual(['x']);
  });

  it('parses use_skills lines into typed entries', () => {
    const lines = summarizeSkillToolCalls([
      record({
        status: 'incomplete',
        output: [
          'GDPR Guidance (requested)',
          'Report Style [user:report] (auto)',
          'Forms (pinned)',
          'ghost (unavailable)',
          'Automatic skill selection unavailable; explicitly selected skills still apply.',
        ].join('\n'),
        error: 'Unavailable skills: ghost',
      }),
    ]);
    expect(lines).toEqual([
      { kind: 'skill', name: 'GDPR Guidance', via: 'requested' },
      { kind: 'skill', name: 'Report Style [user:report]', via: 'auto' },
      { kind: 'skill', name: 'Forms', via: 'pinned' },
      { kind: 'unavailable', id: 'ghost' },
      {
        kind: 'note',
        text: 'Automatic skill selection unavailable; explicitly selected skills still apply.',
      },
    ]);
  });

  it('parses reference retrieval and agent tool records', () => {
    const lines = summarizeSkillToolCalls([
      record({
        name: 'skill_references',
        output: '3 reference passages retrieved.',
      }),
      record({
        name: 'skill_references',
        status: 'incomplete',
        output: '0 reference passages retrieved.',
      }),
      record({
        name: 'load_skill (requested)',
        arguments: JSON.stringify({ skillId: 'gdpr' }),
      }),
      record({ name: 'search_skill_documents', status: 'failed' }),
    ]);
    expect(lines).toEqual([
      { kind: 'references', count: 3, unavailable: false },
      { kind: 'references', count: 0, unavailable: true },
      { kind: 'agentLoad', name: 'gdpr', failed: false },
      { kind: 'agentSearch', failed: true },
    ]);
  });

  it('flags issues when any record is not completed', () => {
    expect(skillUsageHasIssue([record({})])).toBe(false);
    expect(skillUsageHasIssue([record({ status: 'incomplete' })])).toBe(true);
  });
});

describe('consent and version suffixes', () => {
  it('parses needs-approval lines and version notes on requested skills', () => {
    const lines = summarizeSkillToolCalls([
      record({
        name: 'use_skills',
        output: [
          'GDPR (requested, as originally run)',
          'Forms (pinned, updated since)',
          'Travel (needs approval)',
          'Plain (auto)',
        ].join('\n'),
      }),
    ]);
    expect(lines).toEqual([
      { kind: 'skill', name: 'GDPR', via: 'requested', version: 'original' },
      { kind: 'skill', name: 'Forms', via: 'pinned', version: 'updated' },
      { kind: 'consent', name: 'Travel' },
      { kind: 'skill', name: 'Plain', via: 'auto' },
    ]);
  });
});
