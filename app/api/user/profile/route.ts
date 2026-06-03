import { getToken } from 'next-auth/jwt';
import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/auth';
import { env } from '@/config/environment';

/**
 * GET /api/user/profile
 * Fetches full user profile data from Microsoft Graph
 * This endpoint is called on-demand to avoid bloating the session cookie
 */
export async function GET(req: NextRequest) {
  try {
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Read the refresh token directly from the JWT (server-side only). It is
    // deliberately not exposed on the session, so client code can never read
    // it. getToken derives the cookie name + JWE salt from `secureCookie`, so
    // we must match how the cookie was issued: prod (https) uses the
    // __Secure- prefixed cookie, dev (http) uses the unprefixed one. Behind a
    // TLS-terminating proxy the internal request can be http, so key off the
    // configured auth URL rather than the request protocol.
    const secureCookie =
      (process.env.AUTH_URL || process.env.NEXTAUTH_URL || '').startsWith(
        'https',
      ) || process.env.NODE_ENV === 'production';
    const token = await getToken({
      req,
      secret: process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET,
      secureCookie,
    });

    if (!token?.refreshToken) {
      return NextResponse.json({ error: 'No refresh token' }, { status: 401 });
    }

    // Fetch fresh access token using refresh token
    let accessToken: string;
    try {
      const tokenResponse = await fetch(
        `https://login.microsoftonline.com/${env.AZURE_TENANT_ID}/oauth2/v2.0/token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: env.AZURE_CLIENT_ID || '',
            client_secret: env.AZURE_CLIENT_SECRET || '',
            refresh_token: token.refreshToken,
            scope: 'openid User.Read User.ReadBasic.all offline_access',
          }).toString(),
        },
      );

      if (!tokenResponse.ok) {
        throw new Error('Failed to refresh token');
      }

      const tokens = await tokenResponse.json();
      accessToken = tokens.access_token;
    } catch (error) {
      console.error('Error refreshing access token:', error);
      return NextResponse.json(
        { error: 'Failed to refresh token' },
        { status: 401 },
      );
    }

    // Fetch full user data from Microsoft Graph
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

    // Fetch user photo (optional - may not exist for all users)
    let photoUrl = null;
    try {
      const photoResponse = await fetch(
        'https://graph.microsoft.com/v1.0/me/photo/$value',
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );

      if (photoResponse.ok) {
        const photoBlob = await photoResponse.arrayBuffer();
        const photoBase64 = Buffer.from(photoBlob).toString('base64');
        const contentType =
          photoResponse.headers.get('content-type') || 'image/jpeg';
        photoUrl = `data:${contentType};base64,${photoBase64}`;
      }
    } catch (photoError) {
      // Photo is optional - don't fail if it doesn't exist
      console.log('User photo not available');
    }

    return NextResponse.json({
      ...userData,
      photoUrl,
    });
  } catch (error) {
    console.error('Error fetching user profile:', error);
    return NextResponse.json(
      { error: 'Failed to fetch user profile' },
      { status: 500 },
    );
  }
}
