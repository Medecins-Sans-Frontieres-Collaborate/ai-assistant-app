import { Tool } from './Tool';

/**
 * ToolRegistry
 *
 * Central registry for all available tools.
 * Provides lookup and management of tools.
 */
export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  /**
   * Registers a tool.
   */
  registerTool(tool: Tool): void {
    this.tools.set(tool.type, tool);
    console.log(`[ToolRegistry] Registered tool: ${tool.name} (${tool.type})`);
  }

  /**
   * Gets a tool by type.
   */
  getTool(type: string): Tool | undefined {
    return this.tools.get(type);
  }

  /**
   * Gets all registered tools.
   */
  getAllTools(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Checks if a tool is registered.
   */
  hasTool(type: string): boolean {
    return this.tools.has(type);
  }
}
