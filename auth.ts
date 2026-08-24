import NextAuth, { Session } from 'next-auth';
import { JWT, getToken } from 'next-auth/jwt';
import MicrosoftEntraID from 'next-auth/providers/microsoft-entra-id';
import { cookies } from 'next/headers';
import { NextRequest } from 'next/server';

import { applyViewAs, readViewAs } from '@/lib/services/admin/viewAs';
import { OfficeResolver } from '@/lib/services/auth/OfficeResolver';
import { qualifyGraphScopes } from '@/lib/services/auth/m365GraphScopes';

import {
  REGION_OVERRIDE_COOKIE,
  UserRegion,
  parseRegion,
} from '@/lib/utils/shared/region';

/**
 * Reads the manual region-override cookie for the current request, if any.
 *
 * Returns null when no (valid) override is set, or when there is no request
 * scope to read cookies from (e.g. edge middleware) — callers treat that as
 * "no override". The override only changes which regional data plane the
 * user's requests are routed to; it does not change their office identity.
 */
async function readRegionOverride(): Promise<UserRegion | null> {
  try {
    const store = await cookies();
    return parseRegion(store.get(REGION_OVERRIDE_COOKIE)?.value);
  } catch {
    return null;
  }
}

declare module 'next-auth' {
  interface User {
    id: string;
    displayName: string;
    givenName?: string;
    surname?: string;
    mail?: string;
    jobTitle?: string;
    department?: string;
    companyName?: string;
    region?: 'US' | 'EU';
    /** ID of the user's office, e.g. 'msf-usa'. Null if no office matched. */
    officeId?: string | null;
    /** Human-readable office name, e.g. 'MSF USA'. */
    officeName?: string | null;
  }

  interface Session {
    error?: string;
    // Note: the refresh token is intentionally NOT exposed on the Session.
    // It stays in the JWT only (server-side) and is read via getToken() in
    // routes that need it, so client code (useSession / /api/auth/session)
    // can never read it.
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    accessToken?: string; // Not stored to reduce cookie size - fetched on-demand
    accessTokenExpires: number;
    refreshToken?: string;
    error?: string;
    // Store full user profile data in JWT for logging/analytics
    userId?: string;
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
  }
}

interface UserData {
  id: string;
  givenName?: string;
  surname?: string;
  displayName: string;
  jobTitle?: string;
  department?: string;
  mail?: string;
  companyName?: string;
}

/**
 * Resolves a user's office and region from their email domain in one lookup,
 * falling back to the region heuristic when no office matches.
 */
function resolveOfficeAndRegion(email: string | undefined): {
  region: 'US' | 'EU';
  officeId: string | null;
  officeName: string | null;
} {
  const office = OfficeResolver.findOfficeByEmail(email);
  return {
    region: office?.region ?? OfficeResolver.getRegionForUser(email),
    officeId: office?.id ?? null,
    officeName: office?.displayName ?? null,
  };
}

const refreshAccessToken = async (token: JWT): Promise<JWT> => {
  if (!token.refreshToken) {
    return { ...token, error: 'RefreshTokenMissing' };
  }

  try {
    const url = `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`;

    const formData = {
      grant_type: 'refresh_token',
      client_id: process.env.AZURE_CLIENT_ID || '',
      client_secret: process.env.AZURE_CLIENT_SECRET || '',
      refresh_token: token.refreshToken,
      scope: 'openid User.Read User.ReadBasic.all offline_access',
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(formData).toString(),
    });

    const refreshedTokens = await response.json();

    if (!response.ok) {
      throw new Error(
        refreshedTokens.error_description || 'Failed to refresh token',
      );
    }

    return {
      ...token,
      accessToken: refreshedTokens.access_token,
      accessTokenExpires: Date.now() + refreshedTokens.expires_in * 1000,
      refreshToken: refreshedTokens.refresh_token ?? token.refreshToken,
      error: undefined,
    };
  } catch (error) {
    return {
      ...token,
      error: 'RefreshAccessTokenError',
    };
  }
};

async function fetchUserData(accessToken: string): Promise<UserData> {
  const selectProperties = `id,userPrincipalName,displayName,givenName,surname,department,jobTitle,mail,companyName`;
  const response = await fetch(
    `https://graph.microsoft.com/v1.0/me?$select=${selectProperties}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-type': 'application/json',
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch user data: ${response.statusText}`);
  }

  const userData = await response.json();
  return {
    id: userData.id,
    givenName: userData.givenName,
    surname: userData.surname,
    displayName: userData.displayName,
    jobTitle: userData.jobTitle,
    department: userData.department,
    mail: userData.mail,
    companyName: userData.companyName,
  };
}

/**
 * Decrypts the server-side session JWT for the incoming request. The refresh
 * token lives only in this JWT (never on the Session), so token-minting
 * helpers must go through here.
 */
