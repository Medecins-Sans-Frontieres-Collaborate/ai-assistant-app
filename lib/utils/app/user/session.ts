import { Session } from 'next-auth';
import { JWT } from 'next-auth/jwt';

/**
 * Extracts user ID from session or JWT token
 * Provides consistent user ID extraction logic across the application
 *
 * @param session The user session
 * @param token Optional JWT token (fallback if session doesn't have user ID)
 * @returns User ID string, defaults to 'anonymous' if not found
 */
export function getUserIdFromSession(
  session: Session | null,
  token?: JWT,
): string {
  if (session?.user?.id) {
    return session.user.id;
  }

  if (token && (token as any).userId) {
    return (token as any).userId;
  }

  return 'anonymous';
}
