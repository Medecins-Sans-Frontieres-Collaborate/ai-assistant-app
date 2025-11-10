import { NextRequest } from 'next/server';

import { GET } from '@/app/api/user/profile/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock auth
vi.mock('@/auth', () => ({
  auth: vi.fn(),
}));

// Mock global fetch
global.fetch = vi.fn();

describe('GET /api/user/profile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AZURE_TENANT_ID = 'test-tenant-id';
    process.env.AZURE_CLIENT_ID = 'test-client-id';
    process.env.AZURE_CLIENT_SECRET = 'test-client-secret';
  });

  const createMockRequest = () => {
    return new NextRequest('http://localhost:3000/api/user/profile');
  };

  describe('Authentication', () => {
    it('returns 401 when no session', async () => {
      const { auth } = await import('@/auth');
      (vi.mocked(auth) as any).mockResolvedValue(null);

      const request = createMockRequest();
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toBe('Unauthorized');
    });

    it('returns 401 when no user in session', async () => {
      const { auth } = await import('@/auth');
      vi.mocked(auth).mockResolvedValue({ user: null } as any);

      const request = createMockRequest();
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toBe('Unauthorized');
    });

    it('returns 401 when no refresh token', async () => {
      const { auth } = await import('@/auth');
      vi.mocked(auth).mockResolvedValue({
        user: { id: 'test-user' },
        refreshToken: null,
      } as any);

      const request = createMockRequest();
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toBe('No refresh token');
    });
  });

  describe('Token Refresh', () => {
    it('fetches new access token with refresh token', async () => {
      const { auth } = await import('@/auth');
      vi.mocked(auth).mockResolvedValue({
        user: { id: 'test-user' },
        refreshToken: 'test-refresh-token',
      } as any);

      // Mock token refresh response
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'new-access-token' }),
      } as any);

      // Mock Graph API response
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'user-123',
          displayName: 'Test User',
        }),
      } as any);

      // Mock photo response (not found)
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
      } as any);

      const request = createMockRequest();
      await GET(request);

      // Verify token refresh was called
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('login.microsoftonline.com'),
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }),
      );
    });

    it('returns 401 when token refresh fails', async () => {
      const { auth } = await import('@/auth');
      vi.mocked(auth).mockResolvedValue({
        user: { id: 'test-user' },
        refreshToken: 'test-refresh-token',
      } as any);

      // Mock failed token refresh
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
      } as any);

      const request = createMockRequest();
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toBe('Failed to refresh token');
    });

    it('handles token refresh error exception', async () => {
      const { auth } = await import('@/auth');
      vi.mocked(auth).mockResolvedValue({
        user: { id: 'test-user' },
        refreshToken: 'test-refresh-token',
      } as any);

      // Mock token refresh throwing error
      vi.mocked(fetch).mockRejectedValueOnce(new Error('Network error'));

      const request = createMockRequest();
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toBe('Failed to refresh token');
    });
  });

  describe('User Data Fetching', () => {
    it('fetches user data from Microsoft Graph', async () => {
      const { auth } = await import('@/auth');
      vi.mocked(auth).mockResolvedValue({
        user: { id: 'test-user' },
        refreshToken: 'test-refresh-token',
      } as any);

      const mockUserData = {
        id: 'user-123',
        userPrincipalName: 'test@example.com',
        displayName: 'Test User',
        givenName: 'Test',
        surname: 'User',
        department: 'Engineering',
        jobTitle: 'Developer',
        mail: 'test@example.com',
        companyName: 'Test Company',
      };

      // Mock token refresh
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'new-access-token' }),
      } as any);

      // Mock Graph API user data response
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockUserData,
      } as any);

      // Mock photo response (not found)
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
      } as any);

      const request = createMockRequest();
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toMatchObject(mockUserData);
      expect(data.photoUrl).toBeNull();
    });

    it('includes user photo when available', async () => {
      const { auth } = await import('@/auth');
      vi.mocked(auth).mockResolvedValue({
        user: { id: 'test-user' },
        refreshToken: 'test-refresh-token',
      } as any);

      // Mock token refresh
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'new-access-token' }),
      } as any);

      // Mock Graph API user data response
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'user-123',
          displayName: 'Test User',
        }),
      } as any);

      // Mock photo response with binary data
      const mockPhotoData = Buffer.from('fake-image-data');
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'image/jpeg' }),
        arrayBuffer: async () => mockPhotoData,
      } as any);

      const request = createMockRequest();
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.photoUrl).toBeTruthy();
      expect(data.photoUrl).toContain('data:image/jpeg;base64,');
    });

    it('uses correct Graph API endpoint with select parameters', async () => {
      const { auth } = await import('@/auth');
      vi.mocked(auth).mockResolvedValue({
        user: { id: 'test-user' },
        refreshToken: 'test-refresh-token',
      } as any);

      // Mock token refresh
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'new-access-token' }),
      } as any);

      // Mock Graph API user data response
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'user-123' }),
      } as any);

      // Mock photo response (not found)
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
      } as any);

      const request = createMockRequest();
      await GET(request);

      // Verify Graph API was called with correct parameters
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('graph.microsoft.com/v1.0/me?$select='),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer new-access-token',
          }),
        }),
      );
    });

    it('returns 500 when Graph API fails', async () => {
      const { auth } = await import('@/auth');
      vi.mocked(auth).mockResolvedValue({
        user: { id: 'test-user' },
        refreshToken: 'test-refresh-token',
      } as any);

      // Mock token refresh
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'new-access-token' }),
      } as any);

      // Mock Graph API failure
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        statusText: 'Forbidden',
      } as any);

      const request = createMockRequest();
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe('Failed to fetch user profile');
    });
  });

  describe('Photo Handling', () => {
    it('handles missing user photo gracefully', async () => {
      const { auth } = await import('@/auth');
      vi.mocked(auth).mockResolvedValue({
        user: { id: 'test-user' },
        refreshToken: 'test-refresh-token',
      } as any);

      // Mock token refresh
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'new-access-token' }),
      } as any);

      // Mock Graph API user data response
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'user-123' }),
      } as any);

      // Mock photo response (not found)
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
      } as any);

      const request = createMockRequest();
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.photoUrl).toBeNull();
    });

    it('handles photo fetch error without failing request', async () => {
      const { auth } = await import('@/auth');
      vi.mocked(auth).mockResolvedValue({
        user: { id: 'test-user' },
        refreshToken: 'test-refresh-token',
      } as any);

      // Mock token refresh
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'new-access-token' }),
      } as any);

      // Mock Graph API user data response
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'user-123' }),
      } as any);

      // Mock photo fetch throwing error
      vi.mocked(fetch).mockRejectedValueOnce(new Error('Photo error'));

      const request = createMockRequest();
      const response = await GET(request);

      expect(response.status).toBe(200);
    });

    it('correctly encodes photo as base64 data URL', async () => {
      const { auth } = await import('@/auth');
      vi.mocked(auth).mockResolvedValue({
        user: { id: 'test-user' },
        refreshToken: 'test-refresh-token',
      } as any);

      // Mock token refresh
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'new-access-token' }),
      } as any);

      // Mock user data
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'user-123' }),
      } as any);

      // Mock photo with known data
      const photoBuffer = Buffer.from('test-photo-data');
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'image/png' }),
        arrayBuffer: async () => photoBuffer,
      } as any);

      const request = createMockRequest();
      const response = await GET(request);
      const data = await response.json();

      const expectedBase64 = photoBuffer.toString('base64');
      expect(data.photoUrl).toBe(`data:image/png;base64,${expectedBase64}`);
    });
  });

  describe('Error Handling', () => {
    it('returns 500 on unexpected errors', async () => {
      const { auth } = await import('@/auth');
      vi.mocked(auth).mockRejectedValue(new Error('Unexpected error'));

      const request = createMockRequest();
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe('Failed to fetch user profile');
    });
  });
});
