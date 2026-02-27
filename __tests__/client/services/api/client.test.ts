import { ApiClient } from '@/client/services/api/client';
import { ApiError } from '@/client/services/api/errors';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the cookie cleanup module
vi.mock('@/lib/utils/client/auth/cookieCleanup', () => ({
  COOKIE_ERROR_CODES: {
    HEADERS_TOO_LARGE: 'HeadersTooLarge',
  },
}));

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('ApiClient', () => {
  let client: ApiClient;
  let originalWindow: typeof globalThis.window;
  let mockLocationHref: string;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new ApiClient();

    // Store original window
    originalWindow = global.window;

    // Mock window.location for 431 redirect tests
    mockLocationHref = '';
    // @ts-expect-error - mocking window for tests
    global.window = {
      location: {
        get href() {
          return mockLocationHref;
        },
        set href(value: string) {
          mockLocationHref = value;
        },
      },
    };
  });

  afterEach(() => {
    // Restore original window
    global.window = originalWindow;
  });

  describe('constructor', () => {
    it('should create client with default values', () => {
      const defaultClient = new ApiClient();

      expect(defaultClient).toBeInstanceOf(ApiClient);
    });

    it('should create client with custom baseURL', () => {
      const customClient = new ApiClient('https://api.example.com');

      expect(customClient).toBeInstanceOf(ApiClient);
    });

    it('should create client with custom timeout', () => {
      const customClient = new ApiClient('', 30000);

      expect(customClient).toBeInstanceOf(ApiClient);
    });
  });

  describe('GET requests', () => {
    it('should make a successful GET request', async () => {
      const mockData = { id: 1, name: 'Test' };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockData,
        headers: new Headers(),
      });

      const result = await client.get('/api/test');

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/test',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        }),
      );
      expect(result).toEqual(mockData);
    });

    it('should handle GET request with custom headers', async () => {
      const mockData = { success: true };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockData,
        headers: new Headers(),
      });

      await client.get('/api/test', {
        headers: { 'X-Custom-Header': 'value' },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/test',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'X-Custom-Header': 'value',
          }),
        }),
      );
    });

    it('should handle GET request with AbortSignal', async () => {
      const mockData = { success: true };
      const abortController = new AbortController();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockData,
        headers: new Headers(),
      });

      await client.get('/api/test', {
        signal: abortController.signal,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/test',
        expect.objectContaining({
          signal: abortController.signal,
        }),
      );
    });
  });

  describe('POST requests', () => {
    it('should make a successful POST request', async () => {
      const requestData = { name: 'Test', value: 123 };
      const mockResponse = { success: true, id: 1 };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
        headers: new Headers(),
      });

      const result = await client.post('/api/test', requestData);

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/test',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify(requestData),
        }),
      );
      expect(result).toEqual(mockResponse);
    });

    it('should handle POST request without body', async () => {
      const mockResponse = { success: true };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
        headers: new Headers(),
      });

      await client.post('/api/test');

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/test',
        expect.objectContaining({
          method: 'POST',
        }),
      );
    });

    it('should handle POST request with string body', async () => {
      const mockResponse = { success: true };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
        headers: new Headers(),
      });

      await client.post('/api/test', 'raw string data');

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/test',
        expect.objectContaining({
          method: 'POST',
          body: 'raw string data',
        }),
      );
    });
  });

  describe('PUT requests', () => {
    it('should make a successful PUT request', async () => {
      const requestData = { id: 1, name: 'Updated' };
      const mockResponse = { success: true };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
        headers: new Headers(),
      });

      const result = await client.put('/api/test/1', requestData);

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/test/1',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify(requestData),
        }),
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('PATCH requests', () => {
    it('should make a successful PATCH request', async () => {
      const requestData = { name: 'Patched' };
      const mockResponse = { success: true };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
        headers: new Headers(),
      });

      const result = await client.patch('/api/test/1', requestData);

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/test/1',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify(requestData),
        }),
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('DELETE requests', () => {
    it('should make a successful DELETE request', async () => {
      const mockResponse = { success: true };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
        headers: new Headers(),
      });

      const result = await client.delete('/api/test/1');

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/test/1',
        expect.objectContaining({
          method: 'DELETE',
        }),
      );
      expect(result).toEqual(mockResponse);
    });
  });

  describe('postStream', () => {
    it('should return a ReadableStream for streaming responses', async () => {
      const mockStream = new ReadableStream();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: mockStream,
      });

      const result = await client.postStream('/api/stream', { data: 'test' });

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/stream',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ data: 'test' }),
        }),
      );
      expect(result).toBe(mockStream);
    });

    it('should throw ApiError if response has no body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: null,
      });

      await expect(client.postStream('/api/stream', {})).rejects.toThrow(
        ApiError,
      );
    });

    it('should handle streaming errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => ({ error: 'Streaming failed' }),
      });

      await expect(
        client.postStream('/api/stream', { data: 'test' }),
      ).rejects.toThrow(ApiError);
    });
  });

  describe('431 header too large handling', () => {
    it('should redirect to signin with HeadersTooLarge error on 431 response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 431,
        statusText: 'Request Header Fields Too Large',
        json: async () => ({ message: 'Headers too large' }),
      });

      await expect(client.get('/api/test')).rejects.toThrow(ApiError);

      // Should redirect to signin with error param
      expect(mockLocationHref).toBe('/signin?error=HeadersTooLarge');
    });

    it('should throw ApiError with correct status and message on 431', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 431,
        statusText: 'Request Header Fields Too Large',
        json: async () => ({ message: 'Headers too large' }),
      });

      try {
        await client.get('/api/test');
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        const apiError = error as ApiError;
        expect(apiError.status).toBe(431);
        expect(apiError.message).toBe(
          'Request headers too large - please clear session data',
        );
        expect(apiError.statusText).toBe('Request Header Fields Too Large');
        expect(apiError.isHeaderTooLargeError()).toBe(true);
      }
    });

    it('should handle 431 in SSR environment (no window)', async () => {
      // Remove window to simulate SSR
      // @ts-expect-error - removing window for test
      delete global.window;

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 431,
        statusText: 'Request Header Fields Too Large',
        json: async () => ({ message: 'Headers too large' }),
      });

      // Should still throw error but not crash
      await expect(client.get('/api/test')).rejects.toThrow(ApiError);
    });

    it('should handle 431 in postStream method', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 431,
        statusText: 'Request Header Fields Too Large',
        json: async () => ({ message: 'Headers too large' }),
      });

      await expect(client.postStream('/api/stream', {})).rejects.toThrow(
        ApiError,
      );
      expect(mockLocationHref).toBe('/signin?error=HeadersTooLarge');
    });
  });

  describe('error handling', () => {
    it('should throw ApiError for 404 response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({ error: 'Resource not found' }),
      });

      try {
        await client.get('/api/missing');
        // Should not reach here
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).status).toBe(404);
        expect((error as ApiError).message).toBe('Resource not found');
      }
    });

    it('should throw ApiError for 500 response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => ({ message: 'Server error' }),
      });

      try {
        await client.get('/api/error');
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).status).toBe(500);
        expect((error as ApiError).message).toBe('Server error');
      }
    });

    it('should handle error response with no JSON body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        json: async () => {
          throw new Error('Not JSON');
        },
      });

      try {
        await client.get('/api/unavailable');
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).status).toBe(503);
        expect((error as ApiError).message).toBe('Service Unavailable');
      }
    });

    it('should wrap network errors in ApiError', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network failure'));

      try {
        await client.get('/api/test');
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).status).toBe(0);
        expect((error as ApiError).message).toBe('Network failure');
        expect((error as ApiError).statusText).toBe('Network Error');
      }
    });

    it('should handle unknown error types', async () => {
      mockFetch.mockRejectedValueOnce('Unknown error');

      try {
        await client.get('/api/test');
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).message).toBe('Unknown error occurred');
      }
    });
  });

  describe('empty responses', () => {
    it('should handle 204 No Content response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        headers: new Headers(),
      });

      const result = await client.delete('/api/test/1');

      expect(result).toEqual({});
    });

    it('should handle response with Content-Length 0', async () => {
      const headers = new Headers();
      headers.set('Content-Length', '0');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers,
      });

      const result = await client.get('/api/test');

      expect(result).toEqual({});
    });
  });

  describe('URL building', () => {
    it('should handle relative URLs', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
        headers: new Headers(),
      });

      await client.get('/api/test');

      expect(mockFetch).toHaveBeenCalledWith('/api/test', expect.any(Object));
    });

    it('should handle URLs without leading slash', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
        headers: new Headers(),
      });

      await client.get('api/test');

      expect(mockFetch).toHaveBeenCalledWith('/api/test', expect.any(Object));
    });

    it('should handle absolute URLs', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
        headers: new Headers(),
      });

      await client.get('https://external.api.com/data');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://external.api.com/data',
        expect.any(Object),
      );
    });

    it('should combine baseURL with relative URLs', async () => {
      const customClient = new ApiClient('https://api.example.com');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
        headers: new Headers(),
      });

      await customClient.get('/test');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/test',
        expect.any(Object),
      );
    });

    it('should handle baseURL with trailing slash', async () => {
      const customClient = new ApiClient('https://api.example.com/');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
        headers: new Headers(),
      });

      await customClient.get('/test');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/test',
        expect.any(Object),
      );
    });
  });

  describe('type safety', () => {
    it('should support generic type parameter for responses', async () => {
      interface User {
        id: number;
        name: string;
      }

      const mockUser: User = { id: 1, name: 'John' };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockUser,
        headers: new Headers(),
      });

      const result = await client.get<User>('/api/user/1');

      // TypeScript should infer result as User type
      expect(result.id).toBe(1);
      expect(result.name).toBe('John');
    });

    it('should support generic type parameter for POST requests', async () => {
      interface CreateUserRequest {
        name: string;
        email: string;
      }

      interface CreateUserResponse {
        id: number;
        name: string;
        email: string;
      }

      const mockResponse: CreateUserResponse = {
        id: 1,
        name: 'John',
        email: 'john@example.com',
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => mockResponse,
        headers: new Headers(),
      });

      const requestData: CreateUserRequest = {
        name: 'John',
        email: 'john@example.com',
      };

      const result = await client.post<CreateUserResponse>(
        '/api/users',
        requestData,
      );

      expect(result.id).toBe(1);
      expect(result.name).toBe('John');
      expect(result.email).toBe('john@example.com');
    });
  });

  describe('error response details', () => {
    it('should preserve error response data', async () => {
      const errorResponse = {
        error: 'Validation failed',
        details: {
          field: 'email',
          message: 'Invalid email format',
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: async () => errorResponse,
      });

      try {
        await client.post('/api/users', { email: 'invalid' });
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        const apiError = error as ApiError;
        expect(apiError.response).toEqual(errorResponse);
        expect(apiError.response.details.field).toBe('email');
      }
    });
  });
});
