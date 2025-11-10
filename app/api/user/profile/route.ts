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

    // Get refresh token from session (exposed via session callback in auth.ts)
    if (!session.refreshToken) {
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
            refresh_token: session.refreshToken,
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
