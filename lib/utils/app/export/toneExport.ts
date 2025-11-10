import { Tone, ToneExport } from '@/types/tone';

/**
 * Exports tones to a downloadable JSON file
 */
export const exportTones = (tones: Tone[]): void => {
  const exportData: ToneExport = {
    version: 1,
    tones,
    exportedAt: new Date().toISOString(),
  };

  const blob = new Blob([JSON.stringify(exportData, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const timestamp = new Date().toISOString().split('T')[0];
  link.download = `tones_${timestamp}.json`;
  link.href = url;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

/**
 * Validates imported tone data
 */
export const validateToneImport = (data: any): string | null => {
  if (!data || typeof data !== 'object') {
    return 'Invalid file format';
  }

  if (data.version !== 1) {
    return 'Unsupported version';
  }

  if (!Array.isArray(data.tones)) {
    return 'Invalid tones data';
  }

  // Validate each tone has required fields
  for (const tone of data.tones) {
    if (!tone.id || !tone.name || !tone.voiceRules) {
      return 'Tones missing required fields (id, name, voiceRules)';
    }
  }

  return null;
};

/**
 * Imports tones and detects conflicts
 */
export const importTones = (
  data: ToneExport,
  existingTones: Tone[],
): {
  tones: Tone[];
  conflicts: Array<{ existing: Tone; imported: Tone }>;
} => {
  const conflicts: Array<{ existing: Tone; imported: Tone }> = [];
  const tonesToImport: Tone[] = [];

  data.tones.forEach((importedTone) => {
    // Check for conflicts by name (case-insensitive)
    const existingTone = existingTones.find(
      (t) => t.name.toLowerCase() === importedTone.name.toLowerCase(),
    );

    if (existingTone) {
      conflicts.push({ existing: existingTone, imported: importedTone });
    }

    // Regenerate ID to avoid conflicts
    const newTone: Tone = {
      ...importedTone,
      id: `tone-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    };

    tonesToImport.push(newTone);
  });

  return { tones: tonesToImport, conflicts };
};

/**
 * Handles file selection and parsing
 */
export const handleToneFileImport = (file: File): Promise<ToneExport> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        const data = JSON.parse(text);

        const validationError = validateToneImport(data);
        if (validationError) {
          reject(new Error(validationError));
          return;
        }

        resolve(data as ToneExport);
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
