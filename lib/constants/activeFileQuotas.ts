/** Files above this token count cannot be pinned (pinned = always included every turn) */
export const ACTIVE_FILE_PIN_TOKEN_LIMIT = 40_000;

/** Files above this token count are rejected from becoming active files entirely */
export const ACTIVE_FILE_ACTIVATION_TOKEN_LIMIT = 75_000;

/** Cumulative token budget per conversation session for active file injection */
export const ACTIVE_FILE_SESSION_QUOTA = 200_000;
