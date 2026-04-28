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
      /** ID of the user's office, e.g. 'msf-usa'. Null if no office matched. */
      officeId?: string | null;
      /** Human-readable office name, e.g. 'MSF USA'. */
      officeName?: string | null;
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
