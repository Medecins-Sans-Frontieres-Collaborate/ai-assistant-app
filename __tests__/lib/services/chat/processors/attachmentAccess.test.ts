import { createTestChatContext } from '@/__tests__/lib/services/chat/testUtils';
import {
  attachmentToolsAvailable,
  fullTextAccess,
} from '@/lib/services/chat/processors/attachmentAccess';
import {
  MOUNTED_FILES_INLINE_BUDGET_TOKENS,
  excerptInlineFilesForReaccess,
} from '@/lib/services/chat/processors/mountedFileExcerpt';

import { InterpreterMode } from '@/types/interpreterMode';

import { env } from '@/config/environment';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CLAUDE = {
  id: 'claude-sonnet-5',
  sdk: 'anthropic-foundry',
  supportsTools: true,
};
const MISTRAL = { id: 'Mistral-Large-3', sdk: 'openai' };
const LUNA = {
  id: 'gpt-5.6-luna',
  sdk: 'azure-openai',
  supportsCodeInterpreter: true,
  supportsResponsesApi: true,
  supportsTools: true,
};

describe('fullTextAccess', () => {
  const prior = env.CODE_INTERPRETER_ENABLED;
  beforeAll(() => {
    (env as any).CODE_INTERPRETER_ENABLED = true;
  });
  afterAll(() => {
    (env as any).CODE_INTERPRETER_ENABLED = prior;
  });
  const turn = (
    model: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) =>
    createTestChatContext({
      model,
      interpreterMode: InterpreterMode.INTELLIGENT,
      ...extra,
    } as never);

  it('reads by tool for a tool-capable model on the tool loop', () => {
    expect(fullTextAccess(turn(CLAUDE))).toBe('tool');
  });

  it('has no way back for a model without tools (full text stays inline)', () => {
    expect(fullTextAccess(turn(MISTRAL))).toBeNull();
  });

  it('reads by code on a native interpreter turn', () => {
    expect(fullTextAccess(turn(LUNA))).toBe('code');
    expect(attachmentToolsAvailable(turn(LUNA))).toBe(false);
  });

  it('never moves a Responses-API model off its path just for this tool', () => {
    const noInterpreter = turn(LUNA, { interpreterMode: InterpreterMode.OFF });
    expect(fullTextAccess(noInterpreter)).toBeNull();
  });

  it('is off for non-streaming turns and custom-source models', () => {
    expect(fullTextAccess(turn(CLAUDE, { stream: false }))).toBeNull();
    expect(
      fullTextAccess(turn({ ...CLAUDE, isCustomSourceModel: true })),
    ).toBeNull();
  });
});

describe('excerptInlineFilesForReaccess', () => {
  const big = (name: string) => ({
    filename: name,
    content: 'row\n'.repeat(30_000), // ~120K chars, ~30K tokens
  });

  it('excerpts large read files, keeps their full text, leaves the rest alone', () => {
    const memo = { filename: 'memo.txt', content: 'short note' };
    const other = big('not-mounted.csv');
    const { inlineFiles, fullTexts } = excerptInlineFilesForReaccess(
      [memo, big('Rapport_2021.pdf'), other],
      new Set(['memo.txt', 'rapport_2021.pdf']),
      'tool',
    );
    expect(inlineFiles[0]).toBe(memo);
    expect(inlineFiles[1].isExcerpt).toBe(true);
    expect(inlineFiles[1].content).toContain('read_attachment');
    expect(inlineFiles[1].content).not.toContain('code interpreter');
    expect(inlineFiles[1].content.length).toBeLessThan(
      MOUNTED_FILES_INLINE_BUDGET_TOKENS * 4,
    );
    expect(inlineFiles[2]).toBe(other);
    expect(Object.keys(fullTexts)).toEqual(['Rapport_2021.pdf']);
    expect(fullTexts['Rapport_2021.pdf']).toBe(big('x').content);
  });

  it('keeps files whole while they fit the inline budget', () => {
    const fits = {
      filename: 'a.csv',
      content: 'x'.repeat(MOUNTED_FILES_INLINE_BUDGET_TOKENS * 4),
    };
    const { inlineFiles, fullTexts } = excerptInlineFilesForReaccess(
      [fits],
      new Set(['a.csv']),
      'tool',
    );
    expect(inlineFiles[0]).toBe(fits);
    expect(fullTexts).toEqual({});
  });

  it('does not excerpt an excerpt again', () => {
    const already = { ...big('b.pdf'), isExcerpt: true };
    const { inlineFiles } = excerptInlineFilesForReaccess(
      [already],
      new Set(['b.pdf']),
      'tool',
    );
    expect(inlineFiles[0]).toBe(already);
  });
});
