import { fallbackRequirementsForTurn } from '@/lib/utils/shared/chat/fallbackRequirements';

import { ConversationEntry } from '@/types/chat';
import { InterpreterMode } from '@/types/interpreterMode';

import { describe, expect, it } from 'vitest';

const textTurn = [
  { role: 'user', content: 'Prepare the memo' },
] as unknown as ConversationEntry[];
const imageTurn = [
  { role: 'user', content: 'old text' },
  { role: 'assistant', content: 'ok' },
  {
    role: 'user',
    content: [
      { type: 'text', text: 'what is in this chart?' },
      { type: 'image_url', image_url: { url: '/api/file/c.png' } },
    ],
  },
] as unknown as ConversationEntry[];

describe('fallbackRequirementsForTurn', () => {
  it('requires the interpreter when the user forced it on', () => {
    expect(
      fallbackRequirementsForTurn({
        interpreterMode: InterpreterMode.ALWAYS,
        entries: textTurn,
      }),
    ).toEqual({ codeInterpreter: 'require' });
  });

  it('prefers the interpreter in Intelligent mode', () => {
    expect(
      fallbackRequirementsForTurn({
        interpreterMode: InterpreterMode.INTELLIGENT,
        entries: textTurn,
      }),
    ).toEqual({ codeInterpreter: 'prefer' });
  });

  it.each([InterpreterMode.OFF, undefined])(
    'asks nothing of the interpreter when mode is %s',
    (interpreterMode) => {
      expect(
        fallbackRequirementsForTurn({ interpreterMode, entries: textTurn }),
      ).toEqual({});
    },
  );

  it('prefers vision only when the LATEST user message has an image', () => {
    expect(fallbackRequirementsForTurn({ entries: imageTurn })).toEqual({
      vision: 'prefer',
    });
    const imageEarlier = [
      imageTurn[2],
      { role: 'assistant', content: 'a bar chart' },
      { role: 'user', content: 'thanks, now summarize' },
    ] as unknown as ConversationEntry[];
    expect(fallbackRequirementsForTurn({ entries: imageEarlier })).toEqual({});
  });
});
