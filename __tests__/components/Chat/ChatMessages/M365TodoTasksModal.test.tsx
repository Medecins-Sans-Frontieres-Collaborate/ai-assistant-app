// @vitest-environment jsdom
import { extractTaskCandidates } from '@/components/Chat/ChatMessages/M365TodoTasksModal';

import { describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

describe('extractTaskCandidates', () => {
  it('extracts bullet, checkbox and numbered lines with markdown stripped', () => {
    const content = [
      'Here are the action items:',
      '- **Send** the geo report to Chris',
      '* Book the offsite room',
      '- [ ] Update the risk register',
      '1. Follow up with legal',
      '2) Schedule the retro',
      'Regular prose is ignored.',
    ].join('\n');
    expect(extractTaskCandidates(content)).toEqual([
      'Send the geo report to Chris',
      'Book the offsite room',
      'Update the risk register',
      'Follow up with legal',
      'Schedule the retro',
    ]);
  });

  it('returns empty for prose-only content', () => {
    expect(extractTaskCandidates('No lists here at all.')).toEqual([]);
  });

  it('caps the batch at 25 items', () => {
    const content = Array.from({ length: 40 }, (_, i) => `- task ${i}`).join(
      '\n',
    );
    expect(extractTaskCandidates(content)).toHaveLength(25);
  });
});
