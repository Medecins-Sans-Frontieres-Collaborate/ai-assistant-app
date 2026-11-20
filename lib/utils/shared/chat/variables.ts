/**
 * Regular expression to match variables in the format {{variableName}} or {{variableName:defaultValue}}
 */
const VARIABLE_REGEX = /{{(.*?)}}/g;

/**
 * Interface for variable definitions with optional default values
 */
export interface VariableDefinition {
  name: string;
  defaultValue?: string;
  isOptional: boolean;
}

/**
 * Parses a variable string to extract name and default value
 * Supports syntax: {{variableName}} or {{variableName:defaultValue}}
 *
 * @param variableString - The variable content (without {{ }})
 * @returns Variable definition object
 *
 * @example
 * parseVariableDefinition('name')
 * // Returns: { name: 'name', defaultValue: undefined, isOptional: false }
 *
 * parseVariableDefinition('language:English')
 * // Returns: { name: 'language', defaultValue: 'English', isOptional: true }
 */
export const parseVariableDefinition = (
  variableString: string,
): VariableDefinition => {
  const colonIndex = variableString.indexOf(':');

  if (colonIndex === -1) {
    // No default value - required variable
    return {
      name: variableString.trim(),
      defaultValue: undefined,
      isOptional: false,
    };
  }

  // Has default value - optional variable
  const name = variableString.substring(0, colonIndex).trim();
  const defaultValue = variableString.substring(colonIndex + 1).trim();

  return {
    name,
    defaultValue,
    isOptional: true,
  };
};

/**
 * Parses variables from a string in the format {{variableName}} or {{variableName:default}}
 * Shared utility used by ChatInput and PromptDashboard
 *
 * @param content - The content string to parse
 * @returns Array of unique variable names found in the content
 *
 * @example
 * parseVariables('Hello {{name}}, welcome to {{place:Home}}!')
 * // Returns: ['name', 'place']
 */
export const parseVariables = (content: string): string[] => {
  const foundVariables: string[] = [];
  let match: RegExpExecArray | null;

  // Create a new regex instance for each parse to reset lastIndex
  const regex = new RegExp(VARIABLE_REGEX.source, VARIABLE_REGEX.flags);

  while ((match = regex.exec(content)) !== null) {
    const varDef = parseVariableDefinition(match[1]);
    foundVariables.push(varDef.name);
  }

  return foundVariables;
};

/**
 * Extracts variable definitions from content (includes default values and optional status)
 *
 * @param content - The content string to parse
 * @returns Array of unique variable definitions
 *
 * @example
 * getVariableDefinitions('Hello {{name}}, language is {{lang:English}}!')
 * // Returns: [
 * //   { name: 'name', defaultValue: undefined, isOptional: false },
 * //   { name: 'lang', defaultValue: 'English', isOptional: true }
 * // ]
 */
export const getVariableDefinitions = (
  content: string,
): VariableDefinition[] => {
  const definitionsMap = new Map<string, VariableDefinition>();
  let match: RegExpExecArray | null;

  const regex = new RegExp(VARIABLE_REGEX.source, VARIABLE_REGEX.flags);

  while ((match = regex.exec(content)) !== null) {
    const varDef = parseVariableDefinition(match[1]);

    // Only add if not already present (avoid duplicates)
    if (!definitionsMap.has(varDef.name)) {
      definitionsMap.set(varDef.name, varDef);
    }
  }

  return Array.from(definitionsMap.values());
};

/**
 * Extracts unique variables from text (deduplicates)
 * Used by PromptDashboard to show variable list
 *
 * @param text - The text to extract variables from
 * @returns Array of unique variable names
 *
 * @example
 * extractVariables('{{name}} and {{age}}, {{name}} again')
 * // Returns: ['name', 'age']
 */
export const extractVariables = (text: string): string[] => {
  const regex = new RegExp(VARIABLE_REGEX.source, VARIABLE_REGEX.flags);
  const matches = text.matchAll(regex);
  const vars = Array.from(matches, (m) => m[1]).filter(
    (v, i, arr) => arr.indexOf(v) === i, // Remove duplicates
  );
  return vars;
};

/**
 * Replaces variables in content with provided values
 * Supports default values: {{variableName:defaultValue}}
 *
 * @param content - The content containing variables
 * @param variables - Array of variable names
 * @param values - Array of values to replace variables with (same order as variables)
 * @returns Content with variables replaced (uses defaults for empty values)
 *
 * @example
 * replaceVariables('Hello {{name}}!', ['name'], ['World'])
 * // Returns: 'Hello World!'
 *
 * @example
 * replaceVariables('Hello {{name:Guest}}!', ['name'], [''])
 * // Returns: 'Hello Guest!'
 */
