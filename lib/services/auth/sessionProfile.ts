/**
 * Keeping the session's Graph profile current after sign-in.
 *
 * The limits `attribute` scope (department / company / office) and the
 * logging attributes are read from the session JWT, which used to be filled
 * exactly once, in the initial `jwt` callback, and then lived for the 30-day
 * session. A department move took weeks to reach a policy. The access token
 * is refreshed about hourly anyway, so the refresh path now re-reads `/me`
 * at most once per PROFILE_REFRESH_MS and merges the answer through
 * {@link mergeRefreshedProfile}.
 *
 * Pure: auth.ts owns the fetch and the office resolver; this module only
 * decides WHEN and merges WHAT, so it can be tested without next-auth.
 */

export const PROFILE_REFRESH_MS = 60 * 60 * 1000;

/** The `/me` fields auth.ts selects (all optional in Graph's answer). */
export interface GraphProfile {
  displayName?: string | null;
  mail?: string | null;
  givenName?: string | null;
  surname?: string | null;
  jobTitle?: string | null;
  department?: string | null;
  companyName?: string | null;
}

export interface RefreshableProfile {
  userDisplayName?: string;
  userMail?: string;
  userGivenName?: string;
  userSurname?: string;
  userJobTitle?: string;
  userDepartment?: string;
  userCompanyName?: string;
  userRegion?: 'US' | 'EU';
  userOfficeId?: string | null;
  userOfficeName?: string | null;
  /** Epoch ms of the last successful profile read. */
  profileRefreshedAt?: number;
}

export interface OfficeResolution {
  region: 'US' | 'EU';
  officeId: string | null;
  officeName: string | null;
}

/** Due when never refreshed (legacy tokens) or older than the window. */
export function profileRefreshDue(
  token: Pick<RefreshableProfile, 'profileRefreshedAt'>,
  now: number = Date.now(),
): boolean {
  const at = token.profileRefreshedAt;
  return typeof at !== 'number' || now - at >= PROFILE_REFRESH_MS;
}

function text(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Merges a fresh `/me` answer into the token. Attribute fields follow the
 * directory exactly — a department Graph now reports as empty IS cleared,
 * because a stale value would keep matching an `attribute` override the
 * person no longer belongs under. Identity fields (display name, mail) only
 * change to a non-empty value. A changed mail re-resolves office and region
 * through the caller's resolver, exactly as the initial sign-in did.
 */
export function mergeRefreshedProfile<T extends RefreshableProfile>(
  token: T,
  profile: GraphProfile,
  resolveOffice: (mail: string | undefined) => OfficeResolution,
  now: number = Date.now(),
): T {
  const next: T = {
    ...token,
    userDepartment: text(profile.department),
    userCompanyName: text(profile.companyName),
    userJobTitle: text(profile.jobTitle),
    userDisplayName: text(profile.displayName) ?? token.userDisplayName,
    userGivenName: text(profile.givenName) ?? token.userGivenName,
    userSurname: text(profile.surname) ?? token.userSurname,
    profileRefreshedAt: now,
  };
  const mail = text(profile.mail);
  if (mail && mail.toLowerCase() !== token.userMail?.toLowerCase()) {
    const office = resolveOffice(mail);
    next.userMail = mail;
    next.userRegion = office.region;
    next.userOfficeId = office.officeId;
    next.userOfficeName = office.officeName;
  }
  return next;
}
