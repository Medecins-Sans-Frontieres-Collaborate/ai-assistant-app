import { CommandDefinition } from './commands';
import { Prompt } from './prompt';
import { Tone } from './tone';

export enum SlashMenuItemType {
  COMMAND = 'command',
  PROMPT = 'prompt',
  TONE = 'tone',
}

/** Items that appear in the intermixed slash menu list (excludes commands, which render separately) */
export type SlashMenuItem =
  | { type: SlashMenuItemType.PROMPT; prompt: Prompt }
  | { type: SlashMenuItemType.TONE; tone: Tone };

/** Full union including commands (used for flattened index calculation) */
export type SlashMenuEntry =
  | { type: SlashMenuItemType.COMMAND; command: CommandDefinition }
  | SlashMenuItem;
