import {
  sanitizeForLog,
  sanitizeForLogMultiple,
} from '@/lib/utils/server/logSanitization';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('logSanitization', () => {
  describe('sanitizeForLog', () => {
    it('should handle null and undefined', () => {
      expect(sanitizeForLog(null)).toBe('null');
      expect(sanitizeForLog(undefined)).toBe('undefined');
    });

    it('should convert primitives to strings', () => {
      expect(sanitizeForLog(123)).toBe('123');
      expect(sanitizeForLog(true)).toBe('true');
      expect(sanitizeForLog(false)).toBe('false');
      expect(sanitizeForLog('hello')).toBe('hello');
    });

    it('should remove newlines and carriage returns', () => {
      expect(sanitizeForLog('hello\nworld')).toBe('hello world');
      expect(sanitizeForLog('hello\r\nworld')).toBe('hello world');
      expect(sanitizeForLog('line1\nline2\nline3')).toBe('line1 line2 line3');
    });

    it('should remove control characters', () => {
      // Test with various control characters
      expect(sanitizeForLog('hello\x00world')).toBe('helloworld');
      expect(sanitizeForLog('hello\x1Bworld')).toBe('helloworld'); // ESC character
      expect(sanitizeForLog('test\x7Fvalue')).toBe('testvalue'); // DEL character
    });

    it('should prevent log injection attacks', () => {
      const maliciousInput =
        'user input\n[ERROR] Fake error message\nusername: admin';
      const sanitized = sanitizeForLog(maliciousInput);
      expect(sanitized).toBe(
        'user input [ERROR] Fake error message username: admin',
      );
      expect(sanitized).not.toContain('\n');
    });

    it('should handle ANSI escape codes', () => {
      const ansiString = '\x1b[31mRed Text\x1b[0m';
      const sanitized = sanitizeForLog(ansiString);
      expect(sanitized).not.toContain('\x1b');
      // The control character removal doesn't strip the visible escape sequences
      // Just verify no actual control characters remain
      expect(sanitized).toContain('Red Text');
    });

    it('should trim whitespace', () => {
      expect(sanitizeForLog('  hello  ')).toBe('hello');
      expect(sanitizeForLog('\t\thello\t\t')).toBe('hello');
    });

    it('should serialize Error objects', () => {
      const error = new Error('Test error message');
      const sanitized = sanitizeForLog(error);
      expect(sanitized).toContain('Test error message');
      expect(sanitized).not.toContain('\n');
    });

    it('should serialize Error objects with stack traces', () => {
      const error = new Error('Stack trace error');
      error.stack =
        'Error: Stack trace error\n    at test.js:1:1\n    at test.js:2:2';
      const sanitized = sanitizeForLog(error);
      expect(sanitized).toBe('Stack trace error');
      expect(sanitized).not.toContain('\n');
    });

    it('should handle custom error properties', () => {
      const error: any = new Error('Custom error');
      error.code = 'ERR_CUSTOM';
      error.statusCode = 400;
      const sanitized = sanitizeForLog(error);
      expect(sanitized).toContain('Custom error');
    });

    it('should serialize plain objects', () => {
      const obj = { name: 'test', value: 123 };
      const sanitized = sanitizeForLog(obj);
      expect(sanitized).toBe('{"name":"test","value":123}');
    });

    it('should serialize nested objects', () => {
      const obj = { user: { name: 'John', age: 30 }, active: true };
      const sanitized = sanitizeForLog(obj);
      expect(sanitized).toContain('"name":"John"');
      expect(sanitized).toContain('"age":30');
      expect(sanitized).toContain('"active":true');
    });

    it('should handle objects with newlines in values', () => {
      const obj = { message: 'line1\nline2\nline3' };
      const sanitized = sanitizeForLog(obj);
      expect(sanitized).not.toContain('\n');
      expect(sanitized).toContain('line1');
    });

    it('should handle circular references gracefully', () => {
      const obj: any = { name: 'test' };
      obj.self = obj; // Create circular reference
      const sanitized = sanitizeForLog(obj);
      expect(sanitized).toBe('[Object]');
    });

    it('should handle objects that throw during JSON.stringify', () => {
      const obj = {
        get badProperty() {
          throw new Error('Cannot access');
        },
      };
      const sanitized = sanitizeForLog(obj);
      expect(sanitized).toBe('[Object]');
    });

    it('should handle arrays', () => {
      const arr = [1, 2, 3, 'test'];
      const sanitized = sanitizeForLog(arr);
      expect(sanitized).toBe('[1,2,3,"test"]');
    });

    it('should handle empty strings', () => {
      expect(sanitizeForLog('')).toBe('');
    });

    it('should handle multiple consecutive newlines', () => {
      expect(sanitizeForLog('hello\n\n\nworld')).toBe('hello world');
    });

    it('should handle mixed control characters', () => {
      const input = 'test\r\n\x00\x1B[31mvalue\x1B[0m\n\tend';
      const sanitized = sanitizeForLog(input);
      expect(sanitized).not.toContain('\r');
      expect(sanitized).not.toContain('\n');
      expect(sanitized).not.toContain('\x00');
      expect(sanitized).not.toContain('\x1B');
    });
  });

  describe('sanitizeForLogMultiple', () => {
    it('should sanitize multiple values', () => {
      const result = sanitizeForLogMultiple('hello\nworld', 123, {
        key: 'value\n',
      });
      expect(result).toEqual([
        'hello world',
        '123',
        '{"key":"value\\n"}', // JSON.stringify escapes the newline
      ]);
    });

    it('should handle empty array', () => {
      const result = sanitizeForLogMultiple();
      expect(result).toEqual([]);
    });

    it('should handle single value', () => {
      const result = sanitizeForLogMultiple('test\nvalue');
      expect(result).toEqual(['test value']);
    });

    it('should handle mixed types', () => {
      const error = new Error('Test error');
      const result = sanitizeForLogMultiple(
        'string\n',
        123,
        true,
        null,
        undefined,
        error,
        { obj: 'value' },
      );

      expect(result).toHaveLength(7);
      expect(result[0]).toBe('string');
      expect(result[1]).toBe('123');
      expect(result[2]).toBe('true');
      expect(result[3]).toBe('null');
      expect(result[4]).toBe('undefined');
      expect(result[5]).toContain('Test error');
      expect(result[6]).toBe('{"obj":"value"}');
    });

    it('should handle values with log injection attempts', () => {
      const result = sanitizeForLogMultiple(
        'user input\n[ERROR] Fake',
        'admin\npassword: secret',
      );

      expect(result[0]).not.toContain('\n');
      expect(result[1]).not.toContain('\n');
      expect(result[0]).toBe('user input [ERROR] Fake');
      expect(result[1]).toBe('admin password: secret');
    });
  });

  describe('Security and edge cases', () => {
    it('should prevent log forging with fake timestamps', () => {
      const malicious = '2024-01-01 12:00:00\n[ERROR] System compromised';
      const sanitized = sanitizeForLog(malicious);
      expect(sanitized).not.toContain('\n');
      expect(sanitized).toBe('2024-01-01 12:00:00 [ERROR] System compromised');
    });

    it('should handle Unicode characters properly', () => {
      expect(sanitizeForLog('Hello 世界 🌍')).toBe('Hello 世界 🌍');
      expect(sanitizeForLog('Ñoño\ntest')).toBe('Ñoño test');
    });

    it('should handle very long strings', () => {
      const longString = 'a'.repeat(10000) + '\n' + 'b'.repeat(10000);
      const sanitized = sanitizeForLog(longString);
      expect(sanitized).not.toContain('\n');
      expect(sanitized.length).toBe(20001); // 10000 a's + 1 space + 10000 b's
    });

    it('should handle objects with symbols', () => {
      const sym = Symbol('test');
      const obj = { [sym]: 'value', regular: 'prop' };
      const sanitized = sanitizeForLog(obj);
      // Symbols are not enumerable in JSON.stringify
      expect(sanitized).toContain('regular');
    });

    it('should handle dates', () => {
      const date = new Date('2024-01-01T00:00:00.000Z');
      const sanitized = sanitizeForLog(date);
      expect(sanitized).toContain('2024');
    });

    it('should handle BigInt', () => {
      const bigInt = BigInt(9007199254740991);
      const sanitized = sanitizeForLog(bigInt);
      expect(sanitized).toBe('9007199254740991');
    });
  });
});
