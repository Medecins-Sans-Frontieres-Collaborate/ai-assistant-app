/** Files above this token count cannot be pinned (pinned = always included every turn) */
export const ACTIVE_FILE_PIN_TOKEN_LIMIT = 40_000;

/** Files above this token count are rejected from becoming active files entirely */
export const ACTIVE_FILE_ACTIVATION_TOKEN_LIMIT = 75_000;

/** Cumulative token budget per conversation session for active file injection */
export const ACTIVE_FILE_SESSION_QUOTA = 200_000;

/** Floor for the per-turn active-file injection budget (legacy default). */
export const ACTIVE_FILE_PER_TURN_MIN = 2_000;

/** Ceiling for the per-turn budget. Matches the per-file pin limit so a single
 * turn never admits more content than a pinned file can carry. */
export const ACTIVE_FILE_PER_TURN_MAX = 40_000;

/** Fraction of the model's remaining input budget (after reserving output)
 * to spend on active-file injection each turn. The remaining 75% leaves
 * headroom for the system prompt, conversation history, and the user's
 * current message. */
export const ACTIVE_FILE_PER_TURN_FRACTION = 0.25;
