import { NextRequest } from 'next/server';

import { authMiddleware } from '@/lib/services/chat/pipeline/Middleware';

import { ErrorCode, PipelineError } from '@/types/errors';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mocks — must be declared before module imports below.
const auth = vi.hoisted(() => vi.fn());
const getAccessTokenForOBO = vi.hoisted(() => vi.fn());

vi.mock('@/auth', () => ({
  auth,
  getAccessTokenForOBO,
}));

// authMiddleware never reads the request — auth() carries the session.
const mockReq = {} as unknown as NextRequest;

describe('authMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws AUTH_FAILED when there is no session at all', async () => {
    auth.mockResolvedValue(null);

    try {
      await authMiddleware(mockReq);
      expect.fail('Should have thrown PipelineError');
    } catch (error) {
      expect(error).toBeInstanceOf(PipelineError);
      expect((error as PipelineError).code).toBe(ErrorCode.AUTH_FAILED);
    }
  });

  it.each(['RefreshAccessTokenError', 'RefreshTokenMissing'])(
    'throws AUTH_SESSION_EXPIRED for a session flagged with %s',
    async (sessionError) => {
      // A rotated client secret leaves the JWT decodable but every token
      // refresh failing — auth() then returns a session carrying `error`.
      auth.mockResolvedValue({
        user: { id: 'user-1' },
        error: sessionError,
      });

      try {
        await authMiddleware(mockReq);
        expect.fail('Should have thrown PipelineError');
      } catch (error) {
        expect(error).toBeInstanceOf(PipelineError);
        const pipelineError = error as PipelineError;
        expect(pipelineError.code).toBe(ErrorCode.AUTH_SESSION_EXPIRED);
        expect(pipelineError.metadata?.sessionError).toBe(sessionError);
      }
    },
  );

  it('passes a healthy session through', async () => {
    const session = { user: { id: 'user-1' } };
    auth.mockResolvedValue(session);

    const result = await authMiddleware(mockReq);

    expect(result).toEqual({ session, user: session.user });
  });
});
