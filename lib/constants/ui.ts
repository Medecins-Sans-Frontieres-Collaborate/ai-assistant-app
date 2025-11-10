/**
 * UI Constants
 * Centralized configuration for UI-related magic numbers and values
 */

export const UI_CONSTANTS = {
  /**
   * Responsive breakpoints (in pixels)
   */
  BREAKPOINTS: {
    MOBILE: 640,
    TABLET: 768,
    DESKTOP: 1024,
    WIDE: 1280,
  },

  /**
   * Textarea and input configurations
   */
  TEXTAREA: {
    /** Height threshold to detect multiline content */
    MULTILINE_THRESHOLD: 60,
    /** Maximum height before scrolling kicks in */
    MAX_HEIGHT: 400,
    /** Default minimum rows */
    MIN_ROWS: 1,
    /** Maximum character limit */
    DEFAULT_MAX_LENGTH: 10000,
  },

  /**
   * Scroll behavior thresholds
   */
  SCROLL: {
    /** Distance from bottom to trigger auto-scroll */
    AUTO_SCROLL_THRESHOLD: 200,
    /** Threshold to show "scroll to bottom" button */
    BOTTOM_THRESHOLD: 100,
    /** Smooth scroll duration in ms */
    SCROLL_DURATION: 300,
  },

  /**
   * Streaming animation settings
   */
  STREAMING: {
    /** Characters rendered per chunk */
    CHARS_PER_CHUNK: 5,
    /** Delay between chunks in milliseconds */
    DELAY_MS: 20,
    /** Typing animation speed */
    TYPING_SPEED_MS: 30,
  },

  /**
   * Animation durations (in milliseconds)
   */
  ANIMATION: {
    FAST: 150,
    NORMAL: 300,
    SLOW: 500,
    MODAL_FADE: 200,
  },

  /**
   * Z-index layers for proper stacking
   */
  Z_INDEX: {
    BASE: 1,
    DROPDOWN: 10,
    STICKY: 100,
    OVERLAY: 1000,
    MODAL: 1100,
    POPOVER: 1200,
    TOAST: 1300,
    TOOLTIP: 1400,
  },

  /**
   * Toast notification settings
   */
  TOAST: {
    DEFAULT_DURATION: 5000,
    ERROR_DURATION: 7000,
    SUCCESS_DURATION: 3000,
  },

  /**
   * Debounce and throttle timings
   */
  TIMING: {
    DEBOUNCE_DEFAULT: 300,
    DEBOUNCE_SEARCH: 500,
    THROTTLE_SCROLL: 100,
    THROTTLE_RESIZE: 150,
  },

  /**
   * File upload constraints
   */
  FILE_UPLOAD: {
    MAX_FILE_SIZE_MB: 10,
    MAX_FILE_SIZE_BYTES: 10 * 1024 * 1024,
    MAX_FILES_AT_ONCE: 10,
    CHUNK_SIZE_BYTES: 1024 * 1024, // 1MB chunks
  },

  /**
   * Image constraints
   */
  IMAGE: {
    MAX_WIDTH: 2048,
    MAX_HEIGHT: 2048,
    THUMBNAIL_SIZE: 150,
    QUALITY: 0.9,
  },

  /**
   * Cookie settings
   */
  COOKIE: {
    DEFAULT_EXPIRY_DAYS: 365,
    SESSION_EXPIRY_DAYS: 30,
  },
} as const;

/**
 * Type helper to ensure type safety when accessing UI constants
 */
export type UIConstants = typeof UI_CONSTANTS;
