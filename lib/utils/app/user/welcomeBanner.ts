// Local storage key for welcome banner dismissal
const WELCOME_BANNER_KEY = 'chatbot_welcome_v2_dismissed';

export interface WelcomeBannerDismissal {
  userId: string;
  dismissedAt: number;
  action: 'dismissed' | 'viewed'; // Track whether user dismissed or viewed
}

/**
 * Get the welcome banner dismissal status for a user
 */
export const getWelcomeBannerStatus = (
  userId: string,
): WelcomeBannerDismissal | null => {
  if (typeof window === 'undefined') return null;

  try {
    const dismissalsStr = localStorage.getItem(WELCOME_BANNER_KEY);
    if (!dismissalsStr) return null;

    const dismissals: WelcomeBannerDismissal[] = JSON.parse(dismissalsStr);
    return dismissals.find((d) => d.userId === userId) || null;
  } catch (error) {
    console.error(
      'Error retrieving welcome banner status from localStorage:',
      error,
    );
    return null;
  }
};

/**
 * Save the welcome banner dismissal for a user
 */
export const saveWelcomeBannerDismissal = (
  userId: string,
  action: 'dismissed' | 'viewed' = 'dismissed',
): void => {
  if (typeof window === 'undefined') return;

  try {
    const dismissalsStr = localStorage.getItem(WELCOME_BANNER_KEY);
    const dismissals: WelcomeBannerDismissal[] = dismissalsStr
      ? JSON.parse(dismissalsStr)
      : [];

    // Remove existing entry for this user if exists
    const filteredDismissals = dismissals.filter((d) => d.userId !== userId);

    // Add new dismissal
    filteredDismissals.push({
      userId,
      dismissedAt: Date.now(),
      action,
    });

    localStorage.setItem(
      WELCOME_BANNER_KEY,
      JSON.stringify(filteredDismissals),
    );
  } catch (error) {
    console.error(
      'Error saving welcome banner dismissal to localStorage:',
      error,
    );
  }
};

/**
 * Check if the user has dismissed or viewed the welcome banner
 */
export const hasUserDismissedWelcomeBanner = (userId: string): boolean => {
  const status = getWelcomeBannerStatus(userId);
  return status !== null;
};
