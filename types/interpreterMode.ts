/**
 * Code Interpreter Mode Configuration
 *
 * Controls how sandboxed code execution is integrated into chat. Mirrors
 * SearchMode's OFF / INTELLIGENT / ALWAYS semantics; there is no AGENT
 * variant — interpretation always round-trips through the Foundry
 * Responses API as a sub-tool, regardless of the picked model.
 */
export enum InterpreterMode {
  /**
   * No code execution
   */
  OFF = 'off',

  /**
   * AI intelligently decides when code execution helps (default)
   * - ToolRouter analyzes the message
   * - Only runs code for data analysis / math / chart tasks
   * - Only the task (and attached files) is sent to the interpreter model
   */
  INTELLIGENT = 'intelligent',

  /**
   * Force code execution on every message (user "Run code" toggle)
   * - Always executes the request through the interpreter first
   * - Good for data-analysis sessions
   */
  ALWAYS = 'always',
}

/**
 * Type guard for InterpreterMode
 */
export function isInterpreterMode(value: unknown): value is InterpreterMode {
  return Object.values(InterpreterMode).includes(value as InterpreterMode);
}
