import { normalizeForSearch } from '@/lib/utils/app/localeSearch';

import { FolderInterface } from '@/types/folder';
import { Prompt } from '@/types/prompt';

/**
 * Interface representing a prompt match result
 */
export interface PromptMatch {
  /** Whether a prompt pattern was found */
  matched: boolean;
  /** The search term extracted from the pattern (without the /) */
  searchTerm: string;
}

/**
 * Longest search typed after "/" before it is read as ordinary text. Prompt
 * names have no limit, so this is generous: the list shows only while a
 * name matches anyway (usePromptSelection).
 */
export const MAX_PROMPT_QUERY_CHARS = 120;

/**
 * THE PROMPT TRIGGER: a "/" at the start of the message or after a space,
 * then the search, up to the end of the text. The search may hold spaces,
 * hyphens and accented letters (prompt names do), but not a line break or
 * another "/", and does not start with a space. So "/Weekly status" finds
 * "Weekly status", while "and/or", a URL, a path and "/ " open nothing.
 */
const PROMPT_TRIGGER = new RegExp(
  `(?:^|\\s)\\/(?!\\s)([^\\n/]{0,${MAX_PROMPT_QUERY_CHARS}})$`,
  'u',
);

/**
 * Finds THE PROMPT TRIGGER at the end of the text.
 *
 * @param text - The message being typed
 * @returns PromptMatch object with match status and search term
 *
 * @example
 * findPromptMatch('Hello /email')
 * // Returns: { matched: true, searchTerm: 'email' }
 *
 * @example
 * findPromptMatch('this and/')
 * // Returns: { matched: false, searchTerm: '' }
 */
export const findPromptMatch = (text: string): PromptMatch => {
  const match = PROMPT_TRIGGER.exec(text);
  return match
    ? { matched: true, searchTerm: match[1] }
    : { matched: false, searchTerm: '' };
};

/**
 * Updates prompt list visibility based on text input
 * Determines if the prompt list should be shown and what to filter by
 *
 * @param text - The current text input value
 * @returns Object with showList flag and inputValue for filtering
 *
 * @example
 * updatePromptListVisibility('Write /email')
 * // Returns: { showList: true, inputValue: 'email' }
 */
export const updatePromptListVisibility = (
  text: string,
): { showList: boolean; inputValue: string } => {
  const matchResult = findPromptMatch(text);

  return {
    showList: matchResult.matched,
    inputValue: matchResult.searchTerm,
  };
};

/**
 * Puts `replacement` where THE PROMPT TRIGGER is ("/" and its search),
 * keeping everything typed before it.
 *
 * @param text - The message being typed.
 * @param replacement - The prompt's text.
 * @returns The message with the trigger replaced; unchanged without one.
 *
 * @example
 * replacePromptTrigger('Notes: /exec', 'Summarise:')
 * // 'Notes: Summarise:'
 */
export const replacePromptTrigger = (
  text: string,
  replacement: string,
): string => {
  const match = PROMPT_TRIGGER.exec(text);
  if (!match) return text;
  const slash = match.index + match[0].indexOf('/');
  return text.slice(0, slash) + replacement;
};

/**
 * Whether a prompt's name holds the search, ignoring case and accents.
 *
 * @param prompt - A saved prompt.
 * @param query - What was typed after "/"; empty matches every prompt.
 */
export const promptMatchesQuery = (prompt: Prompt, query: string): boolean =>
  normalizeForSearch(prompt.name).includes(normalizeForSearch(query));

/** One section of the prompt list: a folder's prompts, or those in none. */
export interface PromptGroup {
  /** The folder; null for prompts not in a (known) folder. */
  folder: FolderInterface | null;
  prompts: Prompt[];
}

/**
 * The prompt list's sections, in the order they are shown: each prompt
 * folder (in folder order) that holds a prompt, then the prompts in no
 * folder. A prompt whose folder no longer exists is listed with the
 * latter rather than lost. `ordered` is every prompt in that same order:
 * the list's positions, which keyboard selection counts in.
 *
 * @param prompts - Prompts to show, already filtered.
 * @param folders - All folders; only prompt folders are used.
 */
export const groupPromptsForList = (
  prompts: Prompt[],
  folders: FolderInterface[] = [],
): { groups: PromptGroup[]; ordered: Prompt[] } => {
  const promptFolders = folders.filter((folder) => folder.type === 'prompt');
  const known = new Set(promptFolders.map((folder) => folder.id));
  const groups: PromptGroup[] = promptFolders
    .map((folder) => ({
      folder,
      prompts: prompts.filter((prompt) => prompt.folderId === folder.id),
    }))
    .filter((group) => group.prompts.length > 0);
  const loose = prompts.filter(
    (prompt) => !prompt.folderId || !known.has(prompt.folderId),
  );
  if (loose.length > 0) groups.push({ folder: null, prompts: loose });
  return { groups, ordered: groups.flatMap((group) => group.prompts) };
};
