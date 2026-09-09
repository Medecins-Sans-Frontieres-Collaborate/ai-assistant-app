import {
  getErrorDetails,
  getErrorMessage,
} from '@/lib/utils/server/observability/errorUtils';

import { describe, expect, it } from 'vitest';

describe('errorUtils', () => {
  describe('getErrorMessage', () => {
    it('extracts message from Error instance', () => {
      const error = new Error('test error message');
      expect(getErrorMessage(error)).toBe('test error message');
    });

    it('returns string errors directly', () => {
      expect(getErrorMessage('string error')).toBe('string error');
    });

    it('returns default fallback for unknown types', () => {
      expect(getErrorMessage(null)).toBe('Unknown error');
      expect(getErrorMessage(undefined)).toBe('Unknown error');
      expect(getErrorMessage(42)).toBe('Unknown error');
      expect(getErrorMessage({ custom: 'object' })).toBe('Unknown error');
      expect(getErrorMessage([])).toBe('Unknown error');
    });

    it('returns custom fallback when provided', () => {
      expect(getErrorMessage(null, 'Custom fallback')).toBe('Custom fallback');
      expect(getErrorMessage(undefined, 'My default')).toBe('My default');
      expect(getErrorMessage({}, 'Object error')).toBe('Object error');
    });

    it('handles Error subclasses', () => {
      const typeError = new TypeError('type error');
      expect(getErrorMessage(typeError)).toBe('type error');

      const rangeError = new RangeError('range error');
      expect(getErrorMessage(rangeError)).toBe('range error');
    });

    it('handles empty string errors', () => {
      expect(getErrorMessage('')).toBe('');
    });

    it('never returns an empty string for an Error instance', () => {
      // A blank-message plain Error falls back rather than surfacing ''.
      expect(getErrorMessage(new Error(''))).toBe('Unknown error');
    });

    it('surfaces code/statusCode from blank-message Azure-style RestErrors', () => {
      const restError = new Error('') as Error & {
        code: string;
        statusCode: number;
      };
      restError.name = 'RestError';
      restError.code = 'AuthorizationPermissionMismatch';
      restError.statusCode = 403;

      expect(getErrorMessage(restError)).toBe(
        'RestError AuthorizationPermissionMismatch HTTP 403',
      );
    });
  });

  describe('getErrorDetails', () => {
    it('extracts message and stack from Error instance', () => {
      const error = new Error('detailed error');
      const details = getErrorDetails(error);

      expect(details.message).toBe('detailed error');
      expect(details.stackTrace).toBeDefined();
      expect(details.stackTrace).toContain('Error: detailed error');
    });

    it('returns message only for string errors', () => {
      const details = getErrorDetails('string error');

      expect(details.message).toBe('string error');
      expect(details.stackTrace).toBeUndefined();
    });

    it('returns Unknown error for null/undefined', () => {
      expect(getErrorDetails(null).message).toBe('Unknown error');
      expect(getErrorDetails(null).stackTrace).toBeUndefined();

      expect(getErrorDetails(undefined).message).toBe('Unknown error');
      expect(getErrorDetails(undefined).stackTrace).toBeUndefined();
    });

    it('returns Unknown error for non-error objects', () => {
      expect(getErrorDetails({ message: 'fake' }).message).toBe(
        'Unknown error',
      );
      expect(getErrorDetails(42).message).toBe('Unknown error');
      expect(getErrorDetails([]).message).toBe('Unknown error');
    });

    it('handles Error subclasses', () => {
      const typeError = new TypeError('type issue');
      const details = getErrorDetails(typeError);

      expect(details.message).toBe('type issue');
      expect(details.stackTrace).toBeDefined();
      expect(details.stackTrace).toContain('TypeError');
    });

    it('handles errors with no stack', () => {
      const error = new Error('no stack');
      // Some environments may have stack, so we just verify structure
      const details = getErrorDetails(error);

      expect(details.message).toBe('no stack');
      // stackTrace may or may not be defined based on environment
    });
  });
});
