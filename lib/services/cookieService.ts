/**
 * Cookie Management Service
 *
 * Centralized service for handling browser cookies with type safety
 */
import { UI_CONSTANTS } from '@/lib/constants/ui';

export interface CookieOptions {
  /** Number of days until cookie expires */
  expiryDays?: number;
  /** Cookie path (default: '/') */
  path?: string;
  /** SameSite attribute */
  sameSite?: 'Strict' | 'Lax' | 'None';
  /** Secure attribute (only send over HTTPS) */
  secure?: boolean;
}

/**
 * Cookie Service
 * Provides type-safe methods for managing browser cookies
 */
export class CookieService {
  /**
   * Set a cookie with the specified options
   */
  static setCookie(
    name: string,
    value: string,
    options: CookieOptions = {},
  ): void {
    const {
      expiryDays = UI_CONSTANTS.COOKIE.DEFAULT_EXPIRY_DAYS,
      path = '/',
      sameSite = 'Lax',
      secure = false,
    } = options;

    const expires = new Date();
    expires.setTime(expires.getTime() + expiryDays * 24 * 60 * 60 * 1000);

    const cookieParts = [
      `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
      `expires=${expires.toUTCString()}`,
      `path=${path}`,
      `SameSite=${sameSite}`,
    ];

    if (secure) {
      cookieParts.push('Secure');
    }

    document.cookie = cookieParts.join('; ');
  }

  /**
   * Get a cookie value by name
   */
  static getCookie(name: string): string | null {
    if (typeof document === 'undefined') {
      return null; // Server-side rendering
    }

    const nameEQ = encodeURIComponent(name) + '=';
    const cookies = document.cookie.split(';');

    for (let cookie of cookies) {
      cookie = cookie.trim();
      if (cookie.indexOf(nameEQ) === 0) {
        return decodeURIComponent(cookie.substring(nameEQ.length));
      }
    }

    return null;
  }

  /**
   * Delete a cookie by name
   */
  static deleteCookie(name: string, path: string = '/'): void {
    document.cookie = `${encodeURIComponent(name)}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=${path}; SameSite=Lax`;
  }

  /**
   * Check if a cookie exists
   */
  static hasCookie(name: string): boolean {
    return this.getCookie(name) !== null;
  }

  /**
   * Get all cookies as a key-value object
   */
  static getAllCookies(): Record<string, string> {
    if (typeof document === 'undefined') {
      return {};
    }

    const cookies: Record<string, string> = {};
    const cookieArray = document.cookie.split(';');

    for (let cookie of cookieArray) {
      cookie = cookie.trim();
      const [name, ...valueParts] = cookie.split('=');
      if (name) {
        cookies[decodeURIComponent(name)] = decodeURIComponent(
          valueParts.join('='),
        );
      }
    }

    return cookies;
  }

  /**
   * Set a JSON value as a cookie
   */
  static setJSONCookie<T>(
    name: string,
    value: T,
    options: CookieOptions = {},
  ): void {
    const jsonString = JSON.stringify(value);
    this.setCookie(name, jsonString, options);
  }

  /**
   * Get and parse a JSON cookie
   */
  static getJSONCookie<T>(name: string): T | null {
    const value = this.getCookie(name);
    if (!value) {
      return null;
    }

    try {
      return JSON.parse(value) as T;
    } catch (error) {
      console.error(`Failed to parse JSON cookie "${name}":`, error);
      return null;
    }
  }
}

/**
 * React hook for managing cookies
 */
export function useCookie(
  key: string,
  defaultValue: string = '',
): [string, (value: string, options?: CookieOptions) => void, () => void] {
  // Get initial value
  const getValue = (): string => {
    if (typeof window === 'undefined') {
      return defaultValue;
    }
    return CookieService.getCookie(key) ?? defaultValue;
  };

  // Set cookie value
  const setValue = (value: string, options?: CookieOptions): void => {
    CookieService.setCookie(key, value, options);
  };

  // Delete cookie
  const deleteCookie = (): void => {
    CookieService.deleteCookie(key);
  };

  return [getValue(), setValue, deleteCookie];
}
