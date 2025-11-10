// Command types for PromptList component
// This is a minimal type definition file for command support in PromptList

export enum CommandType {
  AGENT = 'AGENT',
  SETTINGS = 'SETTINGS',
  UTILITY = 'UTILITY',
}

export interface CommandDefinition {
  command: string;
  type: CommandType;
  description: string;
  usage: string;
  examples: string[];
}