async function readServerJwt(req: NextRequest): Promise<JWT | null> {
  // getToken derives the cookie name + JWE salt from `secureCookie`, so we must
  // match how the cookie was issued: prod (https) uses the __Secure- prefixed
  // cookie, dev (http) the unprefixed one. Behind a TLS-terminating proxy the
  // internal request can be http, so key off the configured auth URL rather
  // than the request protocol.
  const secureCookie =
    (process.env.AUTH_URL || process.env.NEXTAUTH_URL || '').startsWith(
      'https',
    ) || process.env.NODE_ENV === 'production';
  return getToken({
    req,
    secret: process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET,
    secureCookie,
  });
}

/**
 * Gets a fresh access token for OBO exchange from the user's refresh token.
 * The returned token is scoped to the app's own audience (api://<client-id>/.default)
 * and serves as the "user assertion" for OnBehalfOfCredential.
 *
 * The refresh token is read from the JWT via getToken() — it is deliberately
 * never exposed on the Session, so client code can't read it and callers must
 * pass the incoming request so we can decrypt the server-side cookie.
 *
 * Returns null if the token cannot be acquired (e.g., missing refresh token).
 */
export async function getAccessTokenForOBO(
  req: NextRequest,
): Promise<string | null> {
  const token = await readServerJwt(req);

  if (!token?.refreshToken) {
    console.warn('[Auth] No refresh token available for OBO exchange');
    return null;
  }

  try {
    const url = `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`;

    const formData = {
      grant_type: 'refresh_token',
      client_id: process.env.AZURE_CLIENT_ID || '',
      client_secret: process.env.AZURE_CLIENT_SECRET || '',
      refresh_token: token.refreshToken,
      scope: `${process.env.AZURE_CLIENT_ID}/.default`,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(formData).toString(),
    });

    const tokens = await response.json();

    if (!response.ok) {
      console.error(
        '[Auth] OBO token acquisition failed:',
        tokens.error_description,
      );
      return null;
    }

    return tokens.access_token;
  } catch (error) {
    console.error('[Auth] Error acquiring access token for OBO:', error);
    return null;
  }
}

export interface GraphTokenResult {
  accessToken: string | null;
  /** Scopes Entra actually granted on the token (space-split `scope` field). */
  grantedScopes: string[];
  /**
   * Entra error description when minting failed. A consent gap surfaces here
   * as AADSTS65001 ("user or administrator has not consented") — callers can
   * treat that as "feature not enabled by the tenant" rather than a fault.
   */
  error?: string;
}

/**
 * Mints a Microsoft Graph access token for the signed-in user with exactly
 * the requested delegated scopes, using the server-side refresh token.
 *
 * This is the incremental-consent path for the M365 integrations: refresh
 * tokens are not scope-bound, so once the tenant admin grants consent on the
 * app registration, any of the scopes in `lib/services/auth/m365GraphScopes`
 * can be requested here on demand — without adding them to the base sign-in
 * request (which would block sign-in behind the consent screen for everyone).
 *
 * Request the minimum scope set for the operation at hand; tokens are minted
 * per request and never persisted.
 */
