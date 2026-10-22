import {
  AZURE_SPEECH_LOCALES,
  TRANSCRIPTION_LANGUAGES,
  getAzureSpeechLocales,
  getOfficialTranscriptionLanguages,
  getTranscriptionLanguageMetadata,
  getUnofficialTranscriptionLanguages,
  toAzureWhisperLanguageRequest,
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

  // Azure rejects experimental hints with HTTP 400 unsupported_language
  // (acceptance probe 2026-10-15), so the Azure-boundary mapping converts
  // them to the disclosed auto-detect fallback.
  describe('toAzureWhisperLanguageRequest', () => {
    it('passes official hints through unchanged', () => {
      for (const { code } of getOfficialTranscriptionLanguages()) {
        if (!code) continue;
        expect(toAzureWhisperLanguageRequest(code)).toEqual({
          language: code,
          autoDetectFallback: false,
        });
      }
    });

    it('converts every experimental hint to auto-detect with an autonym cue', () => {
      for (const { code, autonym } of getUnofficialTranscriptionLanguages()) {
        expect(toAzureWhisperLanguageRequest(code)).toEqual({
          autoDetectFallback: true,
          autonymCue: autonym,
        });
      }
    });

    it('leaves auto-detect and unknown codes alone', () => {
      expect(toAzureWhisperLanguageRequest()).toEqual({
        autoDetectFallback: false,
      });
      expect(toAzureWhisperLanguageRequest('')).toEqual({
        autoDetectFallback: false,
      });
      // Unknown codes (e.g. regional variants) keep their existing behavior.
      expect(toAzureWhisperLanguageRequest('pt-br')).toEqual({
        language: 'pt-br',
        autoDetectFallback: false,
      });
    });
  });

  // Azure AI Speech fast transcription is a user-selectable alternative
  // engine with its own natively supported locales.
  describe('Azure Speech locale mapping', () => {
    it('maps only registry codes, each to BCP-47 locales', () => {
      const registryCodes = new Set(
        TRANSCRIPTION_LANGUAGES.map((l) => l.code).filter(Boolean),
      );
      for (const [code, locales] of Object.entries(AZURE_SPEECH_LOCALES)) {
        expect(registryCodes.has(code)).toBe(true);
        expect(locales.length).toBeGreaterThan(0);
        for (const locale of locales) {
          expect(locale).toMatch(/^[a-z]{2,3}-[A-Z]{2}$/);
        }
      }
    });

    it('covers the experimental languages Azure Speech supports natively', () => {
      // The MSF-relevant languages that motivated engine choice.
      for (const [code, locale] of [
        ['so', 'so-SO'],
        ['am', 'am-ET'],
        ['ps', 'ps-AF'],
        ['km', 'km-KH'],
        ['my', 'my-MM'],
        ['si', 'si-LK'],
      ]) {
        expect(getAzureSpeechLocales(code)).toContain(locale);
      }
      // No coverage: stays Whisper-only.
      for (const code of ['ht', 'ha', 'haw', 'mg', 'la', 'yo']) {
        expect(getAzureSpeechLocales(code)).toEqual([]);
      }
      expect(getAzureSpeechLocales()).toEqual([]);
      expect(getAzureSpeechLocales('')).toEqual([]);
    });

    it('computes engine-aware metadata without changing the whisper shape', () => {
      expect(getTranscriptionLanguageMetadata('so', 'azureSpeech')).toEqual({
        language: 'so',
        officiallySupported: true,
        engine: 'azureSpeech',
      });
      expect(getTranscriptionLanguageMetadata('ht', 'azureSpeech')).toEqual({
        language: 'ht',
        officiallySupported: false,
        engine: 'azureSpeech',
      });
      // Whisper metadata keeps the legacy shape (no engine field).
      expect(getTranscriptionLanguageMetadata('so', 'whisper')).toEqual({
        language: 'so',
        officiallySupported: false,
      });
    });
  });
});
