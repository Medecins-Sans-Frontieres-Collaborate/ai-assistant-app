import NextAuth, { Session } from 'next-auth';
import { JWT } from 'next-auth/jwt';
import MicrosoftEntraID from 'next-auth/providers/microsoft-entra-id';

import { OfficeResolver } from '@/lib/services/auth/OfficeResolver';

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
 * Gets a fresh access token for OBO exchange from a session's refresh token.
 * The returned token is scoped to the app's own audience (api://<client-id>/.default)
 * and serves as the "user assertion" for OnBehalfOfCredential.
 *
 * Returns null if the token cannot be acquired (e.g., missing refresh token).
 */
export async function getAccessTokenForOBO(
  session: Session,
): Promise<string | null> {
  if (!session.refreshToken) {
    console.warn('[Auth] No refresh token available for OBO exchange');
    return null;
  }

  try {
    const url = `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`;

    const formData = {
      grant_type: 'refresh_token',
      client_id: process.env.AZURE_CLIENT_ID || '',
      client_secret: process.env.AZURE_CLIENT_SECRET || '',
      refresh_token: session.refreshToken,
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
          const office = OfficeResolver.findOfficeByEmail(userData.mail);
          const userRegion: 'US' | 'EU' =
            office?.region ?? OfficeResolver.getRegionForUser(userData.mail);

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
            userRegion,
            userOfficeId: office?.id ?? null,
            userOfficeName: office?.displayName ?? null,
          };
        } catch (error) {
          console.error('Error fetching user data during login:', error);
          // Fallback to OAuth token data if Graph API fails
          const fallbackEmail = token.email || undefined;
          const fallbackOffice =
            OfficeResolver.findOfficeByEmail(fallbackEmail);
          const userRegion: 'US' | 'EU' =
            fallbackOffice?.region ??
            OfficeResolver.getRegionForUser(fallbackEmail);

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
            userRegion,
            userOfficeId: fallbackOffice?.id ?? null,
            userOfficeName: fallbackOffice?.displayName ?? null,
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
      const officeFromEmail = OfficeResolver.findOfficeByEmail(userMail);
      const userRegion =
        token.userRegion ??
        officeFromEmail?.region ??
        OfficeResolver.getRegionForUser(userMail);
      const userOfficeId = token.userOfficeId ?? officeFromEmail?.id ?? null;
      const userOfficeName =
        token.userOfficeName ?? officeFromEmail?.displayName ?? null;

      return {
        ...session,
        user: {
          id: userId,
          displayName: userDisplayName,
          mail: userMail,
          givenName: token.userGivenName,
          surname: token.userSurname,
          jobTitle: token.userJobTitle,
          department: token.userDepartment,
          companyName: token.userCompanyName,
          region: userRegion,
          officeId: userOfficeId,
          officeName: userOfficeName,
        } as Session['user'],
        error: token.error,
        // Refresh token is deliberately omitted here — it must not reach the
        // client. Server-side consumers read it from the JWT via getToken().
        expires: session.expires,
      };
    },
  },
});
