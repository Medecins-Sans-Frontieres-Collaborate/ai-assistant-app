### TTS Configuration & Data

This document covers the configuration types, default settings, and the voice catalog management.

### Types (`types/tts.ts`)

The system uses several TypeScript interfaces to manage TTS state:

- `TTSSettings`: The main interface for user preferences.
  - `globalVoice`: The fallback voice name.
  - `languageVoices`: A record mapping base language codes (e.g., 'en') to voice names.
  - `rate`: Speech rate (0.5 to 2.0).
  - `pitch`: Pitch adjustment (-50 to +50).
  - `outputFormat`: The audio quality/bitrate setting.
- `VoiceInfo`: Metadata for an Azure voice.
  - `name`: Technical name (e.g., `en-US-AriaNeural`).
  - `displayName`: Friendly name for UI.
  - `gender`: Female, Male, or Neutral.
  - `type`: Neural, Multilingual, etc.

### Voice Catalog (`lib/data/ttsVoices.ts`)

The application maintains a local catalog of available Azure voices. This avoids expensive API calls to list voices and allows for custom UI organization.

#### Key Catalog Elements:

- `TTS_VOICES`: A record indexed by locale (e.g., `en-US`) containing arrays of `VoiceInfo`.
- `TTS_BASE_LANGUAGES`: A list of base languages used for the settings dropdown.
- `MULTILINGUAL_VOICES`: A filtered list of voices capable of speaking multiple languages fluently.

#### Helper Functions:

- `getTTSLocaleForAppLocale(appLocale)`: Maps application UI language to the best matching TTS locale.
- `resolveVoiceForLanguage(detectedLanguage, settings)`: Implements the hierarchical resolution logic described in the architecture documentation.
- `isMultilingualVoice(voiceName)`: Checks if a specific voice has the 'Multilingual' trait.

### Default Settings

The application defines `DEFAULT_TTS_SETTINGS` in `types/tts.ts`:

- **Global Voice**: `en-US-AvaMultilingualNeural`
- **Rate**: 1.0
- **Pitch**: 0
- **Format**: `Audio24Khz48KBitRateMonoMp3`

### Constraints

Values for rate and pitch are constrained by `TTS_CONSTRAINTS`:

- **Rate**: Min 0.5, Max 2.0, Step 0.1
- **Pitch**: Min -50, Max 50, Step 5

### Environment Variables

The backend authenticates as the application identity (Entra ID); account keys are not used.

- `AZURE_SPEECH_ENDPOINT`: (Optional) The Speech account's custom-domain endpoint (`https://<name>.cognitiveservices.azure.com`). Defaults to `AZURE_OPENAI_ENDPOINT`. Regional endpoints are rejected because they do not accept Entra tokens.
- The application identity needs the **Cognitive Services Speech User** role on that account.
