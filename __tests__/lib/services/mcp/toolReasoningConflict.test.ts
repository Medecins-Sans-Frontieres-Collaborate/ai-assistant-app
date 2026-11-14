import { isToolReasoningConflict } from '@/lib/services/mcp/toolReasoningConflict';

import { describe, expect, it } from 'vitest';

const LUNA_REFUSAL =
  "400 Function tools with reasoning_effort are not supported for gpt-5.6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.";

describe('isToolReasoningConflict', () => {
  it('recognises the refusal GPT-5.6 Luna returns', () => {
    expect(
      isToolReasoningConflict({ status: 400, message: LUNA_REFUSAL }),
    ).toBe(true);
  });

  it('ignores the same words on another status', () => {
    expect(
      isToolReasoningConflict({ status: 500, message: LUNA_REFUSAL }),
    ).toBe(false);
  });

  it('ignores a 400 about reasoning effort alone', () => {
    expect(
      isToolReasoningConflict({
        status: 400,
        message:
          "Unsupported value: 'reasoning_effort' does not support 'minimal' with this model.",
      }),
    ).toBe(false);
  });

  it('ignores a 400 about tools alone', () => {
    expect(
      isToolReasoningConflict({
        status: 400,
        message: "Invalid schema for function 'tools[0]': missing name",
      }),
    ).toBe(false);
  });

  it.each([null, undefined, 'error', new Error('boom'), {}])(
    'is false for %s',
    (value) => {
      expect(isToolReasoningConflict(value)).toBe(false);
    },
  );
});
