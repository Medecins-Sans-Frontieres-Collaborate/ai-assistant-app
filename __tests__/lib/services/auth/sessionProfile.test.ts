import {
  PROFILE_REFRESH_MS,
  mergeRefreshedProfile,
  profileRefreshDue,
} from '@/lib/services/auth/sessionProfile';

import { describe, expect, it } from 'vitest';

const resolveOffice = (mail: string | undefined) =>
  mail?.endsWith('@ocp.msf.org')
    ? { region: 'EU' as const, officeId: 'ocp', officeName: 'OCP' }
    : { region: 'US' as const, officeId: null, officeName: null };

const token = {
  userDisplayName: 'Alice',
  userMail: 'alice@x.org',
  userDepartment: 'Logistics',
  userCompanyName: 'MSF',
  userRegion: 'US' as const,
  userOfficeId: null,
  userOfficeName: null,
  profileRefreshedAt: 1_000,
};

describe('profileRefreshDue', () => {
  it('is due for legacy tokens with no stamp and once the window has passed', () => {
    expect(profileRefreshDue({}, 5_000)).toBe(true);
    expect(profileRefreshDue(token, 1_000 + PROFILE_REFRESH_MS - 1)).toBe(
      false,
    );
    expect(profileRefreshDue(token, 1_000 + PROFILE_REFRESH_MS)).toBe(true);
  });
});

describe('mergeRefreshedProfile', () => {
  it('follows the directory for attributes — a cleared department IS cleared', () => {
    const next = mergeRefreshedProfile(
      token,
      { department: 'Health', companyName: null, jobTitle: '  ' },
      resolveOffice,
      9_000,
    );
    expect(next.userDepartment).toBe('Health');
    expect(next.userCompanyName).toBeUndefined();
    expect(next.userJobTitle).toBeUndefined();
    expect(next.profileRefreshedAt).toBe(9_000);
    // Identity fields only change to a non-empty value.
    expect(next.userDisplayName).toBe('Alice');
    expect(next.userMail).toBe('alice@x.org');
    expect(next.userRegion).toBe('US');
  });

  it('re-resolves office and region only when the mail actually changed', () => {
    const same = mergeRefreshedProfile(
      token,
      { mail: 'ALICE@x.org', department: 'Logistics' },
      resolveOffice,
    );
    expect(same.userMail).toBe('alice@x.org');
    expect(same.userOfficeId).toBeNull();

    const moved = mergeRefreshedProfile(
      token,
      { mail: 'alice@ocp.msf.org', department: 'Logistics' },
      resolveOffice,
    );
    expect(moved.userMail).toBe('alice@ocp.msf.org');
    expect(moved.userRegion).toBe('EU');
    expect(moved.userOfficeId).toBe('ocp');
    expect(moved.userOfficeName).toBe('OCP');
  });
});
