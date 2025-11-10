/**
 * API Routes Configuration
 * Centralized API endpoint definitions for type-safe route access
 */

export const API_ROUTES = {
  /**
   * Chat-related endpoints
   */
  CHAT: {
    /** Unified chat endpoint (handles all chat types) */
    UNIFIED: '/api/chat',
    /** Agent validation endpoint */
    VALIDATE_AGENT: '/api/chat/agents/validate',
    /** Prompt revision endpoint */
    REVISE_PROMPT: '/api/chat/prompts/revise',
    /** Tone analysis endpoint */
    ANALYZE_TONE: '/api/chat/tones/analyze',
  },

  /**
   * File management endpoints
   */
  FILE: {
    UPLOAD: '/api/file/upload',
    /** Get file by ID */
    GET: (id: string) => `/api/file/${id}` as const,
    /** Delete file by ID */
    DELETE: (id: string) => `/api/file/${id}` as const,
    /** Transcribe file by ID */
    TRANSCRIBE: (id: string) => `/api/file/${id}/transcribe` as const,
  },

  /**
   * Transcription endpoints
   */
  TRANSCRIPTION: {
    QUEUE: '/api/transcription/queue',
    STATUS: (id: string) => `/api/transcription/${id}/status` as const,
  },

  /**
   * Search endpoints
   */
  SEARCH: {
    QUERY: '/api/search/query',
    INDEX: '/api/search/index',
  },

  /**
   * User management endpoints
   */
  USER: {
    PROFILE: '/api/user/profile',
    PREFERENCES: '/api/user/preferences',
    CONVERSATIONS: '/api/user/conversations',
  },

  /**
   * Agent endpoints
   */
  AGENT: {
    LIST: '/api/agent/list',
    CREATE: '/api/agent/create',
    UPDATE: (id: string) => `/api/agent/${id}` as const,
    DELETE: (id: string) => `/api/agent/${id}` as const,
  },

  /**
   * Prompt endpoints
   */
  PROMPT: {
    LIST: '/api/prompt/list',
    CREATE: '/api/prompt/create',
    UPDATE: (id: string) => `/api/prompt/${id}` as const,
    DELETE: (id: string) => `/api/prompt/${id}` as const,
  },

  /**
   * Tone endpoints
   */
  TONE: {
    LIST: '/api/tone/list',
    CREATE: '/api/tone/create',
    UPDATE: (id: string) => `/api/tone/${id}` as const,
    DELETE: (id: string) => `/api/tone/${id}` as const,
  },

  /**
   * Health and monitoring
   */
  HEALTH: {
    CHECK: '/api/health',
    READY: '/api/health/ready',
    LIVE: '/api/health/live',
  },
} as const;

/**
 * Type helper for API routes
 */
export type ApiRoutes = typeof API_ROUTES;

/**
 * Helper to build query string from params
 */
export function buildQueryString(
  params: Record<string, string | number | boolean | undefined>,
): string {
  const filtered = Object.entries(params)
    .filter(([_, value]) => value !== undefined && value !== null)
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
    )
    .join('&');

  return filtered ? `?${filtered}` : '';
}

/**
 * Helper to build full URL with query params
 */
export function buildApiUrl(
  route: string,
  params?: Record<string, string | number | boolean | undefined>,
): string {
  if (!params) return route;
  return `${route}${buildQueryString(params)}`;
}
