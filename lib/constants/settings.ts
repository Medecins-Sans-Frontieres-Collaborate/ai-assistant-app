/**
 * Settings Constants
 * Configuration values related to user settings and preferences
 */

export const SETTINGS_CONSTANTS = {
  /**
   * Model ordering and usage tracking
   */
  MODEL_ORDER: {
    /**
     * Number of consecutive successful message responses required
     * before model usage stats are incremented.
     * Prevents jarring order changes during experimentation.
     */
    CONSECUTIVE_USAGE_THRESHOLD: 3,
  },

  /**
   * Chat-input "+" dropdown tool ordering
   */
  TOOL_ORDER: {
    /**
     * Number of consecutive uses of the same tool required before its durable
     * usage count is incremented. Keeps the "Frequently used" order stable.
     */
    CONSECUTIVE_USAGE_THRESHOLD: 3,
  },
} as const;

/**
 * Type helper for type safety
 */
export type SettingsConstants = typeof SETTINGS_CONSTANTS;
