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
