import { OpenAIModel } from './openai';

export interface Prompt {
  id: string;
  name: string;
  description: string;
  content: string;
  model: OpenAIModel;
  folderId: string | null;
  toneId?: string | null; // Optional tone to apply with this prompt
  tags?: string[]; // For searching/filtering

  // Team template metadata (optional)
  templateId?: string; // Unique ID of the template this was imported from
  templateName?: string; // Human-readable name of the template
  importedAt?: string; // ISO timestamp when imported from template
}
