import { createTestChatContext } from '@/__tests__/lib/services/chat/testUtils';
import { SkillReferenceEnricher } from '@/lib/services/chat/enrichers/SkillReferenceEnricher';
import { retrieveSkillReferences } from '@/lib/services/skills/skillReferences';

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/skills/skillReferences', () => ({
  retrieveSkillReferences: vi.fn(),
}));

describe('skill reference pipeline delivery', () => {
  it('merges sources and quote verification data without overwriting web evidence', async () => {
    const old = {
      number: 1,
      title: 'Web',
      url: 'https://example.test',
      date: '',
    };
    const added = {
      number: 2,
      title: 'Policy',
      url: '/api/skills/gdpr/documents/id',
      date: '',
    };
    vi.mocked(retrieveSkillReferences).mockResolvedValue({
      text: '\nSource 2: policy',
      citations: [added],
      quoteSources: { '2': 'policy' },
      unavailable: [],
    });
    const context = createTestChatContext({
      systemPrompt: 'Skill instructions',
      processedContent: {
        metadata: { citations: [old], citationQuoteSources: { '1': 'web' } },
      },
    });
    const result = await new SkillReferenceEnricher().execute(context);
    expect(result.systemPrompt).toBe('Skill instructions\nSource 2: policy');
    expect(result.processedContent?.metadata?.citations).toEqual([old, added]);
    expect(result.processedContent?.metadata?.citationQuoteSources).toEqual({
      '1': 'web',
      '2': 'policy',
    });
  });
  it('a retrieval timeout preserves instructions and explains missing evidence', () => {
    const result = new SkillReferenceEnricher().onTimeout(
      createTestChatContext({ systemPrompt: 'Skill instructions' }),
    );
    expect(result.systemPrompt).toContain('Skill instructions');
    expect(result.systemPrompt).toContain('reference retrieval is unavailable');
  });
});
