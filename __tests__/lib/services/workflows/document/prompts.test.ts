import {
  buildGenerateSystemPrompt,
  buildGenerateUserPrompt,
  buildReviseUserPrompt,
} from '@/lib/services/workflows/document/prompts';

import { describe, expect, it } from 'vitest';

const refs = [
  { name: 'field-report.pdf', text: 'Cholera cases rose 40% in March.' },
];

describe('document workflow prompts', () => {
  it('omits citation rules without references', () => {
    expect(buildGenerateSystemPrompt(false)).not.toContain('SOURCE blocks');
    expect(buildGenerateSystemPrompt(true)).toContain('SOURCE blocks');
  });

  it('embeds references as named SOURCE blocks', () => {
    const prompt = buildGenerateUserPrompt('Write a summary', refs);
    expect(prompt).toContain('SOURCE [field-report.pdf]:');
    expect(prompt).toContain('Cholera cases rose 40% in March.');
    expect(prompt).toContain('Write a summary');
  });

  it('revise prompt carries the current document and asks for a full rewrite', () => {
    const prompt = buildReviseUserPrompt(
      'Make it shorter',
      '# Title\n\nBody',
      [],
    );
    expect(prompt).toContain('# Title');
    expect(prompt).toContain('COMPLETE revised document');
    expect(prompt).toContain('Make it shorter');
  });
});
