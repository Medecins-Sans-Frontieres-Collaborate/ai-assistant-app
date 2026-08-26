import {
  applyViewAs,
  decodeViewAsCookie,
  encodeViewAsCookie,
  readViewAs,
} from '@/lib/services/admin/viewAs';
import {
  VIEW_AS_COOKIE,
  isViewAsEmpty,
  normalizeViewAsOverrides,
} from '@/lib/services/admin/viewAsTypes';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  AGENT_ACCESS_ADMINS: 'admin@example.com',
}));
const cookieGet = vi.hoisted(() => vi.fn());

vi.mock('@/config/environment', () => ({ env: mockEnv }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: cookieGet }),
}));

describe('view-as cookie', () => {
  beforeEach(() => {
    process.env.AUTH_SECRET = 'test-secret';
    cookieGet.mockReset();
  });

  it('round-trips signed overrides bound to the user', () => {
    const value = encodeViewAsCookie('oid-1', { adminRole: 'none' });
    expect(value).toBeTruthy();
    expect(decodeViewAsCookie(value!, 'oid-1')).toEqual({ adminRole: 'none' });
  });

  it('rejects a tampered payload', () => {
    const value = encodeViewAsCookie('oid-1', { adminRole: 'none' })!;
    const [payload, sig] = value.split('.');
    const forged =
      Buffer.from(
        JSON.stringify({
          sub: 'oid-1',
          exp: 4102444800,
          overrides: { adminRole: 'local' },
        }),
      ).toString('base64url') + `.${sig}`;
    expect(decodeViewAsCookie(forged, 'oid-1')).toBeNull();
    expect(decodeViewAsCookie(`${payload}.bad`, 'oid-1')).toBeNull();
    expect(decodeViewAsCookie('garbage', 'oid-1')).toBeNull();
  });

  it('rejects another user and an expired envelope', () => {
    const value = encodeViewAsCookie('oid-1', { region: 'EU' }, 0)!;
    expect(decodeViewAsCookie(value, 'oid-2')).toBeNull();
    // Minted at epoch 0 → expired 8h later; "now" is well past that.
    expect(decodeViewAsCookie(value, 'oid-1')).toBeNull();
    expect(decodeViewAsCookie(value, 'oid-1', 60_000)).toEqual({
      region: 'EU',
    });
  });

  it('is unavailable without an auth secret', () => {
    delete process.env.AUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    expect(encodeViewAsCookie('oid-1', { adminRole: 'none' })).toBeNull();
  });

  it('readViewAs honours the cookie ONLY for a real global admin', async () => {
    const value = encodeViewAsCookie('oid-1', { adminRole: 'none' })!;
    cookieGet.mockImplementation((name: string) =>
      name === VIEW_AS_COOKIE ? { value } : undefined,
    );
    expect(await readViewAs('oid-1', 'admin@example.com')).toEqual({
      adminRole: 'none',
    });
    expect(await readViewAs('oid-1', 'user@example.com')).toBeNull();
    expect(await readViewAs('oid-1', undefined)).toBeNull();
  });
});

describe('normalizeViewAsOverrides', () => {
  it('drops blanks, "global", and keys that belong to another role', () => {
    const out = normalizeViewAsOverrides({
      adminRole: 'global',
      localAdminKeys: ['Agent-A'],
      department: '  ',
      groupIds: [],
    });
    expect(isViewAsEmpty(out)).toBe(true);

    expect(
      normalizeViewAsOverrides({
        adminRole: 'local',
        localAdminKeys: [' Agent-A ', 'agent-a'],
        groupIds: ['g1', 'g1', ' g2 '],
      }),
    ).toEqual({
      adminRole: 'local',
      localAdminKeys: ['agent-a', 'agent-a'],
      groupIds: ['g1', 'g2'],
    });
  });
});

describe('applyViewAs', () => {
  const base = {
    department: 'Systems',
    companyName: 'MSF-UK',
    jobTitle: 'Engineer',
    officeId: 'msf-uk',
    officeName: 'MSF UK',
    region: 'EU' as const,
  };

  it('replaces only the overridden fields and records the actual values', () => {
    const out = applyViewAs(base, {
      department: 'Program',
      companyName: 'MSF-USA',
      jobTitle: 'Grants Officer',
      region: 'US',
    });
    expect(out.department).toBe('Program');
    expect(out.companyName).toBe('MSF-USA');
    expect(out.jobTitle).toBe('Grants Officer');
    expect(out.region).toBe('US');
    expect(out.officeId).toBe('msf-uk');
    expect(out.viewAs.actual).toEqual({
      department: 'Systems',
      companyName: 'MSF-UK',
      jobTitle: 'Engineer',
      region: 'EU',
    });
  });

  it('overrides the office, falling back to the id as its name when unknown', () => {
    // config/offices.json ships empty in this repo, so any id is "unknown";
    // a configured office would resolve to its displayName instead.
    const out = applyViewAs(base, { officeId: 'msf-usa' });
    expect(out.officeId).toBe('msf-usa');
    expect(out.officeName).toBe('msf-usa');
    expect(out.viewAs.actual.officeId).toBe('msf-uk');
  });
});
