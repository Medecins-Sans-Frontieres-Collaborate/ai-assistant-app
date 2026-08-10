import { pickTrimmableDocument } from '@/lib/services/chat/tools/documentTrim/trimDetector';

import { describe, expect, it } from 'vitest';

// Intent detection is multilingual and lives in
// ToolRouterService.classifyDocumentTrim (LLM) — only the FACTUAL
// eligibility checks are tested here.
describe('pickTrimmableDocument', () => {
  it('picks a current-turn docx', () => {
    expect(
      pickTrimmableDocument({
        currentTurn: ['manuscript.docx'],
        priorTurns: [],
      }),
    ).toEqual({ filename: 'manuscript.docx', format: 'docx' });
  });

  it('prefers current-turn files over prior-turn files', () => {
    expect(
      pickTrimmableDocument({
        currentTurn: ['notes.md'],
        priorTurns: ['manuscript.docx'],
      }),
    ).toEqual({ filename: 'notes.md', format: 'md' });
  });

  it('falls back to prior-turn attachments (follow-up turns)', () => {
    expect(
      pickTrimmableDocument({
        currentTurn: [],
        priorTurns: ['manuscript.docx'],
      }),
    ).toEqual({ filename: 'manuscript.docx', format: 'docx' });
  });

  it('maps .markdown to md and accepts .txt', () => {
    expect(
      pickTrimmableDocument({ currentTurn: ['a.markdown'], priorTurns: [] }),
    ).toEqual({ filename: 'a.markdown', format: 'md' });
    expect(
      pickTrimmableDocument({ currentTurn: ['b.txt'], priorTurns: [] }),
    ).toEqual({ filename: 'b.txt', format: 'txt' });
  });

  it('skips non-trimmable formats and returns null when none qualify', () => {
    expect(
      pickTrimmableDocument({
        currentTurn: ['report.pdf', 'data.xlsx'],
        priorTurns: ['image.png'],
      }),
    ).toBeNull();
  });

  it('skips a PDF but takes a later docx', () => {
    expect(
      pickTrimmableDocument({
        currentTurn: ['report.pdf', 'manuscript.docx'],
        priorTurns: [],
      }),
    ).toEqual({ filename: 'manuscript.docx', format: 'docx' });
  });
});
