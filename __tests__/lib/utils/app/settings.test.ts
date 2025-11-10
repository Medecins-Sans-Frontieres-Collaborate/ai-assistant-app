import { getSettings, saveSettings } from '@/lib/utils/app/settings';

import { SearchMode } from '@/types/searchMode';
import { Settings } from '@/types/settings';

import { Mock, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Settings Manager', () => {
  const dummySettings: Settings = {
    theme: 'dark',
    temperature: 0.5,
    systemPrompt: '',
    advancedMode: false,
    defaultSearchMode: SearchMode.OFF,
  };

  beforeEach(() => {
    (global as any).localStorage = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      clear: vi.fn(),
    } as any;
  });

  it('getSettings should return the settings from localStorage if exists', () => {
    const localStorageContent = JSON.stringify(dummySettings);
    (global as any).localStorage.getItem.mockReturnValue(localStorageContent);

    const settings = getSettings();
    expect(settings).toMatchObject(dummySettings);
    expect(global.localStorage.getItem).toHaveBeenCalledWith('settings');
  });

  it('getSettings should return default settings if nothing in localStorage', () => {
    (global as any).localStorage.getItem.mockReturnValue(null);

    const settings = getSettings();
    expect(settings).toMatchObject({ theme: 'light' });
    expect((global as any).localStorage.getItem).toHaveBeenCalledWith(
      'settings',
    );
  });

  it('saveSettings should save settings to localStorage', () => {
    saveSettings(dummySettings);

    expect((global as any).localStorage.setItem).toHaveBeenCalledWith(
      'settings',
      JSON.stringify(dummySettings),
    );
  });

  it('getSettings should catch if JSON parsing fails', () => {
    (global as any).localStorage.getItem.mockReturnValue('Not a JSON string');

    const oldCLogger = console.error;
    console.error = vi.fn();

    const settings = getSettings();
    expect(console.error).toHaveBeenCalled();
    (console.error as Mock).mockRestore();

    expect(settings).toMatchObject({ theme: 'light' });
    expect((global as any).localStorage.getItem).toHaveBeenCalledWith(
      'settings',
    );

    console.error = oldCLogger;
  });
});
