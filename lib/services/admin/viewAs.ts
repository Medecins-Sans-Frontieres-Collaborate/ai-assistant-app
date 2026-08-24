/**
 * Server side of "view as" (see viewAsTypes.ts for the model and rationale).
 *
 * The overrides travel in an httpOnly cookie SIGNED with the auth secret and
 * BOUND to the admin's user id + an expiry, so they cannot be forged from a
 * URL parameter or page script (the way the region override can), cannot
 * be replayed for another user, and cannot outlive a test session. The
 * signature is a defence in depth: even an unsigned cookie would be inert
 * for a non-admin, because {@link readViewAs} also re-checks that the REAL
 * mail on the JWT is a global admin on every request.
 */
import { cookies } from 'next/headers';

import {
  VIEW_AS_COOKIE,
  VIEW_AS_MAX_AGE_SECONDS,
  ViewAsOverrides,
  ViewAsOverridesSchema,
  ViewAsSessionInfo,
  isViewAsEmpty,
  normalizeViewAsOverrides,
} from '@/lib/services/admin/viewAsTypes';
import { isGlobalAdmin } from '@/lib/services/agentAccess/adminAuth';
import { OfficeResolver } from '@/lib/services/auth/OfficeResolver';

import { createHmac, timingSafeEqual } from 'crypto';

interface ViewAsEnvelope {
  /** Entra oid the cookie was minted for. */
  sub: string;
  /** Epoch seconds. */
  exp: number;
  overrides: ViewAsOverrides;
}

function secret(): string | null {
  return process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || null;
}

function sign(payload: string, key: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

/** Mints the cookie value: `<base64url(json)>.<hmac>`. */
export function encodeViewAsCookie(
  userId: string,
  overrides: ViewAsOverrides,
  nowMs: number = Date.now(),
): string | null {
  const key = secret();
  if (!key) return null;
  const envelope: ViewAsEnvelope = {
    sub: userId,
    exp: Math.floor(nowMs / 1000) + VIEW_AS_MAX_AGE_SECONDS,
    overrides: normalizeViewAsOverrides(overrides),
  };
  const payload = Buffer.from(JSON.stringify(envelope)).toString('base64url');
  return `${payload}.${sign(payload, key)}`;
}

/**
 * Verifies signature, expiry and user binding. Returns the overrides, or
 * null for anything not exactly right — a bad cookie is simply ignored.
 */
export function decodeViewAsCookie(
  value: string | undefined,
  userId: string | undefined,
  nowMs: number = Date.now(),
): ViewAsOverrides | null {
  if (!value || !userId) return null;
  const key = secret();
  if (!key) return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  const expected = sign(payload, key);
  if (
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return null;
  }
  let envelope: ViewAsEnvelope;
  try {
    envelope = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (envelope.sub !== userId) return null;
  if (typeof envelope.exp !== 'number' || envelope.exp * 1000 < nowMs) {
    return null;
  }
  const parsed = ViewAsOverridesSchema.safeParse(envelope.overrides);
  if (!parsed.success) return null;
  const overrides = normalizeViewAsOverrides(parsed.data);
  return isViewAsEmpty(overrides) ? null : overrides;
}

/**
 * Reads the active view-as overrides for the current request, or null.
 * `realMail` / `userId` MUST come from the JWT (the real identity), never
 * from an already-overridden session.
 */
export async function readViewAs(
  userId: string | undefined,
  realMail: string | undefined,
): Promise<ViewAsOverrides | null> {
  // The string form of isGlobalAdmin is the REAL-identity check by design.
  if (!isGlobalAdmin(realMail)) return null;
  try {
    const store = await cookies();
    return decodeViewAsCookie(store.get(VIEW_AS_COOKIE)?.value, userId);
  } catch {
    // No request scope (edge middleware) — treat as "no override".
    return null;
  }
}

export interface ViewAsInputUser {
  department?: string;
  companyName?: string;
  jobTitle?: string;
  officeId?: string | null;
  officeName?: string | null;
  region: 'US' | 'EU';
}

export interface ViewAsAppliedUser extends ViewAsInputUser {
  viewAs: ViewAsSessionInfo;
}

/**
 * Pure: the user fields as the app should see them under `overrides`, plus
 * the `viewAs` record the session carries so UI can explain what is going
 * on. Fields not overridden pass through untouched.
 */
export function applyViewAs(
  user: ViewAsInputUser,
  overrides: ViewAsOverrides,
): ViewAsAppliedUser {
  const actual: ViewAsSessionInfo['actual'] = {};
  const out: ViewAsInputUser = { ...user };

  if (overrides.department !== undefined) {
    actual.department = user.department;
    out.department = overrides.department;
  }
  if (overrides.companyName !== undefined) {
    actual.companyName = user.companyName;
    out.companyName = overrides.companyName;
  }
  if (overrides.jobTitle !== undefined) {
    actual.jobTitle = user.jobTitle;
    out.jobTitle = overrides.jobTitle;
  }
  if (overrides.officeId !== undefined) {
    actual.officeId = user.officeId;
    const office = OfficeResolver.getAllOffices().find(
      (o) => o.id === overrides.officeId,
    );
    out.officeId = overrides.officeId;
    out.officeName = office?.displayName ?? overrides.officeId;
  }
  if (overrides.region !== undefined) {
    actual.region = user.region;
    out.region = overrides.region;
  }

  return { ...out, viewAs: { overrides, actual } };
}
