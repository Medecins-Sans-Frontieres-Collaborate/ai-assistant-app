import { getEnvVariable, isMobile } from '@/lib/utils/app/env';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('getEnvVariable', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return the correct environment variable value', () => {
    process.env.TEST_VAR = 'test_value';
    expect(getEnvVariable('TEST_VAR')).toBe('test_value');
  });

  it('should throw an error when variable is not set and throwErrorOnFail is true', () => {
    expect(() => getEnvVariable('NON_EXISTENT_VAR')).toThrow(
      'Environment variable NON_EXISTENT_VAR not set',
    );
  });

  it('should return default value when variable is not set and throwErrorOnFail is false', () => {
    expect(getEnvVariable('NON_EXISTENT_VAR', false, 'default')).toBe(
      'default',
    );
  });

  it('should return empty string as default value when not specified', () => {
    expect(getEnvVariable('NON_EXISTENT_VAR', false)).toBe('');
  });

  it('should handle options object input', () => {
    process.env.TEST_VAR = 'test_value';
    expect(getEnvVariable({ name: 'TEST_VAR' })).toBe('test_value');
  });

  it('should use EU variable for EU users', () => {
    process.env.AZURE_BLOB_STORAGE_NAME_EU = 'eu_storage';
    // @ts-ignore
    const result = getEnvVariable('AZURE_BLOB_STORAGE_NAME', false, '', {
      mail: 'user@amsterdam.msf.org',
    });
    expect(result).toBe('eu_storage');
  });

  it('should use non-EU variable for non-EU users', () => {
    process.env.AZURE_BLOB_STORAGE_NAME = 'non_eu_storage';
    // @ts-ignore
    const result = getEnvVariable('AZURE_BLOB_STORAGE_NAME', false, '', {
      mail: 'user@newyork.msf.org',
    });
    expect(result).toBe('non_eu_storage');
  });

  it('should handle undefined user', () => {
    process.env.TEST_VAR = 'test_value';
    expect(getEnvVariable('TEST_VAR', true, '', undefined)).toBe('test_value');
  });

  it('should handle non-mapped variables for EU users', () => {
    process.env.NON_MAPPED_VAR = 'non_mapped_value';
    // @ts-ignore
    const result = getEnvVariable('NON_MAPPED_VAR', false, '', {
      mail: 'user@example.com',
    });
    expect(result).toBe('non_mapped_value');
  });
});

describe('isMobile', () => {
  const originalWindow = global.window;
  const originalNavigator = global.navigator;

  beforeEach(() => {
    vi.resetModules();
    // @ts-ignore
    delete global.window;
    // @ts-ignore
    delete global.navigator;
  });

  afterEach(() => {
    global.window = originalWindow;
    global.navigator = originalNavigator;
  });

  it('should return false for server-side rendering', () => {
    expect(isMobile()).toBe(false);
  });

  it('should return true for mobile user agents', () => {
    global.window = {} as Window & typeof globalThis;
    global.navigator = {
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1',
    } as Navigator;

    expect(isMobile()).toBe(true);
  });

  it('should return false for desktop user agents', () => {
    global.window = {} as Window & typeof globalThis;
    global.navigator = {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    } as Navigator;

    expect(isMobile()).toBe(false);
  });
});
