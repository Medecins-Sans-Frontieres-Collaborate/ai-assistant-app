'use client';

import { signOut, useSession } from 'next-auth/react';
import { useEffect, useRef } from 'react';

/**
 * Monitors session for token refresh errors and signs out user if refresh fails
 * This prevents users from staying "signed in" with invalid/expired tokens
 */
export function SessionErrorHandler() {
  const { data: session, status } = useSession();
  const hasHandledError = useRef(false);

  useEffect(() => {
    // Reset flag when session changes
    if (status === 'authenticated' && !session?.error) {
      hasHandledError.current = false;
    }

    // Handle refresh token errors
    if (
      status === 'authenticated' &&
      session?.error &&
      !hasHandledError.current
    ) {
      hasHandledError.current = true;

      console.error(
        'Session error detected:',
        session.error,
        '- Signing out user',
      );

      // Sign out and redirect to sign in page
      signOut({
        callbackUrl: '/signin?error=SessionExpired',
        redirect: true,
      });
    }
  }, [session, status]);

  return null; // This component doesn't render anything
}
