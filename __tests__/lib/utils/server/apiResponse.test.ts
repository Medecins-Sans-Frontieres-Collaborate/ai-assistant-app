import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  handleApiError,
  notFoundResponse,
  payloadTooLargeResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/apiResponse';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('apiResponse', () => {
  let consoleErrorSpy: any;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe('errorResponse', () => {
    it('should create error response with string message', async () => {
      const response = errorResponse('Something went wrong');
      const json = await response.json();

      expect(response.status).toBe(500);
      expect(json).toEqual({
        error: 'Something went wrong',
      });
    });

    it('should create error response with Error object', async () => {
      const error = new Error('Test error');
      const response = errorResponse(error);
      const json = await response.json();

      expect(response.status).toBe(500);
      expect(json).toEqual({
        error: 'Test error',
      });
    });

    it('should use custom status code', async () => {
      const response = errorResponse('Not found', 404);
      expect(response.status).toBe(404);
    });

    it('should include optional details', async () => {
      const response = errorResponse(
        'Validation failed',
        400,
        'Email is required',
      );
      const json = await response.json();

      expect(json).toEqual({
        error: 'Validation failed',
        details: 'Email is required',
      });
    });

    it('should include optional error code', async () => {
      const response = errorResponse(
        'Unauthorized',
        401,
        undefined,
        'AUTH_FAILED',
      );
      const json = await response.json();

      expect(json).toEqual({
        error: 'Unauthorized',
        code: 'AUTH_FAILED',
      });
    });

    it('should include both details and code', async () => {
      const response = errorResponse(
        'Access denied',
        403,
        'Insufficient permissions',
        'FORBIDDEN',
      );
      const json = await response.json();

      expect(json).toEqual({
        error: 'Access denied',
        details: 'Insufficient permissions',
        code: 'FORBIDDEN',
      });
    });

    it('should not include details or code if not provided', async () => {
      const response = errorResponse('Simple error');
      const json = await response.json();

      expect(json).not.toHaveProperty('details');
      expect(json).not.toHaveProperty('code');
      expect(Object.keys(json)).toEqual(['error']);
    });
  });

  describe('successResponse', () => {
    it('should create success response with data', async () => {
      const data = { user: { id: 1, name: 'John' } };
      const response = successResponse(data);
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(json).toEqual({
        success: true,
        data: { user: { id: 1, name: 'John' } },
      });
    });

    it('should create success response with message', async () => {
      const response = successResponse(undefined, 'Operation completed');
      const json = await response.json();

      expect(json).toEqual({
        success: true,
        message: 'Operation completed',
      });
    });

    it('should create success response with custom status', async () => {
      const response = successResponse({ id: 123 }, 'Created', 201);
      expect(response.status).toBe(201);
    });

    it('should include both data and message', async () => {
      const response = successResponse({ id: 1 }, 'User created');
      const json = await response.json();

      expect(json).toEqual({
        success: true,
        data: { id: 1 },
        message: 'User created',
      });
    });

    it('should handle null data', async () => {
      const response = successResponse(null, 'Deleted');
      const json = await response.json();

      expect(json).toEqual({
        success: true,
        data: null,
        message: 'Deleted',
      });
    });

    it('should handle empty object data', async () => {
      const response = successResponse({});
      const json = await response.json();

      expect(json).toEqual({
        success: true,
        data: {},
      });
    });

    it('should handle array data', async () => {
      const response = successResponse([1, 2, 3]);
      const json = await response.json();

      expect(json).toEqual({
        success: true,
        data: [1, 2, 3],
      });
    });

    it('should not include data field if undefined', async () => {
      const response = successResponse();
      const json = await response.json();

      expect(json).toEqual({
        success: true,
      });
      expect(json).not.toHaveProperty('data');
    });

    it('should not include message if not provided', async () => {
      const response = successResponse({ id: 1 });
      const json = await response.json();

      expect(json).not.toHaveProperty('message');
    });
  });

  describe('unauthorizedResponse', () => {
    it('should create 401 response with default message', async () => {
      const response = unauthorizedResponse();
      const json = await response.json();

      expect(response.status).toBe(401);
      expect(json).toEqual({
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
      });
    });

    it('should create 401 response with custom message', async () => {
      const response = unauthorizedResponse('Invalid token');
      const json = await response.json();

      expect(json).toEqual({
        error: 'Invalid token',
        code: 'UNAUTHORIZED',
      });
    });

    it('should include details', async () => {
      const response = unauthorizedResponse(
        'Session expired',
        'Please log in again',
      );
      const json = await response.json();

      expect(json).toEqual({
        error: 'Session expired',
        details: 'Please log in again',
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('badRequestResponse', () => {
    it('should create 400 response', async () => {
      const response = badRequestResponse('Invalid input');
      const json = await response.json();

      expect(response.status).toBe(400);
      expect(json).toEqual({
        error: 'Invalid input',
        code: 'BAD_REQUEST',
      });
    });

    it('should include details', async () => {
      const response = badRequestResponse(
        'Validation error',
        'Email must be valid',
      );
      const json = await response.json();

      expect(json).toEqual({
        error: 'Validation error',
        details: 'Email must be valid',
        code: 'BAD_REQUEST',
      });
    });
  });

  describe('notFoundResponse', () => {
    it('should create 404 response', async () => {
      const response = notFoundResponse('User');
      const json = await response.json();

      expect(response.status).toBe(404);
      expect(json).toEqual({
        error: 'User not found',
        code: 'NOT_FOUND',
      });
    });

    it('should include details', async () => {
      const response = notFoundResponse('File', 'ID: 12345');
      const json = await response.json();

      expect(json).toEqual({
        error: 'File not found',
        details: 'ID: 12345',
        code: 'NOT_FOUND',
      });
    });
  });

  describe('forbiddenResponse', () => {
    it('should create 403 response with default message', async () => {
      const response = forbiddenResponse();
      const json = await response.json();

      expect(response.status).toBe(403);
      expect(json).toEqual({
        error: 'Access denied',
        code: 'FORBIDDEN',
      });
    });

    it('should create 403 response with custom message', async () => {
      const response = forbiddenResponse('Admin access required');
      const json = await response.json();

      expect(json).toEqual({
        error: 'Admin access required',
        code: 'FORBIDDEN',
      });
    });

    it('should include details', async () => {
      const response = forbiddenResponse(
        'Cannot modify resource',
        'You are not the owner',
      );
      const json = await response.json();

      expect(json).toEqual({
        error: 'Cannot modify resource',
        details: 'You are not the owner',
        code: 'FORBIDDEN',
      });
    });
  });

  describe('payloadTooLargeResponse', () => {
    it('should create 413 response', async () => {
      const response = payloadTooLargeResponse('10MB');
      const json = await response.json();

      expect(response.status).toBe(413);
      expect(json).toEqual({
        error: 'Payload exceeds maximum size of 10MB',
        code: 'PAYLOAD_TOO_LARGE',
      });
    });

    it('should include details', async () => {
      const response = payloadTooLargeResponse('5MB', 'Current size: 7MB');
      const json = await response.json();

      expect(json).toEqual({
        error: 'Payload exceeds maximum size of 5MB',
        details: 'Current size: 7MB',
        code: 'PAYLOAD_TOO_LARGE',
      });
    });
  });

  describe('handleApiError', () => {
    it('should handle Error object', async () => {
      const error = new Error('Database connection failed');
      const response = handleApiError(error);
      const json = await response.json();

      expect(response.status).toBe(500);
      expect(json).toEqual({
        error: 'Database connection failed',
      });
      expect(consoleErrorSpy).toHaveBeenCalledWith('API Error:', error);
    });

    it('should use error status if available', async () => {
      const error: any = new Error('Not found');
      error.status = 404;
      const response = handleApiError(error);

      expect(response.status).toBe(404);
    });

    it('should use error statusCode if available', async () => {
      const error: any = new Error('Validation failed');
      error.statusCode = 422;
      const response = handleApiError(error);

      expect(response.status).toBe(422);
    });

    it('should prefer status over statusCode', async () => {
      const error: any = new Error('Conflict');
      error.status = 409;
      error.statusCode = 400;
      const response = handleApiError(error);

      expect(response.status).toBe(409);
    });

    it('should handle non-Error objects with default message', async () => {
      const response = handleApiError('String error');
      const json = await response.json();

      expect(response.status).toBe(500);
      expect(json).toEqual({
        error: 'An unexpected error occurred',
      });
    });

    it('should handle null error', async () => {
      const response = handleApiError(null);
      const json = await response.json();

      expect(response.status).toBe(500);
      expect(json).toEqual({
        error: 'An unexpected error occurred',
      });
    });

    it('should handle undefined error', async () => {
      const response = handleApiError(undefined);
      const json = await response.json();

      expect(response.status).toBe(500);
      expect(json).toEqual({
        error: 'An unexpected error occurred',
      });
    });

    it('should use custom default message', async () => {
      const response = handleApiError(null, 'Custom error message');
      const json = await response.json();

      expect(json).toEqual({
        error: 'Custom error message',
      });
    });

    it('should log all error types', () => {
      handleApiError(new Error('test'));
      handleApiError('string error');
      handleApiError({ custom: 'object' });

      expect(consoleErrorSpy).toHaveBeenCalledTimes(3);
    });
  });

  describe('Response type checking', () => {
    it('should return NextResponse instances', () => {
      const responses = [
        errorResponse('test'),
        successResponse({ data: 'test' }),
        unauthorizedResponse(),
        badRequestResponse('test'),
        notFoundResponse('Resource'),
        forbiddenResponse(),
        payloadTooLargeResponse('10MB'),
        handleApiError(new Error('test')),
      ];

      responses.forEach((response) => {
        expect(response).toHaveProperty('status');
        expect(response).toHaveProperty('headers');
        expect(typeof response.json).toBe('function');
      });
    });
  });

  describe('Complex scenarios', () => {
    it('should handle nested data structures', async () => {
      const complexData = {
        user: {
          id: 1,
          profile: {
            name: 'John',
            settings: {
              theme: 'dark',
              notifications: true,
            },
          },
        },
        metadata: {
          timestamp: '2024-01-01',
        },
      };

      const response = successResponse(complexData);
      const json = await response.json();

      expect(json.data).toEqual(complexData);
    });

    it('should handle error with long message', async () => {
      const longMessage = 'A'.repeat(1000);
      const response = errorResponse(longMessage);
      const json = await response.json();

      expect(json.error.length).toBe(1000);
    });

    it('should handle special characters in messages', async () => {
      const message = 'Error: "Invalid" input with \\backslash and \nnewline';
      const response = errorResponse(message);
      const json = await response.json();

      expect(json.error).toBe(message);
    });
  });
});
