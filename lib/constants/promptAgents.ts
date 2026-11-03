/**
 * Native prompt-agent authoring limit, shared by the editor and write API.
 * Measured in UTF-16 code units, matching HTML maxLength and Zod string limits.
 * Stored records remain readable without a cap; model context limits still apply.
 */
export const PROMPT_AGENT_MAX_PROMPT_CHARS = 100_000;
