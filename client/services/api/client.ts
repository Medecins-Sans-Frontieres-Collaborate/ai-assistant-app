'use client';

import { ApiError } from './errors';
import { ApiRequestConfig } from './types';

/**
 * Centralized API client for making HTTP requests.
 *
 * Features:
 * - Request/response interceptors
 * - Automatic error handling
 * - Type-safe request/response handling
 * - Streaming support
 * - Timeout configuration
 *
 * Usage:
 * ```ts
 * const response = await apiClient.post<ChatApiResponse>('/api/chat', {
 *   model,
 *   messages,
 * });
 * ```
 */
export class ApiClient {
  private baseURL: string;
  private defaultTimeout: number;

  constructor(baseURL: string = '', defaultTimeout: number = 120000) {
    this.baseURL = baseURL;
    this.defaultTimeout = defaultTimeout;
  }

  /**
   * Makes a GET request.
   */
  public async get<T = any>(
    url: string,
    config?: ApiRequestConfig,
  ): Promise<T> {
    return this.request<T>(url, { ...config, method: 'GET' });
  }

  /**
   * Makes a POST request.
   */
  public async post<T = any>(
    url: string,
    data?: any,
    config?: ApiRequestConfig,
  ): Promise<T> {
    return this.request<T>(url, {
      ...config,
      method: 'POST',
      body: data,
    });
  }

  /**
   * Makes a PUT request.
   */
  public async put<T = any>(
    url: string,
    data?: any,
    config?: ApiRequestConfig,
  ): Promise<T> {
    return this.request<T>(url, {
      ...config,
      method: 'PUT',
      body: data,
    });
  }

  /**
   * Makes a PATCH request.
   */
  public async patch<T = any>(
    url: string,
    data?: any,
    config?: ApiRequestConfig,
  ): Promise<T> {
    return this.request<T>(url, {
      ...config,
      method: 'PATCH',
      body: data,
    });
  }

  /**
   * Makes a DELETE request.
   */
  public async delete<T = any>(
    url: string,
    config?: ApiRequestConfig,
  ): Promise<T> {
    return this.request<T>(url, { ...config, method: 'DELETE' });
  }

  /**
   * Makes a streaming POST request.
   *
   * Returns a ReadableStream for processing Server-Sent Events.
   */
  public async postStream(
    url: string,
    data?: any,
    config?: ApiRequestConfig,
  ): Promise<ReadableStream<Uint8Array>> {
    const fullUrl = this.buildUrl(url);
    const requestConfig = this.buildRequestConfig({ ...config, body: data });

    const response = await fetch(fullUrl, {
      ...requestConfig,
      method: 'POST',
    });

    if (!response.ok) {
      await this.handleErrorResponse(response);
    }

    if (!response.body) {
      throw new ApiError(
        'Response body is null',
        response.status,
        response.statusText,
      );
    }

    return response.body;
  }

  /**
   * Core request method.
   */
  private async request<T>(url: string, config: ApiRequestConfig): Promise<T> {
    const fullUrl = this.buildUrl(url);
    const requestConfig = this.buildRequestConfig(config);

    try {
      const response = await fetch(fullUrl, requestConfig);

      if (!response.ok) {
        await this.handleErrorResponse(response);
      }

      // Handle empty responses (204 No Content, etc.)
      if (
        response.status === 204 ||
        response.headers.get('Content-Length') === '0'
      ) {
        return {} as T;
      }

      // Parse JSON response
      const data = await response.json();
      return data as T;
    } catch (error) {
      // Re-throw ApiErrors as-is
      if (error instanceof ApiError) {
        throw error;
      }

      // Wrap other errors
      if (error instanceof Error) {
        throw new ApiError(error.message, 0, 'Network Error');
      }

      throw new ApiError('Unknown error occurred', 0, 'Unknown Error');
    }
  }

  /**
   * Builds the full URL.
   */
  private buildUrl(url: string): string {
    // If URL is absolute, return as-is
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }

    // Combine baseURL with relative URL
    const base = this.baseURL.endsWith('/')
      ? this.baseURL.slice(0, -1)
      : this.baseURL;
    const path = url.startsWith('/') ? url : `/${url}`;

    return `${base}${path}`;
  }

  /**
   * Builds fetch request configuration.
   */
  private buildRequestConfig(config: ApiRequestConfig): RequestInit {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...config.headers,
    };

    const requestConfig: RequestInit = {
      method: config.method || 'GET',
      headers,
    };

    // Add body if present
    if (config.body !== undefined) {
      if (typeof config.body === 'string') {
        requestConfig.body = config.body;
      } else {
        requestConfig.body = JSON.stringify(config.body);
      }
    }

    // Add abort signal if present
    if (config.signal) {
      requestConfig.signal = config.signal;
    }

    return requestConfig;
  }

  /**
   * Handles error responses.
   */
  private async handleErrorResponse(response: Response): Promise<never> {
    let errorData: any;

    try {
      errorData = await response.json();
    } catch {
      // If JSON parsing fails, use status text
      errorData = { message: response.statusText };
    }

    const message = errorData.message || errorData.error || 'An error occurred';

    throw new ApiError(
      message,
      response.status,
      response.statusText,
      errorData,
    );
  }
}

// Export singleton instance
export const apiClient = new ApiClient();