export const replaceVariables = (
  content: string,
  variables: string[],
  values: string[],
): string => {
  return content.replace(VARIABLE_REGEX, (match, variableString) => {
    const varDef = parseVariableDefinition(variableString);
    const index = variables.indexOf(varDef.name);

    if (index !== -1) {
      const value = values[index];
      // If value is empty and there's a default, use default
      if (!value && varDef.defaultValue) {
        return varDef.defaultValue;
      }
      // If value exists, use it
      if (value) {
        return value;
      }
    }

    // If no value provided and there's a default, use default
    if (varDef.defaultValue) {
      return varDef.defaultValue;
    }

    // Otherwise keep original (for required variables)
    return match;
  });
};

/**
 * Replaces variables using a variable map (key-value pairs)
 * Supports default values: {{variableName:defaultValue}}
 *
 * @param content - The content containing variables
 * @param variableMap - Object mapping variable names to their values
 * @returns Content with variables replaced (uses defaults for empty/missing values)
 *
 * @example
 * replaceVariablesWithMap('Hello {{name}}!', { name: 'World' })
 * // Returns: 'Hello World!'
 *
 * @example
 * replaceVariablesWithMap('Hello {{name:Guest}}!', {})
 * // Returns: 'Hello Guest!'
 *
 * @example
 * replaceVariablesWithMap('Language: {{lang:English}}', { lang: '' })
 * // Returns: 'Language: English'
 */
export const replaceVariablesWithMap = (
  content: string,
  variableMap: { [key: string]: string },
): string => {
  return content.replace(VARIABLE_REGEX, (match, variableString) => {
    const varDef = parseVariableDefinition(variableString);
    const value = variableMap[varDef.name];

    // If value exists and is not empty, use it
    if (value) {
      return value;
    }

    // If value is empty or missing and there's a default, use default
    if (varDef.defaultValue) {
      return varDef.defaultValue;
    }

    // Otherwise keep original (for required variables without values)
    return match;
  });
};

/**
 * A variable name as a person would write it: `example_values`,
 * `exampleValues` and `example-values` all read "Example values".
 *
 * @param name - The variable's name, as written between the braces.
 * @returns The name in words, first letter capitalised; the name itself
 *   when it has no letters to split (e.g. `x1`).
 */
export const humanizeVariableName = (name: string): string => {
  const words = name
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .toLowerCase();
  if (!words) return name;
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** One piece of a prompt: plain text, or a variable and what fills it. */
export type PromptSegment =
  | { kind: 'text'; text: string }
  | {
      kind: 'variable';
      name: string;
      /** What the message will hold here: the value, else the default. */
      text: string;
      /** The value is empty and the default stands in. */
      usesDefault: boolean;
      /** The value is empty and there is no default: it must be filled. */
      missing: boolean;
    };

/**
 * A prompt cut into text and variables, with each variable filled from
 * `values` (or its default), so a preview can show what will be sent and
 * mark what is still missing. Joining every segment's `text` gives the same
 * message replaceVariablesWithMap makes, except that a missing variable's
 * text is empty.
 *
 * @param content - The prompt, with {{name}} or {{name:default}} variables.
 * @param values - Variable name to the value typed for it.
 */
export const promptSegments = (
  content: string,
  values: Record<string, string>,
): PromptSegment[] => {
  const segments: PromptSegment[] = [];
  const regex = new RegExp(VARIABLE_REGEX.source, VARIABLE_REGEX.flags);
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    if (match.index > last) {
      segments.push({ kind: 'text', text: content.slice(last, match.index) });
    }
    const definition = parseVariableDefinition(match[1]);
    const value = values[definition.name] ?? '';
    const usesDefault = !value && !!definition.defaultValue;
    segments.push({
      kind: 'variable',
      name: definition.name,
      text: value || definition.defaultValue || '',
      usesDefault,
      missing: !value && !definition.defaultValue,
    });
    last = match.index + match[0].length;
  }
  if (last < content.length) {
    segments.push({ kind: 'text', text: content.slice(last) });
  }
  return segments;
};

/** Longest stretch of text kept either side of a variable in its context. */
const CONTEXT_SIDE_CHARS = 60;

