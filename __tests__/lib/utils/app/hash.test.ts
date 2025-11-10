import Hasher from '@/lib/utils/app/hash';

import { describe, expect, it } from 'vitest';

describe('Hasher', () => {
  describe('sha256', () => {
    it('should return the correct SHA-256 hash for an empty string', () => {
      const inputString = '';
      const expectedHash =
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

      const result = Hasher.sha256(inputString);

      expect(result).toBe(expectedHash);
    });

    it('should return the correct SHA-256 hash for a non-empty string', () => {
      const inputString = 'Hello, World!';
      const expectedHash =
        'dffd6021bb2bd5b0af676290809ec3a53191dd81c7f70a4b28688a362182986f';

      const result = Hasher.sha256(inputString);

      expect(result).toBe(expectedHash);
    });

    it('should return the correct SHA-256 hash for a string with special characters', () => {
      const inputString = '!@#$%^&*()_+';
      const expectedHash =
        '36d3e1bc65f8b67935ae60f542abef3e55c5bbbd547854966400cc4f022566cb';

      const result = Hasher.sha256(inputString);

      expect(result).toBe(expectedHash);
    });

    it('should return the correct SHA-256 hash for a string with Unicode characters', () => {
      const inputString = '🚀 Hello, 世界!';
      const expectedHash =
        'a3c6765090d5d618ab1283160b418a6b5bcec7b1852d05a3d51c2464613e44ac';

      const result = Hasher.sha256(inputString);

      expect(result).toBe(expectedHash);
    });

    it('should return the correct SHA-256 hash for a long string', () => {
      const inputString =
        'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed euismod, nulla sit amet aliquam lacinia, nisl nisl aliquam nisl, nec aliquam nisl nisl sit amet nisl. Sed euismod, nulla sit amet aliquam lacinia, nisl nisl aliquam nisl, nec aliquam nisl nisl sit amet nisl. Sed euismod, nulla sit amet aliquam lacinia, nisl nisl aliquam nisl, nec aliquam nisl nisl sit amet nisl.';
      const expectedHash =
        '296975e61c987987e788ae8a653df681cd2e242956c5faf3ddc3bdb7c35506e2';

      const result = Hasher.sha256(inputString);

      expect(result).toBe(expectedHash);
    });
  });
});
