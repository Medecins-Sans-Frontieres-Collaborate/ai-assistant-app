import { OfficeResolver } from '@/lib/services/auth/OfficeResolver';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/offices.json', () => ({
  default: {
    offices: [
      {
        id: 'msf-amsterdam',
        displayName: 'MSF Amsterdam',
        emailDomains: ['amsterdam.msf.org'],
        region: 'EU',
        foundryProjectsEnv: ['OFFICE_AMSTERDAM_FOUNDRY_PROJECT_IDS'],
      },
      {
        id: 'msf-usa',
        displayName: 'MSF USA',
        emailDomains: ['newyork.msf.org', 'msf-usa.org'],
        region: 'US',
        foundryProjectsEnv: ['OFFICE_USA_FOUNDRY_PROJECT_IDS'],
      },
    ],
  },
}));

vi.mock('@/config/environment', () => ({
  env: {
    AZURE_AI_FOUNDRY_RESOURCE_ID_US: '/subscriptions/us/foo',
    AZURE_AI_FOUNDRY_RESOURCE_ID_EU: '/subscriptions/eu/bar',
    AZURE_AI_FOUNDRY_ENDPOINT_US: 'https://us.example.com',
    AZURE_AI_FOUNDRY_ENDPOINT_EU: 'https://eu.example.com',
    AZURE_AI_FOUNDRY_ENDPOINT: 'https://default.example.com',
  },
}));

describe('OfficeResolver', () => {
  beforeEach(() => {
    process.env.OFFICE_USA_FOUNDRY_PROJECT_IDS =
      '/subscriptions/usa/projects/x,/subscriptions/usa/projects/y';
    process.env.OFFICE_AMSTERDAM_FOUNDRY_PROJECT_IDS = '';
    OfficeResolver.reset();
  });

  afterEach(() => {
    OfficeResolver.reset();
  });

  describe('findOfficeByEmail', () => {
    it('returns null for missing email', () => {
      expect(OfficeResolver.findOfficeByEmail(undefined)).toBeNull();
      expect(OfficeResolver.findOfficeByEmail(null)).toBeNull();
      expect(OfficeResolver.findOfficeByEmail('')).toBeNull();
    });

    it('returns null for malformed email (no @)', () => {
      expect(OfficeResolver.findOfficeByEmail('not-an-email')).toBeNull();
    });

    it('matches exact domain (case-insensitive)', () => {
      expect(OfficeResolver.findOfficeByEmail('a@newyork.msf.org')?.id).toBe(
        'msf-usa',
      );
      expect(OfficeResolver.findOfficeByEmail('A@NEWYORK.MSF.ORG')?.id).toBe(
        'msf-usa',
      );
    });

    it('matches subdomain', () => {
      expect(
        OfficeResolver.findOfficeByEmail('a@dept.amsterdam.msf.org')?.id,
      ).toBe('msf-amsterdam');
    });

    it('returns null for non-matching domain', () => {
      expect(OfficeResolver.findOfficeByEmail('a@some-other.org')).toBeNull();
    });

    it('matches alternate domain in same office', () => {
      expect(OfficeResolver.findOfficeByEmail('a@msf-usa.org')?.id).toBe(
        'msf-usa',
      );
    });
  });

  describe('getRegionForUser', () => {
    it('derives region from matched office', () => {
      expect(OfficeResolver.getRegionForUser('a@newyork.msf.org')).toBe('US');
      expect(OfficeResolver.getRegionForUser('a@amsterdam.msf.org')).toBe('EU');
    });

    it('falls back to legacy newyork substring check', () => {
      // Doesn't match any office's emailDomains exactly but contains "newyork"
      expect(OfficeResolver.getRegionForUser('a@newyork-other.com')).toBe('US');
    });

    it('defaults to EU for unmatched email', () => {
      expect(OfficeResolver.getRegionForUser('a@some-other.org')).toBe('EU');
      expect(OfficeResolver.getRegionForUser(null)).toBe('EU');
    });
  });

  describe('getDiscoveryPathsForUser', () => {
    it('returns regional path + office paths for matched office', () => {
      const result =
        OfficeResolver.getDiscoveryPathsForUser('a@newyork.msf.org');
      expect(result.regionalPath).toBe('/subscriptions/us/foo');
      expect(result.officePaths).toEqual([
        '/subscriptions/usa/projects/x',
        '/subscriptions/usa/projects/y',
      ]);
    });

    it('dedups office path that equals the regional default', () => {
      process.env.OFFICE_USA_FOUNDRY_PROJECT_IDS = '/subscriptions/us/foo';
      OfficeResolver.reset();
      const result =
        OfficeResolver.getDiscoveryPathsForUser('a@newyork.msf.org');
      expect(result.regionalPath).toBe('/subscriptions/us/foo');
      expect(result.officePaths).toEqual([]);
    });

    it('returns just regional path for unmatched user', () => {
      const result = OfficeResolver.getDiscoveryPathsForUser('a@unknown.org');
      // Unmatched defaults to EU
      expect(result.regionalPath).toBe('/subscriptions/eu/bar');
      expect(result.officePaths).toEqual([]);
    });
  });

  describe('getFoundryEndpoint', () => {
    it('returns the regional endpoint', () => {
      expect(OfficeResolver.getFoundryEndpoint('US')).toBe(
        'https://us.example.com',
      );
      expect(OfficeResolver.getFoundryEndpoint('EU')).toBe(
        'https://eu.example.com',
      );
    });
  });
});
