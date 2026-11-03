import {
  agentAudienceSearchLabel,
  agentSearchDocument,
  matchesAgentSearch,
} from '@/components/AgentAccess/agentSearch';
import { isAgentListSource } from '@/components/AgentAccess/types';

import { describe, expect, it } from 'vitest';

describe('agent metadata search', () => {
  it('classifies canonical source variants consistently without duplicate native rows', () => {
    for (const source of ['m365-agent', 'M365-Agent', ' org-agent ', ' GUIDE '])
      expect(isAgentListSource(source)).toBe(false);
    for (const source of [
      'prompt-agent',
      ' Prompt-Agent ',
      '/subscriptions/Example/Projects/HR',
    ])
      expect(isAgentListSource(source)).toBe(true);
  });
  it('makes empty restrictions searchable as no audience, not everyone', () => {
    const labels = {
      everyone: 'All eligible users',
      restricted: 'Selected audience',
      none: 'No allowed audience',
    };
    expect(agentAudienceSearchLabel(undefined, labels)).toBe(labels.everyone);
    expect(
      agentAudienceSearchLabel(
        {
          type: 'restricted',
          allowDomains: [],
          allowUsers: [],
          allowGroups: [],
        },
        labels,
      ),
    ).toBe(labels.none);
    expect(
      agentAudienceSearchLabel(
        {
          type: 'restricted',
          allowDomains: ['msf.org'],
          allowUsers: [],
          allowGroups: [],
        },
        labels,
      ),
    ).toBe(labels.restricted);
  });
  it('matches nested source, audience, actor, key and configuration values', () => {
    const document = agentSearchDocument({
      name: 'Employee Handbook',
      key: 'm365-agent::id-123',
      source: [{ title: 'Benefits.pdf', owner: 'HR' }],
      access: { users: ['person@msf.org'] },
      updatedBy: 'admin@example.org',
      model: 'gpt-5.2',
    });
    for (const query of [
      'BENEFITS.PDF',
      'HR handbook',
      'person@msf.org',
      'admin@example.org',
      'id-123',
      'gpt-5.2',
    ])
      expect(matchesAgentSearch(document, query)).toBe(true);
    expect(matchesAgentSearch(document, 'HR nonexistent')).toBe(false);
  });

  it('normalizes accents and Unicode across Latin and RTL text', () => {
    const document = agentSearchDocument([
      'Réponse clinique',
      'مُسْتَنَد',
      'Ｆｉｌｅｓ',
    ]);
    expect(matchesAgentSearch(document, 'reponse clinique')).toBe(true);
    expect(matchesAgentSearch(document, 'مستند')).toBe(true);
    expect(matchesAgentSearch(document, 'files')).toBe(true);
    expect(matchesAgentSearch(document, '   ')).toBe(true);
  });

  it('ignores cycles, absent values and property names that would create false matches', () => {
    const metadata: Record<string, unknown> = {
      failed: 0,
      status: 'indexed',
      missing: undefined,
    };
    metadata.cycle = metadata;
    const document = agentSearchDocument(metadata);
    expect(matchesAgentSearch(document, 'indexed')).toBe(true);
    expect(matchesAgentSearch(document, 'failed')).toBe(false);
    expect(matchesAgentSearch(document, 'undefined')).toBe(false);
  });
});
