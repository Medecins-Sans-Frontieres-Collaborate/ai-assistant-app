import { CookieService } from '@/lib/services/cookieService';

import {
  COOKIE_ERROR_CODES,
  clearAuthCookies,
} from '@/lib/utils/client/auth/cookieCleanup';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock CookieService
vi.mock('@/lib/services/cookieService', () => ({
  CookieService: {
    getAllCookies: vi.fn(),
    deleteCookie: vi.fn(),
  },
}));

describe('cookieCleanup', () => {
  const mockGetAllCookies = vi.mocked(CookieService.getAllCookies);
  const mockDeleteCookie = vi.mocked(CookieService.deleteCookie);

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock document.cookie for browser environment
    Object.defineProperty(global, 'document', {
      value: {
        cookie: '',
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    // Clean up document mock
    // @ts-expect-error - cleaning up mock
    delete global.document;
  });

  describe('COOKIE_ERROR_CODES', () => {
    it('should have HEADERS_TOO_LARGE error code', () => {
      expect(COOKIE_ERROR_CODES.HEADERS_TOO_LARGE).toBe('HeadersTooLarge');
    });
  });

  describe('clearAuthCookies', () => {
    it('should clear NextAuth v5 (authjs) cookies', () => {
      mockGetAllCookies.mockReturnValue({
        'authjs.session-token': 'token-value',
        'authjs.callback-url': 'callback-value',
        'authjs.csrf-token': 'csrf-value',
        'unrelated-cookie': 'should-not-be-deleted',
      });

      clearAuthCookies();

      // Should delete auth cookies
      expect(mockDeleteCookie).toHaveBeenCalledWith('authjs.session-token');
      expect(mockDeleteCookie).toHaveBeenCalledWith(
        'authjs.session-token',
        '/',
      );
      expect(mockDeleteCookie).toHaveBeenCalledWith('authjs.callback-url');
      expect(mockDeleteCookie).toHaveBeenCalledWith('authjs.callback-url', '/');
      expect(mockDeleteCookie).toHaveBeenCalledWith('authjs.csrf-token');
      expect(mockDeleteCookie).toHaveBeenCalledWith('authjs.csrf-token', '/');

      // Should NOT delete unrelated cookies
      expect(mockDeleteCookie).not.toHaveBeenCalledWith('unrelated-cookie');
      expect(mockDeleteCookie).not.toHaveBeenCalledWith(
        'unrelated-cookie',
        '/',
      );
    });

    it('should clear secure-prefixed authjs cookies', () => {
      mockGetAllCookies.mockReturnValue({
        '__Secure-authjs.session-token': 'secure-token',
        '__Secure-authjs.callback-url': 'secure-callback',
        '__Host-authjs.csrf-token': 'host-csrf',
      });

      clearAuthCookies();

      expect(mockDeleteCookie).toHaveBeenCalledWith(
        '__Secure-authjs.session-token',
      );
      expect(mockDeleteCookie).toHaveBeenCalledWith(
        '__Secure-authjs.callback-url',
      );
      expect(mockDeleteCookie).toHaveBeenCalledWith('__Host-authjs.csrf-token');
    });

    it('should clear legacy NextAuth v4 cookies', () => {
      mockGetAllCookies.mockReturnValue({
        'next-auth.session-token': 'legacy-token',
        'next-auth.callback-url': 'legacy-callback',
        '__Secure-next-auth.session-token': 'secure-legacy',
      });

      clearAuthCookies();

      expect(mockDeleteCookie).toHaveBeenCalledWith('next-auth.session-token');
      expect(mockDeleteCookie).toHaveBeenCalledWith('next-auth.callback-url');
      expect(mockDeleteCookie).toHaveBeenCalledWith(
        '__Secure-next-auth.session-token',
      );
    });

    it('should preserve non-auth cookies', () => {
      mockGetAllCookies.mockReturnValue({
        'ui-prefs': '{"theme":"dark"}',
        NEXT_LOCALE: 'en',
        _ga: 'analytics-id',
        'authjs.session-token': 'should-delete',
      });

      clearAuthCookies();

      // Should NOT call delete for non-auth cookies
      const deletedCookies = mockDeleteCookie.mock.calls.map((call) => call[0]);
      expect(deletedCookies).not.toContain('ui-prefs');
      expect(deletedCookies).not.toContain('NEXT_LOCALE');
      expect(deletedCookies).not.toContain('_ga');

      // Should delete auth cookie
      expect(deletedCookies).toContain('authjs.session-token');
    });

    it('should handle empty cookie list', () => {
      mockGetAllCookies.mockReturnValue({});

      clearAuthCookies();

      expect(mockDeleteCookie).not.toHaveBeenCalled();
    });

    it('should be safe to call in SSR environment (no document)', () => {
      // Remove document mock to simulate SSR
      // @ts-expect-error - cleaning up mock
      delete global.document;

      // Should not throw
      expect(() => clearAuthCookies()).not.toThrow();

      // Should not attempt to delete cookies
      expect(mockDeleteCookie).not.toHaveBeenCalled();
    });
  });
});
