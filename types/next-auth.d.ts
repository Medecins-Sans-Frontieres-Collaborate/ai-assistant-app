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
      /**
       * Effective region the user's requests are routed to. Normally derived
       * from the user's office/email, but may be replaced by a manual override
       * (see `regionOverridden`).
       */
      region?: 'US' | 'EU';
      /**
       * The region the user would resolve to WITHOUT an override, derived from
       * their office/email. Equals `region` unless `regionOverridden` is true.
       */
      actualRegion?: 'US' | 'EU';
      /**
       * True when a manual region override is active for this session, i.e.
       * `region` came from the override cookie rather than the user's identity.
       * Surfaced so the UI can warn that data is being routed to an overridden
       * location, not the user's actual one.
       */
      regionOverridden?: boolean;
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
