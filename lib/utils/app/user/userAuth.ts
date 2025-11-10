import { Session } from 'next-auth';

/**
 * @deprecated Prefer using session.user.region === 'US' from the session object.
 * This function is kept for backwards compatibility but components should
 * use the centralized region property from the user session instead.
 *
 * Determines if a user is US-based based on their email address.
 * US-based users have 'newyork' in their email.
 */
export const isUSBased = (email: string | undefined | null): boolean => {
  if (!email) return false;
  return email.toLowerCase().includes('newyork');
};

/**
 * Determines if a user is authorized for file uploads.
 * Currently returns true for all users.
 */
export const userAuthorizedForFileUploads = (
  user: Session['user'] | undefined,
): boolean => {
  return true; // All users currently authorized
};
