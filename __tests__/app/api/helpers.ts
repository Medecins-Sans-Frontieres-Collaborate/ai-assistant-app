/**
 * Helper utilities for testing Next.js API routes
 */
import { NextRequest } from 'next/server';

/**
 * Create a mock NextRequest for testing
 */
export function createMockRequest(options: {
  method?: string;
  url?: string;
  body?: any;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
}): NextRequest {
  const {
    method = 'GET',
    url = 'http://localhost:3000/api/test',
    body = null,
    headers = {},
    cookies = {},
  } = options;

  const requestInit: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  };

  if (body && method !== 'GET' && method !== 'HEAD') {
    requestInit.body = JSON.stringify(body);
  }

  const request = new NextRequest(url, requestInit as any);

  // Add cookies if provided
  Object.entries(cookies).forEach(([key, value]) => {
    request.cookies.set(key, value);
  });

  return request;
}

/**
 * Parse JSON response from NextResponse
 */
export async function parseJsonResponse(response: Response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Mock session for authenticated routes
 */
export function createMockSession(userId?: string) {
  return {
    user: {
      id: userId || 'test-user-id',
      email: 'test@example.com',
      name: 'Test User',
    },
    expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

/**
 * Mock auth for testing protected routes
 */
export function mockAuth(session: any = null) {
  const actualAuth = vi.hoisted(() => {
    return {
      auth: vi.fn(() => Promise.resolve(session || createMockSession())),
    };
  });

  return actualAuth;
}
