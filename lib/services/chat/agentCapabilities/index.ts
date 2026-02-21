/**
 * Agent Capability Handlers
 *
 * This module provides isolated handlers for different Azure AI Foundry
 * agent capabilities. Each handler processes the agent event stream
 * specific to its capability.
 *
 * Pattern: Each capability has its own handler implementing AgentCapabilityHandler.
 * The main AIFoundryAgentHandler selects the appropriate handler based on
 * the enabled capabilities.
 *
 * Available capabilities:
 * - BingGroundingHandler: Default handler for web search/citation support
 * - CodeInterpreterHandler: Python code execution with file handling
 *
 * Future capabilities (add new handlers here):
 * - FileSearchHandler: Vector store file search
 * - FunctionCallingHandler: Custom function invocation
 */

export type {
  AgentCapabilityHandler,
  AgentStreamContext,
} from './AgentCapabilityHandler';

export { BaseCapabilityHandler } from './BaseCapabilityHandler';
export type { BaseStreamState } from './BaseCapabilityHandler';

export { BingGroundingHandler } from './BingGroundingHandler';

export { CodeInterpreterHandler } from './CodeInterpreterHandler';
