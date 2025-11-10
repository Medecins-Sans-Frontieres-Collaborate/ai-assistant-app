export interface FolderInterface {
  id: string;
  name: string;
  type: FolderType;

  // Team template metadata (optional)
  templateId?: string; // Unique ID of the template this was imported from
  templateName?: string; // Human-readable name of the template
  importedAt?: string; // ISO timestamp when imported from template
}

export type FolderType = 'chat' | 'prompt' | 'tone';
