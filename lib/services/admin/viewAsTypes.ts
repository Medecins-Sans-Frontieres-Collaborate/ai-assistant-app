/**
 * "View as" — admin-only test mode (docs/ADMIN_WORKFLOWS_AND_VIEW_AS.md).
 *
 * A GLOBAL admin can ask the app to treat them, for their own session only,
 * as someone who meets (or fails) conditions that are otherwise decided by
 * the directory or by admins: a plain user, a local admin with a given set
 * of delegated agents, a member of the grants team, a member of an Entra
 * group, a user in the other data region. Unlike the anyone-can-set region
 * override cookie, the overrides here are honoured ONLY when the REAL
 * identity behind the session is a global admin; for everyone else the
 * cookie is inert.
 *
 * Identity is never overridden: `id` and `mail` stay the admin's own, so
 * usage counters, conversations, backups and audit lines keep their real
 * owner. What can be overridden is exactly the set of inputs the app's
 * access decisions read.
 *
 * Pure types + validation only — safe for client imports.
 */
import { z } from 'zod';

export const VIEW_AS_COOKIE = 'admin_view_as';
/** 8h — long enough for a test session, short enough to not be forgotten. */
export const VIEW_AS_MAX_AGE_SECONDS = 60 * 60 * 8;

export const ViewAsAdminRoleSchema = z.enum(['global', 'local', 'none']);
export type ViewAsAdminRole = z.infer<typeof ViewAsAdminRoleSchema>;

const optionalText = z.string().trim().max(200).optional();

export const ViewAsOverridesSchema = z
  .object({
    /**
     * `global` (or absent) keeps the admin's real role; `local` demotes to
     * a local admin delegated `localAdminKeys`; `none` demotes to a regular
     * user. Every admin gate in the app reads this through
     * `resolveAdminStatus` / `isGlobalAdmin`, EXCEPT the view-as controls
     * themselves, which always use the real identity so the admin can get
     * back out.
     */
    adminRole: ViewAsAdminRoleSchema.optional(),
    localAdminKeys: z
      .array(z.string().trim().min(1).max(200))
      .max(50)
      .optional(),
    region: z.enum(['US', 'EU']).optional(),
    department: optionalText,
    companyName: optionalText,
    jobTitle: optionalText,
    /** Office id from config/offices.json (e.g. `msf-usa`). */
    officeId: optionalText,
    /** Replaces (does not extend) the real Entra group membership. */
    groupIds: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
  })
  .strict();
export type ViewAsOverrides = z.infer<typeof ViewAsOverridesSchema>;

export const VIEW_AS_OVERRIDE_KEYS = [
  'adminRole',
  'localAdminKeys',
  'region',
  'department',
  'companyName',
  'jobTitle',
  'officeId',
  'groupIds',
] as const satisfies readonly (keyof ViewAsOverrides)[];

/** Drops blank strings / empty arrays so "unset" and "empty" mean the same. */
export function normalizeViewAsOverrides(
  input: ViewAsOverrides,
): ViewAsOverrides {
  const out: ViewAsOverrides = {};
  if (input.adminRole && input.adminRole !== 'global') {
    out.adminRole = input.adminRole;
  }
  if (out.adminRole === 'local' && input.localAdminKeys?.length) {
    out.localAdminKeys = input.localAdminKeys.map((k) =>
      k.trim().toLowerCase(),
    );
  }
  if (input.region) out.region = input.region;
  for (const key of [
    'department',
    'companyName',
    'jobTitle',
    'officeId',
  ] as const) {
    const value = input[key]?.trim();
    if (value) out[key] = value;
  }
  if (input.groupIds?.length) {
    out.groupIds = [...new Set(input.groupIds.map((g) => g.trim()))];
  }
  return out;
}

export function isViewAsEmpty(overrides: ViewAsOverrides): boolean {
  return VIEW_AS_OVERRIDE_KEYS.every((key) => overrides[key] === undefined);
}

/** What the session carries while view-as is active (for banners/UI). */
export interface ViewAsSessionInfo {
  overrides: ViewAsOverrides;
  /** The admin's real values for every field the overrides replaced. */
  actual: {
    department?: string;
    companyName?: string;
    jobTitle?: string;
    officeId?: string | null;
    region?: 'US' | 'EU';
  };
}