/** Ends a sentence: a stop followed by a space or the end, or a line break. */
const SENTENCE_END = /[.!?](?=\s|$)|\n/g;

/** Total length of the segments' text. */
const segmentsLength = (segments: PromptSegment[]): number =>
  segments.reduce((sum, segment) => sum + segment.text.length, 0);

/**
 * Where a variable sits in its prompt: the sentence (or line) around its
 * first use, as segments (see promptSegments). Either side longer than
 * CONTEXT_SIDE_CHARS is shortened at a word, with an ellipsis. This is
 * what tells a person what a variable is for.
 *
 * @param content - The prompt.
 * @param name - The variable.
 * @param values - What is typed so far, for the other variables in reach.
 * @returns The segments around the variable, or an empty list when the
 *   prompt does not use it.
 * @example
 * variableContext('Hi. Write to {{who}}. Be brief.', 'who', {})
 * // text 'Write to ', variable who, text '.'
 */
export const variableContext = (
  content: string,
  name: string,
  values: Record<string, string>,
): PromptSegment[] => {
  const segments = promptSegments(content, values);
  const at = segments.findIndex(
    (segment) => segment.kind === 'variable' && segment.name === name,
  );
  if (at === -1) return [];

  // Back to the start of the sentence.
  const before: PromptSegment[] = [];
  for (let i = at - 1; i >= 0; i -= 1) {
    const segment = segments[i];
    if (segment.kind === 'variable') {
      before.unshift(segment);
      continue;
    }
    const ends = [...segment.text.matchAll(SENTENCE_END)];
    const last = ends[ends.length - 1];
    if (!last) {
      before.unshift(segment);
      continue;
    }
    before.unshift({
      kind: 'text',
      text: segment.text.slice(last.index + last[0].length),
    });
    break;
  }
  // On to the end of the sentence, its stop included.
  const after: PromptSegment[] = [];
  for (let i = at + 1; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment.kind === 'variable') {
      after.push(segment);
      continue;
    }
    const end = new RegExp(SENTENCE_END.source).exec(segment.text);
    if (!end) {
      after.push(segment);
      continue;
    }
    const stop = end[0] === '\n' ? end.index : end.index + 1;
    after.push({ kind: 'text', text: segment.text.slice(0, stop) });
    break;
  }

  return [...shortenStart(before), segments[at], ...shortenEnd(after)];
};

/**
 * The text before a variable, no longer than CONTEXT_SIDE_CHARS: cut from
 * its start at a word, marked with an ellipsis, leading space removed.
 */
function shortenStart(before: PromptSegment[]): PromptSegment[] {
  const pieces = [...before];
  while (pieces.length > 0 && segmentsLength(pieces) > CONTEXT_SIDE_CHARS) {
    const first = pieces[0];
    const excess = segmentsLength(pieces) - CONTEXT_SIDE_CHARS;
    if (first.kind === 'variable' || first.text.length <= excess) {
      pieces.shift();
      continue;
    }
    const space = first.text.indexOf(' ', excess);
    const cut = space === -1 ? first.text.length : space + 1;
    pieces[0] = { kind: 'text', text: `…${first.text.slice(cut)}` };
    break;
  }
  const first = pieces[0];
  if (first?.kind === 'text') {
    pieces[0] = { kind: 'text', text: first.text.trimStart() };
  }
  return pieces;
}

/**
 * The text after a variable, no longer than CONTEXT_SIDE_CHARS: cut at a
 * word, marked with an ellipsis, trailing space removed.
 */
function shortenEnd(after: PromptSegment[]): PromptSegment[] {
  const pieces = [...after];
  while (pieces.length > 0 && segmentsLength(pieces) > CONTEXT_SIDE_CHARS) {
    const last = pieces[pieces.length - 1];
    const excess = segmentsLength(pieces) - CONTEXT_SIDE_CHARS;
    if (last.kind === 'variable' || last.text.length <= excess) {
      pieces.pop();
      continue;
    }
    const keep = last.text.length - excess;
    const space = last.text.lastIndexOf(' ', keep);
    const cut = space <= 0 ? keep : space;
    pieces[pieces.length - 1] = {
      kind: 'text',
      text: `${last.text.slice(0, cut).trimEnd()}…`,
    };
    break;
  }
  const last = pieces[pieces.length - 1];
  if (last?.kind === 'text') {
    pieces[pieces.length - 1] = { kind: 'text', text: last.text.trimEnd() };
  }
  return pieces;
}
