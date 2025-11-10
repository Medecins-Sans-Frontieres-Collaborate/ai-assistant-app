import { OpenAIModel } from './openai';

export interface Tone {
  id: string;
  name: string;
  description: string;
  voiceRules: string; // Main content - writing style guidelines
  examples?: string; // Optional usage examples to demonstrate the tone
  tags?: string[]; // For searching/filtering
  createdAt: string;
  updatedAt?: string;
  folderId: string | null;
  model?: OpenAIModel; // Optional: preferred model for this tone

  // Team template metadata (optional)
  templateId?: string; // Unique ID of the template this was imported from
  templateName?: string; // Human-readable name of the template
  importedAt?: string; // ISO timestamp when imported from template
}

export interface ToneExport {
  version: number;
  tones: Tone[];
  exportedAt: string;
}
