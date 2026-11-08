import { CODE_INTERPRETER_PROMPT_SECTION } from '@/lib/utils/app/systemPrompt';

import {
  GENERATED_DOCUMENT_LAYOUT_RULE,
  GENERATED_DOCUMENT_MIN_BODY_PT,
  GENERATED_DOCUMENT_MIN_TABLE_PT,
} from '@/lib/constants/generatedFiles';
import { describe, expect, it } from 'vitest';

/**
 * The Tongolo review fitted four pages by shrinking text to 6.5–7 pt. The
 * rule sets readable minimums and says what to do instead of shrinking.
 */
describe('GENERATED_DOCUMENT_LAYOUT_RULE', () => {
  it('states both minimum sizes, table no larger than body', () => {
    expect(GENERATED_DOCUMENT_MIN_TABLE_PT).toBeLessThanOrEqual(
      GENERATED_DOCUMENT_MIN_BODY_PT,
    );
    expect(GENERATED_DOCUMENT_LAYOUT_RULE).toContain(
      `${GENERATED_DOCUMENT_MIN_BODY_PT}`,
    );
    expect(GENERATED_DOCUMENT_LAYOUT_RULE).toContain(
      `${GENERATED_DOCUMENT_MIN_TABLE_PT}`,
    );
  });

  it('reaches the answering model whenever the interpreter is offered', () => {
    expect(CODE_INTERPRETER_PROMPT_SECTION).toContain(
      GENERATED_DOCUMENT_LAYOUT_RULE,
    );
  });
});
