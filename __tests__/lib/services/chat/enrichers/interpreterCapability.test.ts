import { createTestChatContext } from '@/__tests__/lib/services/chat/testUtils';
import { nativeInterpreterCapable } from '@/lib/services/chat/enrichers/interpreterCapability';

import { InterpreterMode } from '@/types/interpreterMode';

import { describe, expect, it } from 'vitest';

const NATIVE_MODEL = {
  id: 'gpt-5.2',
  sdk: 'azure-openai' as const,
  supportsCodeInterpreter: true,
  supportsResponsesApi: true,
};

const contextWith = (mcpServers?: unknown[], model = NATIVE_MODEL) => ({
  ...createTestChatContext({
    interpreterMode: InterpreterMode.INTELLIGENT,
    model,
  }),
  mcpServers: mcpServers as never,
});

/**
 * A turn with connector tools runs on the chat.completions tool loop, which
 * has no interpreter. Calling such a turn "native capable" skips the
 * sub-tool round-trip as well, so nothing can run code: in the browser,
 * GPT-5.2 with the Microsoft 365 connector on answered "create a Word
 * document" with a connector tool call and no file.
 */
describe('nativeInterpreterCapable', () => {
  it('is true for a Responses-capable model with no connector tools', () => {
    expect(nativeInterpreterCapable(contextWith(undefined))).toBe(true);
    expect(nativeInterpreterCapable(contextWith([]))).toBe(true);
  });

  it('is false when the builtin Microsoft 365 toolset is on', () => {
    expect(
      nativeInterpreterCapable(
        contextWith([{ id: 'builtin-m365', builtin: true }]),
      ),
    ).toBe(false);
  });

  it('is false when a network connector is on', () => {
    expect(
      nativeInterpreterCapable(
        contextWith([{ id: 'srv', url: 'https://x.test' }]),
      ),
    ).toBe(false);
  });

  it('is false for a model that cannot run the interpreter natively', () => {
    const mistral = { id: 'Mistral-Large-3', sdk: 'openai' as const };
    expect(
      nativeInterpreterCapable(contextWith(undefined, mistral as never)),
    ).toBe(false);
  });
});
