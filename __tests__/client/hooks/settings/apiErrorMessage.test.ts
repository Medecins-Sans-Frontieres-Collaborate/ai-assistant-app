/**
 * `details` on a failed API body is `ApiErrorDetails` — string OR JSON
 * object (lib/utils/server/api/apiResponse.ts). The hooks that surface it as
 * an Error message must never hand React "[object Object]".
 */
import { apiErrorMessage } from '@/client/hooks/settings/useAgentAccessAdmin';

import { describe, expect, it } from 'vitest';

describe('apiErrorMessage', () => {
  it('prefers a string details over the error message', () => {
    expect(
      apiErrorMessage(
        { error: 'Bad request', details: 'admins[0] invalid' },
        'x',
      ),
    ).toBe('admins[0] invalid');
  });

  it('falls back to error when details is a structured object', () => {
    expect(
      apiErrorMessage(
        { error: 'Targets refused', details: { outOfScope: ['a@b.org'] } },
        'x',
      ),
    ).toBe('Targets refused');
  });

  it('falls back to the caller message for empty, null, or non-object bodies', () => {
    expect(apiErrorMessage(null, 'Failed (500)')).toBe('Failed (500)');
    expect(apiErrorMessage('oops', 'Failed (500)')).toBe('Failed (500)');
    expect(apiErrorMessage({}, 'Failed (500)')).toBe('Failed (500)');
    expect(apiErrorMessage({ error: '', details: '' }, 'Failed (500)')).toBe(
      'Failed (500)',
    );
    expect(apiErrorMessage({ details: { a: 1 } }, 'Failed (500)')).toBe(
      'Failed (500)',
    );
  });
});
