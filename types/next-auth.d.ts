import NextAuth from 'next-auth';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      givenName?: string;
      surname?: string;
      displayName: string;
      jobTitle?: string;
      department?: string;
      mail?: string;
      companyName?: string;
      region?: 'US' | 'EU';
    };
    error?: string;
    // accessToken is kept in JWT only (server-side) to reduce cookie size
  }

  interface JWT {
    accessToken: string;
    refreshToken?: string;
    accessTokenExpires: number;
    error?: string;
  }
}
