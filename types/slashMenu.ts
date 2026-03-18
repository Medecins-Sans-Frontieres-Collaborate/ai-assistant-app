import { CommandDefinition } from './commands';
import { Prompt } from './prompt';
import { Tone } from './tone';

export enum SlashMenuItemType {
  COMMAND = 'command',
  PROMPT = 'prompt',
  TONE = 'tone',
}

export type SlashMenuItem =
  | { type: SlashMenuItemType.COMMAND; command: CommandDefinition }
  | { type: SlashMenuItemType.PROMPT; prompt: Prompt }
  | { type: SlashMenuItemType.TONE; tone: Tone };
