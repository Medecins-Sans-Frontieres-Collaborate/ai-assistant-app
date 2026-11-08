import { createTestChatContext } from '@/__tests__/lib/services/chat/testUtils';
import {
  nativeInterpreterPlanned,
  planningTokensPerMinute,
} from '@/lib/services/chat/enrichers/interpreterCapability';

import { InterpreterMode } from '@/types/interpreterMode';

import { env } from '@/config/environment';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const NATIVE_MODEL = {
  id: 'gpt-5.6-luna',
  sdk: 'azure-openai' as const,
  supportsCodeInterpreter: true,
  supportsResponsesApi: true,
};

describe('planningTokensPerMinute', () => {
  const prior = env.CODE_INTERPRETER_ENABLED;
  beforeAll(() => {
    (env as any).CODE_INTERPRETER_ENABLED = true;
  });
  afterAll(() => {
    (env as any).CODE_INTERPRETER_ENABLED = prior;
  });

  const turn = (
    interpreterMode: InterpreterMode,
    model: Record<string, unknown> = NATIVE_MODEL,
    servingTokensPerMinute: { tpm?: number } = { tpm: 250_000 },
  ) => ({
    ...createTestChatContext({ interpreterMode, model }),
    servingTokensPerMinute: servingTokensPerMinute.tpm,
  });

  it('splits the limit three ways on a native interpreter turn, before routing', () => {
    const context = turn(InterpreterMode.INTELLIGENT);
    expect(context.nativeCodeInterpreter).toBeUndefined();
    expect(nativeInterpreterPlanned(context)).toBe(true);
    expect(planningTokensPerMinute(context)).toBe(83_333);
  });

  it('plans one call when the interpreter is off', () => {
    expect(planningTokensPerMinute(turn(InterpreterMode.OFF))).toBe(250_000);
  });

  it('plans one call for a model without the native interpreter (sub-tool path)', () => {
    const mistral = { id: 'Mistral-Large-3', sdk: 'openai' as const };
    expect(planningTokensPerMinute(turn(InterpreterMode.ALWAYS, mistral))).toBe(
      250_000,
    );
  });

  it('passes an unknown limit through as no ceiling', () => {
    expect(
      planningTokensPerMinute(
        turn(InterpreterMode.INTELLIGENT, NATIVE_MODEL, {}),
      ),
    ).toBeUndefined();
  });
});