export async function getGraphAccessToken(
  req: NextRequest,
  scopes: string[],
): Promise<GraphTokenResult> {
  const token = await readServerJwt(req);

  if (!token?.refreshToken) {
    return {
      accessToken: null,
      grantedScopes: [],
      error: 'No refresh token available',
    };
  }

  try {
    const url = `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`;

    const formData = {
      grant_type: 'refresh_token',
      client_id: process.env.AZURE_CLIENT_ID || '',
      client_secret: process.env.AZURE_CLIENT_SECRET || '',
      refresh_token: token.refreshToken,
      scope: qualifyGraphScopes(scopes).join(' '),
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(formData).toString(),
    });

    const tokens = await response.json();

    if (!response.ok) {
      return {
        accessToken: null,
        grantedScopes: [],
        error: tokens.error_description || 'Failed to acquire Graph token',
      };
    }

    return {
      accessToken: tokens.access_token,
      grantedScopes:
        typeof tokens.scope === 'string' ? tokens.scope.split(' ') : [],
    };
  } catch (error) {
    console.error('[Auth] Error acquiring Graph access token:', error);
    return {
      accessToken: null,
      grantedScopes: [],
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: true,
  session: {
    strategy: 'jwt',
    maxAge: 30 * 24 * 60 * 60, // 30 days - allows refresh token to keep session alive
    updateAge: 24 * 60 * 60, // Update session every 24 hours
  },
  providers: [
    MicrosoftEntraID({
      clientId: process.env.AZURE_CLIENT_ID || '',
      clientSecret: process.env.AZURE_CLIENT_SECRET || '',
      issuer: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/v2.0`,
      authorization: {
        params: {
          scope: 'openid User.Read User.ReadBasic.all offline_access',
        },
      },
      // Disable PKCE since Azure Container Apps ingress truncates the cookies
      checks: ['state'],
    }),
  ],
  pages: {
    signIn: '/signin',
    error: '/auth-error',
  },
  callbacks: {
    async jwt({ token, account }): Promise<JWT> {
      // Initial sign in - fetch full user profile from Microsoft Graph
      if (account && account.access_token) {
        try {
          // Fetch full user profile for logging/analytics
          const userData = await fetchUserData(account.access_token);

          // Resolve office (and region) from email domain
          const { region, officeId, officeName } = resolveOfficeAndRegion(
            userData.mail,
          );

          return {
            ...token,
            // Don't store access token - cuts cookie size in half!
            // accessToken: account.access_token!,
            accessTokenExpires: account.expires_at
              ? account.expires_at * 1000
              : Date.now() + 24 * 60 * 60 * 1000,
            refreshToken: account.refresh_token,
            error: undefined,
            // Store full user profile from Microsoft Graph
            userId: userData.id,
            userDisplayName: userData.displayName,
            userMail: userData.mail,
            userGivenName: userData.givenName,
            userSurname: userData.surname,
            userJobTitle: userData.jobTitle,
            userDepartment: userData.department,
            userCompanyName: userData.companyName,
            userRegion: region,
            userOfficeId: officeId,
            userOfficeName: officeName,
          };
        } catch (error) {
          console.error('Error fetching user data during login:', error);
          // Fallback to OAuth token data if Graph API fails
          const fallbackEmail = token.email || undefined;
          const { region, officeId, officeName } =
            resolveOfficeAndRegion(fallbackEmail);

          return {
            ...token,
            accessTokenExpires: account.expires_at
              ? account.expires_at * 1000
              : Date.now() + 24 * 60 * 60 * 1000,
            refreshToken: account.refresh_token,
            error: undefined,
            userId: token.sub || '',
            userDisplayName: token.name || '',
            userMail: fallbackEmail,
            userRegion: region,
            userOfficeId: officeId,
            userOfficeName: officeName,
          };
        }
      }

      // Return token as-is if not expired (check with 5 minute buffer)
      if (Date.now() < token.accessTokenExpires - 5 * 60 * 1000) {
        return token;
      }

      // Token is expired or about to expire - refresh it
      console.log('Access token expired or expiring soon, refreshing...');
      return refreshAccessToken(token);
    },
    async session({ session, token }): Promise<Session> {
      // Pass through full user profile from JWT
      // All user data is available for logging/analytics without API calls

      // Fallback to standard JWT claims if custom fields are missing (for old tokens)
      const userId = token.userId || token.sub || '';
      const userDisplayName = token.userDisplayName || token.name || '';
      const userMail = token.userMail || token.email || undefined;

      // Determine region/office from email if not set in token (for old tokens)
      const resolved = resolveOfficeAndRegion(userMail);
      const actualRegion = token.userRegion ?? resolved.region;
      const userOfficeId = token.userOfficeId ?? resolved.officeId;
      const userOfficeName = token.userOfficeName ?? resolved.officeName;

      // Apply an optional manual region override (testing/diagnostics). It
      // replaces only the data-plane region — office identity is unchanged —
      // and is surfaced via `regionOverridden` so the UI can warn the user.
      const override = await readRegionOverride();
      const userRegion = override ?? actualRegion;

      // Admin "view as" (lib/services/admin/viewAs.ts): honoured only when
      // the REAL mail on the JWT is a global admin, and applied last so it
      // wins over the anyone-can-set region cookie. Identity (id, mail) is
      // never touched; only the fields access decisions read.
      const viewAsOverrides = await readViewAs(userId, userMail);
      const profile = {
        jobTitle: token.userJobTitle,
        department: token.userDepartment,
        companyName: token.userCompanyName,
        officeId: userOfficeId,
        officeName: userOfficeName,
        region: userRegion,
      };
      const effective = viewAsOverrides
        ? applyViewAs(profile, viewAsOverrides)
        : { ...profile, viewAs: undefined };
      const regionOverridden =
        effective.region !== actualRegion &&
        (override !== null || viewAsOverrides?.region !== undefined);

      return {
        ...session,
        user: {
          id: userId,
          displayName: userDisplayName,
          mail: userMail,
          givenName: token.userGivenName,
          surname: token.userSurname,
          jobTitle: effective.jobTitle,
          department: effective.department,
          companyName: effective.companyName,
          region: effective.region,
          actualRegion,
          regionOverridden,
          officeId: effective.officeId,
          officeName: effective.officeName,
          viewAs: effective.viewAs,
        } as Session['user'],
        error: token.error,
        // Refresh token is deliberately omitted here — it must not reach the
        // client. Server-side consumers read it from the JWT via getToken().
        expires: session.expires,
      };
    },
  },
});
