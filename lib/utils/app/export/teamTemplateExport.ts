import { TeamTemplateExport } from '@/types/export';
import { FolderInterface } from '@/types/folder';
import { Prompt } from '@/types/prompt';
import { Tone } from '@/types/tone';

import { CustomAgent } from '@/client/stores/settingsStore';

export interface TeamTemplateExportOptions {
  name: string;
  description?: string;
  includePrompts?: boolean;
  includeTones?: boolean;
  includeFolders?: boolean;
  includeCustomAgents?: boolean;
  selectedPromptIds?: string[];
  selectedToneIds?: string[];
  selectedFolderIds?: string[];
  selectedCustomAgentIds?: string[];
}

/**
 * Exports team template to a downloadable JSON file
 */
export const exportTeamTemplate = (
  options: TeamTemplateExportOptions,
  allPrompts: Prompt[],
  allTones: Tone[],
  allFolders: FolderInterface[],
  allCustomAgents: CustomAgent[],
): void => {
  // Filter items based on selection
  let prompts: Prompt[] = [];
  let tones: Tone[] = [];
  let folders: FolderInterface[] = [];
  let customAgents: CustomAgent[] = [];

  if (options.includePrompts) {
    prompts = options.selectedPromptIds
      ? allPrompts.filter((p) => options.selectedPromptIds!.includes(p.id))
      : allPrompts;
  }

  if (options.includeTones) {
    tones = options.selectedToneIds
      ? allTones.filter((t) => options.selectedToneIds!.includes(t.id))
      : allTones;
  }

  if (options.includeFolders) {
    // Only include prompt and tone folders, not chat folders
    const relevantFolders = allFolders.filter(
      (f) => f.type === 'prompt' || f.type === 'tone',
    );
    folders = options.selectedFolderIds
      ? relevantFolders.filter((f) => options.selectedFolderIds!.includes(f.id))
      : relevantFolders;
  }

  if (options.includeCustomAgents) {
    customAgents = options.selectedCustomAgentIds
      ? allCustomAgents.filter((a) =>
          options.selectedCustomAgentIds!.includes(a.id),
        )
      : allCustomAgents;
  }

  // Auto-include tones that are referenced by prompts
  const referencedToneIds = new Set(
    prompts.filter((p) => p.toneId).map((p) => p.toneId!),
  );
  const additionalTones = allTones.filter(
    (t) =>
      referencedToneIds.has(t.id) && !tones.find((tone) => tone.id === t.id),
  );
  tones = [...tones, ...additionalTones];

  // Auto-include folders that are referenced by prompts or tones
  const referencedFolderIds = new Set([
    ...prompts.filter((p) => p.folderId).map((p) => p.folderId!),
    ...tones.filter((t) => t.folderId).map((t) => t.folderId!),
  ]);
  const additionalFolders = allFolders.filter(
    (f) =>
      referencedFolderIds.has(f.id) &&
      !folders.find((folder) => folder.id === f.id),
  );
  folders = [...folders, ...additionalFolders];

  const exportData: TeamTemplateExport = {
    version: 1,
    name: options.name,
    description: options.description,
    prompts,
    tones,
    folders,
    customAgents: customAgents.length > 0 ? customAgents : undefined,
    exportedAt: new Date().toISOString(),
  };

  const blob = new Blob([JSON.stringify(exportData, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const timestamp = new Date().toISOString().split('T')[0];
  const fileName = `team_template_${options.name.toLowerCase().replace(/\s+/g, '_')}_${timestamp}.json`;
  link.download = fileName;
  link.href = url;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

/**
 * Validates imported team template data
 */
export const validateTeamTemplateImport = (data: any): string | null => {
  if (!data || typeof data !== 'object') {
    return 'Invalid file format';
  }

  if (data.version !== 1) {
    return 'Unsupported version';
  }

  if (!data.name || typeof data.name !== 'string') {
    return 'Missing or invalid template name';
  }

  if (!Array.isArray(data.prompts)) {
    return 'Invalid prompts data';
  }

  if (!Array.isArray(data.tones)) {
    return 'Invalid tones data';
  }

  if (!Array.isArray(data.folders)) {
    return 'Invalid folders data';
  }

  // Validate prompts
  for (const prompt of data.prompts) {
    if (!prompt.id || !prompt.name || !prompt.content) {
      return 'Prompts missing required fields (id, name, content)';
    }
  }

  // Validate tones
  for (const tone of data.tones) {
    if (!tone.id || !tone.name || !tone.voiceRules) {
      return 'Tones missing required fields (id, name, voiceRules)';
    }
  }

  // Validate folders
  for (const folder of data.folders) {
    if (!folder.id || !folder.name || !folder.type) {
      return 'Folders missing required fields (id, name, type)';
    }
  }

  return null;
};

export interface TeamTemplateImportResult {
  prompts: Prompt[];
  tones: Tone[];
  folders: FolderInterface[];
  customAgents: CustomAgent[];
  conflicts: {
    prompts: Array<{ existing: Prompt; imported: Prompt }>;
    tones: Array<{ existing: Tone; imported: Tone }>;
    folders: Array<{ existing: FolderInterface; imported: FolderInterface }>;
  };
}

/**
 * Imports team template and detects conflicts
 */
export const importTeamTemplate = (
  data: TeamTemplateExport,
  existingPrompts: Prompt[],
  existingTones: Tone[],
  existingFolders: FolderInterface[],
  existingCustomAgents: CustomAgent[],
): TeamTemplateImportResult => {
  const conflicts = {
    prompts: [] as Array<{ existing: Prompt; imported: Prompt }>,
    tones: [] as Array<{ existing: Tone; imported: Tone }>,
    folders: [] as Array<{
      existing: FolderInterface;
      imported: FolderInterface;
    }>,
  };

  // Generate unique template ID for this import
  const templateId = `template-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  const templateName = data.name;
  const importedAt = new Date().toISOString();

  // Process prompts
  const promptsToImport: Prompt[] = [];
  data.prompts.forEach((importedPrompt) => {
    const existingPrompt = existingPrompts.find(
      (p) => p.name.toLowerCase() === importedPrompt.name.toLowerCase(),
    );

    if (existingPrompt) {
      conflicts.prompts.push({
        existing: existingPrompt,
        imported: importedPrompt,
      });
    }

    // Regenerate ID to avoid conflicts and attach template metadata
    const newPrompt: Prompt = {
      ...importedPrompt,
      id: `prompt-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      templateId,
      templateName,
      importedAt,
    };

    promptsToImport.push(newPrompt);
  });

  // Process tones
  const tonesToImport: Tone[] = [];
  data.tones.forEach((importedTone) => {
    const existingTone = existingTones.find(
      (t) => t.name.toLowerCase() === importedTone.name.toLowerCase(),
    );

    if (existingTone) {
      conflicts.tones.push({ existing: existingTone, imported: importedTone });
    }

    // Regenerate ID to avoid conflicts and attach template metadata
    const newTone: Tone = {
      ...importedTone,
      id: `tone-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      templateId,
      templateName,
      importedAt,
    };

    tonesToImport.push(newTone);
  });

  // Process folders
  const foldersToImport: FolderInterface[] = [];
  data.folders.forEach((importedFolder) => {
    const existingFolder = existingFolders.find(
      (f) =>
        f.name.toLowerCase() === importedFolder.name.toLowerCase() &&
        f.type === importedFolder.type,
    );

    if (existingFolder) {
      conflicts.folders.push({
        existing: existingFolder,
        imported: importedFolder,
      });
    }

    // Regenerate ID to avoid conflicts and attach template metadata
    const newFolder: FolderInterface = {
      ...importedFolder,
      id: `folder-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      templateId,
      templateName,
      importedAt,
    };

    foldersToImport.push(newFolder);
  });

  // Process custom agents
  const customAgentsToImport: CustomAgent[] = [];
  if (data.customAgents) {
    data.customAgents.forEach((importedAgent) => {
      // Regenerate ID to avoid conflicts and attach template metadata
      const newAgent: CustomAgent = {
        ...importedAgent,
        id: `agent-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        templateId,
        templateName,
        importedAt,
      };

      customAgentsToImport.push(newAgent);
    });
  }

  return {
    prompts: promptsToImport,
    tones: tonesToImport,
    folders: foldersToImport,
    customAgents: customAgentsToImport,
    conflicts,
  };
};

/**
 * Handles file selection and parsing
 */
export const handleTeamTemplateFileImport = (
  file: File,
): Promise<TeamTemplateExport> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        const data = JSON.parse(text);

        const validationError = validateTeamTemplateImport(data);
        if (validationError) {
          reject(new Error(validationError));
          return;
        }

        resolve(data as TeamTemplateExport);
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

/**
 * Interface for imported template summary
 */
export interface ImportedTemplate {
  templateId: string;
  templateName: string;
  importedAt: string;
  itemCount: {
    prompts: number;
    tones: number;
    folders: number;
    customAgents: number;
    total: number;
  };
}

/**
 * Gets all unique imported templates from the data
 */
export const getImportedTemplates = (
  prompts: Prompt[],
  tones: Tone[],
  folders: FolderInterface[],
  customAgents: CustomAgent[],
): ImportedTemplate[] => {
  const templateMap = new Map<string, ImportedTemplate>();

  // Collect all unique templateIds
  [...prompts, ...tones, ...folders, ...customAgents].forEach((item) => {
    if (item.templateId && item.templateName && item.importedAt) {
      if (!templateMap.has(item.templateId)) {
        templateMap.set(item.templateId, {
          templateId: item.templateId,
          templateName: item.templateName,
          importedAt: item.importedAt,
          itemCount: {
            prompts: 0,
            tones: 0,
            folders: 0,
            customAgents: 0,
            total: 0,
          },
        });
      }
    }
  });

  // Count items for each template
  prompts.forEach((prompt) => {
    if (prompt.templateId && templateMap.has(prompt.templateId)) {
      const template = templateMap.get(prompt.templateId)!;
      template.itemCount.prompts++;
      template.itemCount.total++;
    }
  });

  tones.forEach((tone) => {
    if (tone.templateId && templateMap.has(tone.templateId)) {
      const template = templateMap.get(tone.templateId)!;
      template.itemCount.tones++;
      template.itemCount.total++;
    }
  });

  folders.forEach((folder) => {
    if (folder.templateId && templateMap.has(folder.templateId)) {
      const template = templateMap.get(folder.templateId)!;
      template.itemCount.folders++;
      template.itemCount.total++;
    }
  });

  customAgents.forEach((agent) => {
    if (agent.templateId && templateMap.has(agent.templateId)) {
      const template = templateMap.get(agent.templateId)!;
      template.itemCount.customAgents++;
      template.itemCount.total++;
    }
  });

  // Sort by import date (newest first)
  return Array.from(templateMap.values()).sort(
    (a, b) =>
      new Date(b.importedAt).getTime() - new Date(a.importedAt).getTime(),
  );
};

/**
 * Gets IDs of all items that belong to a specific template
 */
export const getTemplateItemIds = (
  templateId: string,
  prompts: Prompt[],
  tones: Tone[],
  folders: FolderInterface[],
  customAgents: CustomAgent[],
): {
  promptIds: string[];
  toneIds: string[];
  folderIds: string[];
  customAgentIds: string[];
} => {
  return {
    promptIds: prompts
      .filter((p) => p.templateId === templateId)
      .map((p) => p.id),
    toneIds: tones.filter((t) => t.templateId === templateId).map((t) => t.id),
    folderIds: folders
      .filter((f) => f.templateId === templateId)
      .map((f) => f.id),
    customAgentIds: customAgents
      .filter((a) => a.templateId === templateId)
      .map((a) => a.id),
  };
};
