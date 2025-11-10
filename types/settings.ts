import { SearchMode } from './searchMode';

export interface Settings {
  theme: 'light' | 'dark';
  temperature: number;
  systemPrompt: string;
  advancedMode: boolean;
  defaultSearchMode: SearchMode;
}
