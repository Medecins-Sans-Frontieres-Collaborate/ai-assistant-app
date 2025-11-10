import { Prompt } from '@/types/prompt';

export interface PromptExport {
  version: 1;
  prompts: Prompt[];
  exportedAt: string;
}

/**
 * Exports prompts to a downloadable JSON file
 */
export const exportPrompts = (prompts: Prompt[]): void => {
  const exportData: PromptExport = {
    version: 1,
    prompts,
    exportedAt: new Date().toISOString(),
  };

  const blob = new Blob([JSON.stringify(exportData, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const timestamp = new Date().toISOString().split('T')[0];
  link.download = `prompts_${timestamp}.json`;
  link.href = url;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

/**
 * Validates imported prompt data
 */
export const validatePromptImport = (data: any): string | null => {
  if (!data || typeof data !== 'object') {
    return 'Invalid file format';
  }

  if (data.version !== 1) {
    return 'Unsupported version';
  }

  if (!Array.isArray(data.prompts)) {
    return 'Invalid prompts data';
  }

  // Validate each prompt has required fields
  for (const prompt of data.prompts) {
    if (!prompt.id || !prompt.name || !prompt.content) {
      return 'Prompts missing required fields (id, name, content)';
    }
  }

  return null;
};

/**
 * Imports prompts and detects conflicts
 */
export const importPrompts = (
  data: PromptExport,
  existingPrompts: Prompt[],
): {
  prompts: Prompt[];
  conflicts: Array<{ existing: Prompt; imported: Prompt }>;
} => {
  const conflicts: Array<{ existing: Prompt; imported: Prompt }> = [];
  const promptsToImport: Prompt[] = [];

  data.prompts.forEach((importedPrompt) => {
    // Check for conflicts by name (case-insensitive)
    const existingPrompt = existingPrompts.find(
      (p) => p.name.toLowerCase() === importedPrompt.name.toLowerCase(),
    );

    if (existingPrompt) {
      conflicts.push({ existing: existingPrompt, imported: importedPrompt });
    }

    // Regenerate ID to avoid conflicts
    const newPrompt: Prompt = {
      ...importedPrompt,
      id: `prompt-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    };

    promptsToImport.push(newPrompt);
  });

  return { prompts: promptsToImport, conflicts };
};

/**
 * Handles file selection and parsing
 */
export const handlePromptFileImport = (file: File): Promise<PromptExport> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        const data = JSON.parse(text);

        const validationError = validatePromptImport(data);
        if (validationError) {
          reject(new Error(validationError));
          return;
        }

        resolve(data as PromptExport);
      } catch (error) {
        reject(new Error('Failed to parse JSON file'));
      }
    };

    reader.onerror = () => {
      reject(new Error('Failed to read file'));
    };

    reader.readAsText(file);
  });
};
