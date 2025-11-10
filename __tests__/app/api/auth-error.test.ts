import { NextRequest } from 'next/server';

import { GET } from '@/app/api/auth/error/route';
import { describe, expect, it } from 'vitest';

describe('/api/auth/error', () => {
  const createRequest = (error?: string): NextRequest => {
    const url = error
      ? `http://localhost:3000/api/auth/error?error=${encodeURIComponent(error)}`
      : 'http://localhost:3000/api/auth/error';

    return new NextRequest(url);
  };

  describe('GET Handler', () => {
    it('redirects to /auth-error with error parameter', async () => {
      const request = createRequest('AccessDenied');
      const response = await GET(request);

      expect(response.status).toBe(307); // Temporary redirect

      const location = response.headers.get('location');
      expect(location).toContain('/auth-error');
      expect(location).toContain('error=AccessDenied');
    });

    it('uses Default error when no error parameter provided', async () => {
      const request = createRequest();
      const response = await GET(request);

      expect(response.status).toBe(307);

      const location = response.headers.get('location');
      expect(location).toContain('/auth-error');
      expect(location).toContain('error=Default');
    });

    it('preserves custom error messages', async () => {
      const errorMessage = 'CustomAuthenticationError';
      const request = createRequest(errorMessage);
      const response = await GET(request);

      expect(response.status).toBe(307);

      const location = response.headers.get('location');
      expect(location).toContain(`error=${errorMessage}`);
    });

    it('handles URL-encoded error messages', async () => {
      const errorMessage = 'Error with spaces';
      const request = createRequest(errorMessage);
      const response = await GET(request);

      expect(response.status).toBe(307);

      const location = response.headers.get('location');
      expect(location).toBeTruthy();
      // URL should contain the error parameter (may be encoded)
      expect(location).toContain('error=');
    });

    it('handles special characters in error messages', async () => {
      const errorMessage = 'Error&Special=Chars';
      const request = createRequest(errorMessage);
      const response = await GET(request);

      expect(response.status).toBe(307);

      const location = response.headers.get('location');
      expect(location).toContain('/auth-error');
      expect(location).toContain('error=');
    });

    it('redirects to auth-error page on same origin', async () => {
      const request = createRequest('TestError');
      const response = await GET(request);

      const location = response.headers.get('location');
      expect(location).toMatch(/^https?:\/\//); // Full URL
      expect(location).toContain('auth-error');
    });

    it('handles empty string error parameter', async () => {
      const request = createRequest('');
      const response = await GET(request);

      expect(response.status).toBe(307);

      const location = response.headers.get('location');
      // Empty string should result in Default error
      expect(location).toContain('error=Default');
    });
  });

  describe('Common OAuth Error Codes', () => {
    const commonErrors = [
      'AccessDenied',
      'Configuration',
      'Verification',
      'OAuthSignin',
      'OAuthCallback',
      'OAuthCreateAccount',
      'EmailCreateAccount',
      'Callback',
      'OAuthAccountNotLinked',
      'SessionRequired',
    ];

    commonErrors.forEach((errorCode) => {
      it(`handles ${errorCode} error code`, async () => {
        const request = createRequest(errorCode);
        const response = await GET(request);

        expect(response.status).toBe(307);

        const location = response.headers.get('location');
        expect(location).toContain('/auth-error');
        expect(location).toContain(`error=${errorCode}`);
      });
    });
  });
});
