import {
  TRANSCRIPTION_LANGUAGES,
  getOfficialTranscriptionLanguages,
  getTranscriptionLanguageMetadata,
  getUnofficialTranscriptionLanguages,
} from '@/lib/constants/transcriptionLanguages';
import english from '@/messages/en.json';
import { describe, expect, it } from 'vitest';

// Pinned v20230314/tokenizer.py. Deliberately not the evolving main branch.
const originalCodes =
  'en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt haw ln ha ba jw su'.split(
    ' ',
  );

describe('transcription language registry', () => {
  it('contains exactly the original 99 codes plus one auto-detect option', () => {
    const codes = TRANSCRIPTION_LANGUAGES.map((language) => language.code);
    expect(codes[0]).toBe('');
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.filter(Boolean).sort()).toEqual(originalCodes.sort());
  });

  it('has an English label and native name for every real language', () => {
    for (const language of TRANSCRIPTION_LANGUAGES) {
      const key = language.labelKey.split('.').at(-1)!;
      expect(english.transcription.languages).toHaveProperty(key);
      if (language.code) expect(language.autonym.length).toBeGreaterThan(0);
    }
  });

  it('separates official options from experimental options', () => {
    expect(
      getOfficialTranscriptionLanguages().every((l) => l.officiallySupported),
    ).toBe(true);
    expect(
      getUnofficialTranscriptionLanguages().every(
        (l) => !l.officiallySupported,
      ),
    ).toBe(true);
    for (const language of ['ht', 'so', 'my', 'haw', 'jw']) {
      expect(getTranscriptionLanguageMetadata(language)).toEqual({
        language,
        officiallySupported: false,
      });
    }
    expect(getTranscriptionLanguageMetadata('en')).toEqual({
      language: 'en',
      officiallySupported: true,
    });
  });

  it('does not claim official support for auto-detection or unknown codes', () => {
    expect(getTranscriptionLanguageMetadata()).toBeUndefined();
    expect(getTranscriptionLanguageMetadata('')).toBeUndefined();
    expect(getTranscriptionLanguageMetadata('xx')?.officiallySupported).toBe(
      false,
    );
  });
});
